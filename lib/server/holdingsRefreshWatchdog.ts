import 'server-only';

/**
 * 持仓刷新看门狗（2026-10-06 事故后新增）。
 *
 * 事故复盘：worker 从 04:00 起带着旧状态跑了 19 小时，OKX 出问题后
 * 442/965 个钱包（46%）陆续冻结在 dead_letter，最近 1 小时零成功刷新。
 * 但当时只有「每个钱包进死信」的告警（还是刷屏式的），**没有任何机制指出
 * 「整条刷新链路已经不可用了」**——事故是靠手机被刷屏才被人发现的。
 *
 * 本看门狗补上这个缺口：周期性读队列健康快照，当整体指标越过阈值时
 * ①自愈（把死信钱包放回队列重试）②推送一条**升级告警**。
 * 聚合后的死信摘要（见 holdingsRefreshQueue）负责「有单个钱包卡住」，
 * 本模块负责「这条链路整体挂了」——两者互补，不重复。
 *
 * 设计约束：
 * - 只做「放回队列」，不做重启进程。重启是 pm2 的事，且本进程重启自己
 *   没有意义（watchdog 自己就在这个进程里跑）。链路真死时重放能覆盖
 *   绝大多数情况（上游恢复后积压自然消化）。
 * - 自愈有冷却，避免上游长时间不可用时反复重放刷爆 attempts 与上游配额。
 * - 告警有冷却，且区分「首次恶化」与「持续未恢复」，不重复轰炸。
 */

import { pushBark } from '@/lib/server/barkNotify';
import {
  readHoldingsRefreshQueueHealth,
  requeueDeadLetterJobs,
  type HoldingsRefreshQueueHealth,
} from '@/lib/server/holdingsRefreshQueue';
import { getDb, type DbHandle } from '@/lib/server/sqlite';

/**
 * 判定「链路已死」的三个独立条件，任一成立即视为恶化。
 * 三个都要求样本量足够（total >= MIN_TOTAL）——新装/小库不该被误报。
 */
/** 队列规模下限：低于此值不判定，避免刚起步时少量钱包失败就告警。 */
const MIN_TOTAL_WALLETS = 20;
/** 死信占比阈值：2026-10-06 事故时是 46%。 */
const DEAD_LETTER_RATIO_THRESHOLD = 0.25;
/** 零成功时长阈值：这么久没有任何钱包刷新成功 = 链路不通。 */
const NO_SUCCESS_MS_THRESHOLD = 60 * 60_000;
/** 一批里至少这么多钱包进死信才认定是「批量」而非零星个例。 */
const BURST_DEAD_LETTER_MIN = 10;

export type HoldingsWatchdogVerdict = {
  degraded: boolean;
  /** 触发了哪几条判据（人类可读，进告警正文）。 */
  reasons: string[];
  health: HoldingsRefreshQueueHealth;
};

/** 纯函数判定，便于单测覆盖各种边界。 */
export function evaluateHoldingsRefreshHealth(
  health: HoldingsRefreshQueueHealth,
  options: { nowMs?: number; noSuccessMsThreshold?: number } = {}
): HoldingsWatchdogVerdict {
  const noSuccessMs = options.noSuccessMsThreshold ?? NO_SUCCESS_MS_THRESHOLD;
  const reasons: string[] = [];

  if (health.total >= MIN_TOTAL_WALLETS) {
    if (health.deadLetterRatio >= DEAD_LETTER_RATIO_THRESHOLD) {
      reasons.push(
        `死信占比 ${(health.deadLetterRatio * 100).toFixed(0)}%（${health.deadLetter}/${health.total}），阈值 ${(DEAD_LETTER_RATIO_THRESHOLD * 100).toFixed(0)}%`
      );
    }
    if (health.deadLetter >= BURST_DEAD_LETTER_MIN && health.recentlySucceeded === 0) {
      reasons.push(
        `批量死信 ${health.deadLetter} 个且最近 1h 零成功刷新`
      );
    }
    if (
      health.lastSuccessAgeMs == null ||
      health.lastSuccessAgeMs >= noSuccessMs
    ) {
      const ageText =
        health.lastSuccessAgeMs == null
          ? '从未成功'
          : `${Math.round(health.lastSuccessAgeMs / 60_000)} 分钟`;
      reasons.push(`最近一次成功刷新距今 ${ageText}，阈值 ${Math.round(noSuccessMs / 60_000)} 分钟`);
    }
  }

  return { degraded: reasons.length > 0, reasons, health };
}

/** 自愈冷却：默认 30min，避免上游长时间挂掉时反复重放。 */
const DEFAULT_REQUEUE_COOLDOWN_MS = Math.max(
  60_000,
  Number(process.env.HOLDINGS_WATCHDOG_REQUEUE_COOLDOWN_MS || 30 * 60_000)
);
/** 告警冷却：默认 60min，同一个未恢复的事故不重复轰炸。 */
const DEFAULT_ALERT_COOLDOWN_MS = Math.max(
  60_000,
  Number(process.env.HOLDINGS_WATCHDOG_ALERT_COOLDOWN_MS || 60 * 60_000)
);
/** 看门狗自身的检查间隔。 */
export const HOLDINGS_WATCHDOG_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.HOLDINGS_WATCHDOG_INTERVAL_MS || 5 * 60_000)
);

type WatchdogState = {
  lastRequeueAtMs: number | null;
  lastAlertAtMs: number | null;
  /** 上一轮是否处于恶化状态，用于识别「刚恶化」与「持续恶化」。 */
  wasDegraded: boolean;
  runCount: number;
};
const states = new WeakMap<object, WatchdogState>();

function getState(db: DbHandle): WatchdogState {
  let s = states.get(db as object);
  if (!s) {
    s = { lastRequeueAtMs: null, lastAlertAtMs: null, wasDegraded: false, runCount: 0 };
    states.set(db as object, s);
  }
  return s;
}

export type WatchdogRunResult = {
  degraded: boolean;
  reasons: string[];
  requeued: number;
  alerted: boolean;
  health: HoldingsRefreshQueueHealth;
};

/**
 * 跑一轮看门狗。永不抛 —— 看门狗自己挂掉比它要防的事故更糟。
 */
export async function runHoldingsRefreshWatchdog(options: {
  db?: DbHandle;
  now?: () => number;
  /** 测试注入：覆盖自愈动作。 */
  requeue?: (db: DbHandle, opts: { nowMs: number }) => number;
  /** 测试注入：覆盖告警推送。 */
  notify?: (payload: { title: string; body: string }) => void | Promise<void>;
  requeueCooldownMs?: number;
  alertCooldownMs?: number;
} = {}): Promise<WatchdogRunResult> {
  const db = options.db ?? getDb();
  const now = options.now ?? Date.now;
  const nowMs = now();
  const requeueCooldownMs = options.requeueCooldownMs ?? DEFAULT_REQUEUE_COOLDOWN_MS;
  const alertCooldownMs = options.alertCooldownMs ?? DEFAULT_ALERT_COOLDOWN_MS;
  const state = getState(db);
  state.runCount += 1;

  let health: HoldingsRefreshQueueHealth;
  try {
    health = readHoldingsRefreshQueueHealth(db, nowMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[holdings-watchdog] health read failed: ${message}`);
    return {
      degraded: false,
      reasons: [],
      requeued: 0,
      alerted: false,
      health: {
        total: 0,
        active: 0,
        deadLetter: 0,
        deadLetterRatio: 0,
        lastSuccessAgeMs: null,
        recentlySucceeded: 0,
      },
    };
  }

  const verdict = evaluateHoldingsRefreshHealth(health, { nowMs });
  if (!verdict.degraded) {
    state.wasDegraded = false;
    return { degraded: false, reasons: [], requeued: 0, alerted: false, health };
  }

  const justDegraded = !state.wasDegraded;
  state.wasDegraded = true;

  // ---- 自愈：把死信钱包放回队列（带冷却）----
  let requeued = 0;
  const requeueDue =
    state.lastRequeueAtMs == null || nowMs - state.lastRequeueAtMs >= requeueCooldownMs;
  // 只在「刚恶化」或冷却到期时重放；持续恶化且冷却未到就只观察。
  if (requeueDue) {
    try {
      const doRequeue = options.requeue
        ? (d: DbHandle, o: { nowMs: number }) => options.requeue!(d, o)
        : (d: DbHandle, o: { nowMs: number }) => requeueDeadLetterJobs(d, { nowMs: o.nowMs });
      requeued = doRequeue(db, { nowMs });
      state.lastRequeueAtMs = nowMs;
      if (requeued > 0) {
        console.warn(
          `[holdings-watchdog] requeued ${requeued} dead-letter wallet(s) — ${verdict.reasons.join('; ')}`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[holdings-watchdog] requeue failed: ${message}`);
    }
  }

  // ---- 升级告警（带冷却）----
  let alerted = false;
  const alertDue =
    state.lastAlertAtMs == null || nowMs - state.lastAlertAtMs >= alertCooldownMs;
  if (alertDue) {
    const headline = justDegraded ? '持仓刷新链路异常' : '持仓刷新链路仍未恢复';
    const bodyParts = [
      ...verdict.reasons,
      requeued > 0 ? `已自动重放 ${requeued} 个死信钱包` : '本轮未重放（冷却中）',
    ];
    try {
      const notify =
        options.notify ??
        ((payload: { title: string; body: string }) => {
          void pushBark({
            title: payload.title,
            body: payload.body,
            group: '运维',
            // 链路整体不可用 = 交易数据在骗人，值得穿过静音模式。
            level: 'timeSensitive',
          }).catch(() => {});
        });
      await notify({ title: `⚠️ ${headline}`, body: bodyParts.join('；') });
      state.lastAlertAtMs = nowMs;
      alerted = true;
      console.warn(`[holdings-watchdog] ALERT ${headline}: ${bodyParts.join('; ')}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[holdings-watchdog] alert failed: ${message}`);
    }
  }

  return { degraded: true, reasons: verdict.reasons, requeued, alerted, health };
}

/** 测试用：复位看门狗状态。 */
export function resetHoldingsRefreshWatchdogState(db: DbHandle): void {
  states.delete(db as object);
}
