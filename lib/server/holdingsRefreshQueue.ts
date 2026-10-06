/**
 * Debounced durable queue for trade-triggered per-wallet holdings refresh.
 * Same wallet×chain coalesces into one OKX pull after debounce.
 * EVM jobs cover ETH/BSC/Base/Robinhood in a single OKX request.
 */
import 'server-only';

import { randomUUID } from 'node:crypto';

import {
  refreshWalletHoldings,
  type RefreshWalletHoldingsParams,
  type RefreshWalletHoldingsResult,
} from '@/lib/server/holdingsRefreshRuntime';
import { pushBark } from '@/lib/server/barkNotify';
import { getDb, type DbHandle } from '@/lib/server/sqlite';

const DEFAULT_DEBOUNCE_MS = 10_000;
const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 1_000;
/** 死信阈值：连续失败 N 次后标 dead_letter，退出退避循环（2026-08-28 死信机制）。 */
const MAX_REFRESH_ATTEMPTS_BEFORE_DEAD_LETTER = 10;
const MAX_TRANSIENT_RETRIES = 1;
const DEFAULT_MIN_REFRESH_AGE_MS = 120_000;

/**
 * Per-wallet×chain minimum re-sync interval. Trade-triggered refreshes are
 * hard-capped at once per this window so a high-frequency wallet cannot turn
 * its trade burst into an unbounded stream of OKX/GMGN balance pulls.
 * Override with HOLDINGS_MIN_REFRESH_AGE_MS (0 disables the cap).
 */
function getMinRefreshAgeMs() {
  const configured = Number.parseInt(process.env.HOLDINGS_MIN_REFRESH_AGE_MS || '', 10);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  return DEFAULT_MIN_REFRESH_AGE_MS;
}

const DEFAULT_QUIET_INTERVAL_MS = 4 * 60 * 60_000;
/**
 * Quiet wallets (no on-chain activity within the active window) re-sync on
 * this slower cadence instead of HOLDINGS_REFRESH_INTERVAL_MS. Their balance
 * cannot have moved without a trade, so only price is stale — display re-pricing
 * covers that. Override with HOLDINGS_QUIET_INTERVAL_MS.
 */
function getQuietIntervalMs() {
  const configured = Number.parseInt(process.env.HOLDINGS_QUIET_INTERVAL_MS || '', 10);
  if (Number.isFinite(configured) && configured > 0) return Math.max(60_000, configured);
  return DEFAULT_QUIET_INTERVAL_MS;
}

export type EnqueueHoldingsRefreshInput = {
  address: string;
  chain: string;
  userId: string;
};

type QueueJob = EnqueueHoldingsRefreshInput & {
  key: string;
  timer: ReturnType<typeof setTimeout> | null;
};

export type HoldingsRefreshQueueDeps = {
  refreshWallet?: (params: RefreshWalletHoldingsParams) => Promise<RefreshWalletHoldingsResult>;
  debounceMs?: number;
  retryDelayMs?: number;
  maxConcurrent?: number;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  log?: (message: string) => void;
};

function getDebounceMs(envDebounce?: number) {
  if (typeof envDebounce === 'number' && Number.isFinite(envDebounce) && envDebounce >= 0) {
    return envDebounce;
  }
  const configured = Number.parseInt(process.env.HOLDINGS_TRADE_REFRESH_DEBOUNCE_MS || '', 10);
  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }
  return DEFAULT_DEBOUNCE_MS;
}

function normalizeQueueChain(chain: string) {
  const normalized = chain.trim().toLowerCase();
  if (normalized === 'sol') return 'solana';
  if (
    normalized === 'eth'
    || normalized === 'ethereum'
    || normalized === 'bsc'
    || normalized === 'base'
    || normalized === 'robinhood'
  ) {
    return 'evm';
  }
  return normalized;
}

function jobKey(address: string, chain: string) {
  return `${normalizeQueueChain(chain)}:${address.trim().toLowerCase()}`;
}

function isTransientRefreshFailure(result: RefreshWalletHoldingsResult) {
  return (
    result.status === 'error' &&
    /OKX 网络错误|fetch failed|ECONNRESET|ETIMEDOUT|请求超时/i.test(result.lastError || '')
  );
}

export function createHoldingsRefreshQueue(deps: HoldingsRefreshQueueDeps = {}) {
  const pending = new Map<string, QueueJob>();
  const inFlight = new Set<string>();
  let active = 0;
  const waitQueue: string[] = [];

  const refreshWallet = deps.refreshWallet ?? refreshWalletHoldings;
  const debounceMs = getDebounceMs(deps.debounceMs);
  const retryDelayMs =
    typeof deps.retryDelayMs === 'number' && Number.isFinite(deps.retryDelayMs) && deps.retryDelayMs >= 0
      ? deps.retryDelayMs
      : DEFAULT_TRANSIENT_RETRY_DELAY_MS;
  const maxConcurrent = Math.max(1, deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const log =
    deps.log ??
    ((message: string) => {
      console.log(`[holdings-refresh-queue] ${message}`);
    });

  async function runJob(key: string) {
    const job = pending.get(key);
    if (!job) return;
    pending.delete(key);
    if (job.timer) {
      clearTimer(job.timer);
      job.timer = null;
    }
    if (inFlight.has(key)) {
      // Already running; re-enqueue so a trailing trade still refreshes after.
      enqueue(job);
      return;
    }

    inFlight.add(key);
    active += 1;
    try {
      let result: RefreshWalletHoldingsResult | null = null;
      for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt += 1) {
        result = await refreshWallet({
          address: job.address,
          chain: job.chain,
          userId: job.userId,
          fetchTokenLiquidity: false,
        });
        if (!isTransientRefreshFailure(result) || attempt === MAX_TRANSIENT_RETRIES) break;
        if (retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
      if (!result) {
        throw new Error('holdings refresh produced no result');
      }
      if (result.status === 'idle') {
        log(
          `ok ${key} rows=${result.holdingsRowCount} total=${result.totalAssetUsd ?? '-'}`
        );
      } else {
        log(`fail ${key} status=${result.status} err=${result.lastError ?? '-'}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`error ${key}: ${message}`);
    } finally {
      inFlight.delete(key);
      active -= 1;
      pump();
    }
  }

  function pump() {
    while (active < maxConcurrent && waitQueue.length > 0) {
      const key = waitQueue.shift();
      if (!key) break;
      if (pending.has(key)) {
        void runJob(key);
      }
    }
  }

  function scheduleRun(key: string) {
    if (!waitQueue.includes(key)) {
      waitQueue.push(key);
    }
    pump();
  }

  function enqueue(input: EnqueueHoldingsRefreshInput) {
    const address = (input.address || '').trim();
    const chain = (input.chain || '').trim();
    const userId = (input.userId || '').trim();
    if (!address || !chain || !userId) {
      return { enqueued: false, key: null as string | null };
    }

    const key = jobKey(address, chain);
    const existing = pending.get(key);
    if (existing?.timer) {
      clearTimer(existing.timer);
    }

    const job: QueueJob = {
      key,
      address,
      chain,
      userId,
      timer: null,
    };

    job.timer = setTimer(() => {
      job.timer = null;
      scheduleRun(key);
    }, debounceMs);

    pending.set(key, job);
    return { enqueued: true, key };
  }

  function pendingCount() {
    return pending.size;
  }

  function resetForTests() {
    for (const job of pending.values()) {
      if (job.timer) clearTimer(job.timer);
    }
    pending.clear();
    waitQueue.length = 0;
    inFlight.clear();
    active = 0;
  }

  return {
    enqueue,
    pendingCount,
    resetForTests,
    /** Exposed for tests / runtime wiring. */
    debounceMs,
  };
}

const PERSISTENT_QUEUE_POLL_MS = 1_000;
const PERSISTENT_QUEUE_LEASE_MS = 5 * 60_000;
const HOLDINGS_JOB_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.HOLDINGS_JOB_TIMEOUT_MS || 30_000)
);
const ROSTER_SEED_INTERVAL_MS = 5 * 60_000;
const EVENT_PRIORITY = 100;
const SCHEDULE_PRIORITY = 0;
let lastRosterSeedAtMs = 0;
const initializedQueueDbs = new WeakSet<object>();

type PersistentQueueRow = {
  wallet_chain: string;
  address: string;
  chain: string;
  user_id: string;
  attempts: number;
};

function ensurePersistentQueue(db: DbHandle) {
  if (initializedQueueDbs.has(db as object)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS holdings_refresh_jobs (
      wallet_chain TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      chain TEXT NOT NULL,
      user_id TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      due_at_ms INTEGER NOT NULL,
      lease_token TEXT,
      lease_until_ms INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      rerun_requested INTEGER NOT NULL DEFAULT 0,
      last_success_at_ms INTEGER,
      last_error TEXT,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_holdings_refresh_jobs_due
      ON holdings_refresh_jobs(priority DESC, due_at_ms ASC);
  `);
  try {
    db.exec(`ALTER TABLE holdings_refresh_jobs ADD COLUMN rerun_requested INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Existing/current schema already has it.
  }
  try {
    // 死信状态（2026-08-28）：'active'（默认，可被认领）| 'dead_letter'（失败 N 次，
    // 不再被 claim；人工排查后 UPDATE status='active', attempts=0 重放）。
    db.exec(`ALTER TABLE holdings_refresh_jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  } catch {
    // Existing/current schema already has it.
  }
  for (const [alias, canonical] of [
    ['sol', 'solana'],
    ['eth', 'evm'],
    ['ethereum', 'evm'],
    ['bsc', 'evm'],
    ['base', 'evm'],
    ['robinhood', 'evm'],
  ] as const) {
    db.exec(`
      INSERT INTO holdings_refresh_jobs (
        wallet_chain, address, chain, user_id, priority, due_at_ms, lease_token,
        lease_until_ms, attempts, rerun_requested, last_success_at_ms, last_error, updated_at_ms
      )
      SELECT '${canonical}:' || substr(wallet_chain, instr(wallet_chain, ':') + 1),
             address, '${canonical}', user_id, priority, due_at_ms, NULL, NULL,
             attempts, rerun_requested, last_success_at_ms, last_error, updated_at_ms
      FROM holdings_refresh_jobs WHERE chain = '${alias}'
      ON CONFLICT(wallet_chain) DO UPDATE SET
        priority = MAX(holdings_refresh_jobs.priority, excluded.priority),
        due_at_ms = MIN(holdings_refresh_jobs.due_at_ms, excluded.due_at_ms),
        last_success_at_ms = MAX(holdings_refresh_jobs.last_success_at_ms, excluded.last_success_at_ms),
        updated_at_ms = MAX(holdings_refresh_jobs.updated_at_ms, excluded.updated_at_ms);
      DELETE FROM holdings_refresh_jobs WHERE chain = '${alias}';
    `);
  }
  initializedQueueDbs.add(db as object);
}

function upsertPersistentJob(
  db: DbHandle,
  input: EnqueueHoldingsRefreshInput,
  priority: number,
  dueAtMs: number,
  nowMs: number
) {
  const address = input.address.trim();
  const chain = normalizeQueueChain(input.chain);
  const userId = input.userId.trim();
  if (!address || !chain || !userId) return { enqueued: false, key: null as string | null };
  const key = jobKey(address, chain);
  ensurePersistentQueue(db);
  db.prepare(
    `INSERT INTO holdings_refresh_jobs (
       wallet_chain, address, chain, user_id, priority, due_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(wallet_chain) DO UPDATE SET
       address = excluded.address,
       user_id = excluded.user_id,
       priority = MAX(holdings_refresh_jobs.priority, excluded.priority),
       due_at_ms = CASE
         WHEN MAX(holdings_refresh_jobs.priority, excluded.priority) > 0
           THEN MIN(holdings_refresh_jobs.due_at_ms, excluded.due_at_ms)
         ELSE excluded.due_at_ms
       END,
       rerun_requested = CASE
         WHEN excluded.priority > 0 AND holdings_refresh_jobs.lease_until_ms > excluded.updated_at_ms
         THEN 1 ELSE holdings_refresh_jobs.rerun_requested END,
       updated_at_ms = excluded.updated_at_ms`
  ).run(key, address, chain, userId, priority, dueAtMs, nowMs);
  return { enqueued: true, key };
}

/** Durable verification enqueue: one EVM wallet job covers ETH/BSC/Base/Robinhood. */
export function enqueueHoldingsRefresh(
  input: EnqueueHoldingsRefreshInput,
  options: { delayMs?: number } = {},
) {
  const nowMs = Date.now();
  const requestedDelay = options.delayMs;
  const delayMs = typeof requestedDelay === 'number' && Number.isFinite(requestedDelay)
    ? Math.max(0, requestedDelay)
    : getDebounceMs();
  return upsertPersistentJob(getDb(), input, EVENT_PRIORITY, nowMs + delayMs, nowMs);
}

function seedPersistentQueue(db: DbHandle, nowMs: number) {
  ensurePersistentQueue(db);
  if (lastRosterSeedAtMs > 0 && lastRosterSeedAtMs <= nowMs && nowMs - lastRosterSeedAtMs < ROSTER_SEED_INTERVAL_MS) {
    return 0;
  }
  lastRosterSeedAtMs = nowMs;
  const refreshIntervalMs = getQuietIntervalMs();
  const rows = db.prepare(
    `SELECT ta.address, ta.address_lower, ta.chain, ta.user_id,
            MAX(CASE WHEN ws.status = 'success' THEN ws.refreshed_at END) AS last_success_at,
            NULL AS last_trade_at
     FROM tracked_addresses ta
     LEFT JOIN current_holdings_wallet_status ws
       ON ws.tracked_address_lower = ta.address_lower AND ws.chain = ta.chain
     WHERE COALESCE(ta.monitoring_enabled, 1) = 1
       AND ta.chain IN ('solana', 'ethereum', 'bsc', 'base')
     GROUP BY ta.address_lower, ta.chain`
  ).all() as Array<{
    address: string;
    address_lower: string;
    chain: string;
    user_id: string;
    last_success_at: number | null;
    last_trade_at: number | null;
  }>;

  // Native chains read the last on-chain trade from the canonical events table
  // (indexed lookup); robinhood carries MAX(event_time_ms) from the feed above.
  const grouped = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    const canonicalChain = normalizeQueueChain(row.chain);
    const key = `${canonicalChain}:${row.address_lower}`;
    const prior = grouped.get(key);
    if (!prior) {
      grouped.set(key, { ...row, chain: canonicalChain });
      continue;
    }
    const priorAt = prior.last_success_at == null ? null : Number(prior.last_success_at);
    const rowAt = row.last_success_at == null ? null : Number(row.last_success_at);
    prior.last_success_at = priorAt == null || rowAt == null ? null : Math.min(priorAt, rowAt);
  }

  for (const row of grouped.values()) {
    const intervalMs = refreshIntervalMs;
    // Preserve real age in due_at so an old wallet cannot remain at a fixed
    // roster position behind newer wallets every cycle.
    const dueAtMs = row.last_success_at == null
      ? 0
      : Number(row.last_success_at) + intervalMs;
    upsertPersistentJob(db, {
      address: row.address,
      chain: row.chain,
      userId: row.user_id,
    }, SCHEDULE_PRIORITY, dueAtMs, nowMs);
  }
  return grouped.size;
}

type HoldingsRefreshProvider = 'native' | 'gmgn';

function claimPersistentJob(
  db: DbHandle,
  nowMs: number,
  provider?: HoldingsRefreshProvider
): (PersistentQueueRow & { leaseToken: string }) | null {
  ensurePersistentQueue(db);
  const leaseToken = randomUUID();
  const minAgeMs = getMinRefreshAgeMs();
  const providerClause = provider === 'gmgn'
    ? `AND 0`
    : '';
  const claim = db.transaction(() => {
    const row = db.prepare(
      `SELECT wallet_chain, address, chain, user_id, attempts
       FROM holdings_refresh_jobs
       WHERE due_at_ms <= ?
         AND (lease_until_ms IS NULL OR lease_until_ms <= ?)
         AND (last_success_at_ms IS NULL OR last_success_at_ms + ? <= ?)
         AND status = 'active'
         ${providerClause}
       ORDER BY priority DESC, COALESCE(last_success_at_ms, 0) ASC, due_at_ms ASC
       LIMIT 1`
    ).get(nowMs, nowMs, minAgeMs, nowMs) as PersistentQueueRow | undefined;
    if (!row) return null;
    const result = db.prepare(
      `UPDATE holdings_refresh_jobs
       SET lease_token = ?, lease_until_ms = ?, updated_at_ms = ?
       WHERE wallet_chain = ? AND (lease_until_ms IS NULL OR lease_until_ms <= ?)`
    ).run(leaseToken, nowMs + PERSISTENT_QUEUE_LEASE_MS, nowMs, row.wallet_chain, nowMs);
    return result.changes === 1 ? { ...row, leaseToken } : null;
  });
  return claim();
}

function queueStats(db: DbHandle, nowMs: number) {
  ensurePersistentQueue(db);
  return db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN due_at_ms <= ? THEN 1 ELSE 0 END) AS due,
            MIN(CASE WHEN due_at_ms <= ? THEN due_at_ms END) AS oldest_due_at
     FROM holdings_refresh_jobs`
  ).get(nowMs, nowMs) as { total: number; due: number | null; oldest_due_at: number | null };
}

/**
 * 死信告警聚合窗口。单钱包进死信不再各推一条 Bark——2026-10-06 事故里
 * 442 个钱包在 1 分钟内齐爆，产生 434 条同题推送（事故信息被淹没、手机刷屏）。
 * 改为：窗口内累计的进死信事件聚合成一条摘要，窗口到期时发出。
 */
const DEAD_LETTER_ALERT_WINDOW_MS = Math.max(
  10_000,
  Number(process.env.HOLDINGS_DEAD_LETTER_ALERT_WINDOW_MS || 300_000)
);
/** 摘要里最多列几个钱包样本，避免 body 超长被 Bark 截断。 */
const DEAD_LETTER_SAMPLE_LIMIT = 5;

type DeadLetterPending = { walletChain: string; address: string; attempts: number; error: string };
type DeadLetterAlertState = {
  wallets: DeadLetterPending[];
  firstAtMs: number;
  timer: ReturnType<typeof setTimeout> | null;
};
/** 每个 DB 一份待聚合状态（测试注入临时 DB，不能全局共享）。 */
const deadLetterAlertState = new WeakMap<object, DeadLetterAlertState>();

function getDeadLetterAlertState(db: DbHandle): DeadLetterAlertState {
  let state = deadLetterAlertState.get(db as object);
  if (!state) {
    state = { wallets: [], firstAtMs: 0, timer: null };
    deadLetterAlertState.set(db as object, state);
  }
  return state;
}

/** 聚合摘要正文：N 个钱包 + 少数样本 + 首错原因。 */
function formatDeadLetterDigest(wallets: DeadLetterPending[], windowMs: number): string {
  const byChain = new Map<string, number>();
  for (const w of wallets) {
    const chain = w.walletChain.split(':')[0] || 'unknown';
    byChain.set(chain, (byChain.get(chain) ?? 0) + 1);
  }
  const chainSummary = [...byChain.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([chain, n]) => `${chain} ${n}`)
    .join(' / ');
  const minutes = Math.max(1, Math.round(windowMs / 60_000));
  const samples = wallets
    .slice(0, DEAD_LETTER_SAMPLE_LIMIT)
    .map((w) => `${w.walletChain.split(':')[0]}:${w.address.slice(0, 6)}…`)
    .join(', ');
  const more = wallets.length > DEAD_LETTER_SAMPLE_LIMIT
    ? ` 等 ${wallets.length} 个`
    : '';
  const firstError = wallets[0]?.error?.slice(0, 100) ?? 'unknown';
  return (
    `${minutes} 分钟内 ${wallets.length} 个钱包进死信（${chainSummary}）。` +
    `样本：${samples}${more}。首错：${firstError}`
  );
}

/** 窗口到期：把累计的进死信事件作为一条摘要推送，然后清空。 */
function flushDeadLetterAlert(db: DbHandle): void {
  const state = getDeadLetterAlertState(db);
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const wallets = state.wallets;
  const windowMs = state.firstAtMs > 0 ? Date.now() - state.firstAtMs : DEAD_LETTER_ALERT_WINDOW_MS;
  state.wallets = [];
  state.firstAtMs = 0;
  if (wallets.length === 0) return;
  console.warn(
    `[holdings-refresh-queue] dead-letter digest: ${wallets.length} wallet(s) in ${Math.round(windowMs / 1000)}s`
  );
  void pushBark({
    title: `持仓刷新进死信 · ${wallets.length} 个钱包`,
    body: formatDeadLetterDigest(wallets, windowMs),
    group: '运维',
    // 死信是运维事故，不是背景噪音——聚合后单条推送，值得 ring through silent mode。
    level: 'timeSensitive',
  }).catch(() => {});
}

/**
 * 记录一次进死信事件。首次调用开启聚合窗口，窗口到期合并成一条 Bark。
 * 失败不阻塞队列。
 */
function notifyDeadLetter(
  db: DbHandle,
  walletChain: string,
  address: string,
  attempts: number,
  error: string
): void {
  try {
    const state = getDeadLetterAlertState(db);
    if (state.wallets.length === 0) state.firstAtMs = Date.now();
    state.wallets.push({ walletChain, address, attempts, error });
    if (!state.timer) {
      state.timer = setTimeout(() => {
        try {
          flushDeadLetterAlert(db);
        } catch {
          /* 摘要推送失败不影响队列 */
        }
      }, DEAD_LETTER_ALERT_WINDOW_MS);
      // 不阻止进程退出（worker 关闭时不必等告警窗口）。
      state.timer.unref?.();
    }
  } catch {
    /* 告警失败不影响死信 */
  }
}

/** 测试用：立即冲掉待发摘要并复位。 */
export function flushDeadLetterAlertsForTests(db: DbHandle): void {
  flushDeadLetterAlert(db);
}

/**
 * 队列健康快照，供看门狗（watchdog）判断「整条刷新链路是否已经死透」。
 *
 * 2026-10-06 事故：worker 长跑 19h，442/965 钱包（46%）冻结在 dead_letter，
 * 最近 1h 零成功刷新，但只有「每个钱包进死信」的噪音告警，没有任何东西
 * 指出「这条链路整体已经不可用了」。看门狗消费本快照做整体判定。
 */
export type HoldingsRefreshQueueHealth = {
  total: number;
  active: number;
  deadLetter: number;
  /** dead_letter / total；total=0 时为 0。 */
  deadLetterRatio: number;
  /** 最近一次成功刷新距今毫秒；从未成功则为 null。 */
  lastSuccessAgeMs: number | null;
  /** 最近 successWindowMs 内成功刷新的钱包数。 */
  recentlySucceeded: number;
};

export function readHoldingsRefreshQueueHealth(
  db: DbHandle,
  nowMs: number = Date.now(),
  successWindowMs: number = 60 * 60_000
): HoldingsRefreshQueueHealth {
  ensurePersistentQueue(db);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter,
              MAX(last_success_at_ms) AS last_success_at_ms,
              SUM(CASE WHEN last_success_at_ms >= ? THEN 1 ELSE 0 END) AS recently_succeeded
       FROM holdings_refresh_jobs`
    )
    .get(nowMs - successWindowMs) as {
    total: number;
    active: number | null;
    dead_letter: number | null;
    last_success_at_ms: number | null;
    recently_succeeded: number | null;
  };
  const total = row.total ?? 0;
  const deadLetter = row.dead_letter ?? 0;
  const lastSuccessAt = row.last_success_at_ms;
  return {
    total,
    active: row.active ?? 0,
    deadLetter,
    deadLetterRatio: total > 0 ? deadLetter / total : 0,
    lastSuccessAgeMs: lastSuccessAt == null ? null : Math.max(0, nowMs - lastSuccessAt),
    recentlySucceeded: row.recently_succeeded ?? 0,
  };
}

/**
 * 把死信钱包放回队列重试（看门狗自愈动作用）。
 * attempts 归零并用随机 due_at 摊开，避免所有钱包同一秒同时打上游
 * （2026-10-06 手工恢复时用的就是这招：442 条摊到 15 分钟窗口）。
 * 返回被重置的行数。
 */
export function requeueDeadLetterJobs(
  db: DbHandle,
  options: { nowMs?: number; spreadMs?: number } = {}
): number {
  ensurePersistentQueue(db);
  const nowMs = options.nowMs ?? Date.now();
  const spreadMs = Math.max(0, options.spreadMs ?? 15 * 60_000);
  const result = db
    .prepare(
      `UPDATE holdings_refresh_jobs
       SET status = 'active',
           attempts = 0,
           rerun_requested = 0,
           due_at_ms = ? + (ABS(RANDOM()) % MAX(1, ?)),
           last_error = NULL,
           updated_at_ms = ?
       WHERE status = 'dead_letter'`
    )
    .run(nowMs, spreadMs, nowMs);
  return Number(result.changes ?? 0);
}

/** One durable queue cycle. Periodic roster scans only seed jobs; they never block on a full sweep. */
export async function runHoldingsRefreshQueueCycle(options: {
  db?: DbHandle;
  now?: () => number;
  provider?: HoldingsRefreshProvider;
  refreshWallet?: (params: RefreshWalletHoldingsParams) => Promise<RefreshWalletHoldingsResult>;
  cooldownRemainingMs?: (nowMs: number) => number;
  /** Test seam retained for callers; doorbell backlog no longer blocks holdings. */
  pendingLiveDoorbells?: () => number;
  jobTimeoutMs?: number;
} = {}) {
  const db = options.db ?? getDb();
  const now = options.now ?? Date.now;
  const nowMs = now();
  const seeded = seedPersistentQueue(db, nowMs);
  let job: (PersistentQueueRow & { leaseToken: string }) | null;
  try {
    job = claimPersistentJob(db, nowMs, options.provider);
  } catch (error) {
    if (/database is locked|SQLITE_BUSY/i.test(error instanceof Error ? error.message : String(error))) {
      return {
        sleepMs: PERSISTENT_QUEUE_POLL_MS,
        status: 'idle' as const,
        summary: { seeded, processed: 0, queueTotal: 0, queueDue: 0 },
        lastError: 'sqlite busy while claiming holdings refresh job',
      };
    }
    throw error;
  }
  if (!job) {
    const stats = queueStats(db, nowMs);
    return {
      sleepMs: PERSISTENT_QUEUE_POLL_MS,
      status: 'idle' as const,
      summary: { seeded, processed: 0, queueTotal: stats.total, queueDue: stats.due ?? 0 },
      lastError: null,
    };
  }

  const refreshWallet = options.refreshWallet ?? refreshWalletHoldings;
  const jobTimeoutMs = Math.max(1, options.jobTimeoutMs ?? HOLDINGS_JOB_TIMEOUT_MS);
  let result: RefreshWalletHoldingsResult;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    result = await Promise.race([
      refreshWallet({
        address: job.address,
        chain: job.chain,
        userId: job.user_id,
        db,
        signal: AbortSignal.timeout(jobTimeoutMs),
        // 写入 liquidity_usd：否则 91% 行为 NULL，展示层 5k 流动性过滤只能
        // 依赖浏览器打 /api/token-logo/batch 补——点击后持仓要等 2-5s 且
        // DexScreener 解析不出的行永远不显示。DexScreener 是独立免费源，
        // 批量 ≤30 token/请求，与 GMGN 配额无关。
        fetchTokenLiquidity: true,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`holdings refresh timed out after ${jobTimeoutMs}ms`)),
          jobTimeoutMs,
        );
      }),
    ]);
  } catch (error) {
    result = {
      status: 'error',
      chain: null,
      holdingsRowCount: 0,
      filteredOutHoldingCount: 0,
      totalAssetUsd: null,
      lastError: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  const finishedAt = now();
  if (result.status === 'idle') {
    const intervalMs = getQuietIntervalMs();
    db.prepare(
      `UPDATE holdings_refresh_jobs
       SET priority = CASE WHEN rerun_requested = 1 THEN priority ELSE 0 END,
           due_at_ms = CASE WHEN rerun_requested = 1 THEN due_at_ms ELSE ? END,
           lease_token = NULL, lease_until_ms = NULL, attempts = 0,
           rerun_requested = 0, last_success_at_ms = ?, last_error = NULL, updated_at_ms = ?
       WHERE wallet_chain = ? AND lease_token = ?`
    ).run(finishedAt + intervalMs, finishedAt, finishedAt, job.wallet_chain, job.leaseToken);
  } else {
    const attempts = job.attempts + 1;
    // 死信 + 熔断（2026-08-28）：robinhood 卡死钱包（30s 超时 / gmgn-cli exit 75）
    // 无上限重试，指数退避封顶 30min 永久烧 attempts —— 实测 30 个 never_ok
    // 钱包在 24h 窗烧掉 1,117 次 attempts（47%），并占住 GMGN 车道吞吐与公平窗。
    // 连续失败达到阈值 → 标记 dead_letter（可审计、可人工重放），不再进入退避循环。
    if (attempts >= MAX_REFRESH_ATTEMPTS_BEFORE_DEAD_LETTER) {
      const msg = result.lastError ?? 'unknown refresh failure';
      db.prepare(
        `UPDATE holdings_refresh_jobs
         SET lease_token = NULL, lease_until_ms = NULL, attempts = ?,
             rerun_requested = 0, last_error = ?, updated_at_ms = ?,
             status = 'dead_letter'
         WHERE wallet_chain = ? AND lease_token = ?`
      ).run(attempts, `dead-letter: ${msg}`.slice(0, 2000), finishedAt, job.wallet_chain, job.leaseToken);
      console.log(
        `[holdings-refresh-queue] dead-letter ${job.wallet_chain} (${job.address}) after ${attempts} attempts: ${msg}`
      );
      try {
        notifyDeadLetter(db, job.wallet_chain, job.address, attempts, msg);
      } catch {
        /* 告警失败不影响死信 */
      }
    } else {
      const retryMs = Math.min(30 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 5));
      db.prepare(
        `UPDATE holdings_refresh_jobs
         SET due_at_ms = CASE WHEN rerun_requested = 1 THEN MIN(due_at_ms, ?) ELSE ? END,
             lease_token = NULL, lease_until_ms = NULL, attempts = ?, rerun_requested = 0,
             last_error = ?, updated_at_ms = ?
         WHERE wallet_chain = ? AND lease_token = ?`
      ).run(
        finishedAt + retryMs,
        finishedAt + retryMs,
        attempts,
        result.lastError,
        finishedAt,
        job.wallet_chain,
        job.leaseToken
      );
    }
  }
  const stats = queueStats(db, finishedAt);
  return {
    sleepMs: PERSISTENT_QUEUE_POLL_MS,
    status: result.status,
    summary: {
      seeded,
      processed: 1,
      walletChain: job.wallet_chain,
      holdingsRowCount: result.holdingsRowCount,
      provider: result.provider,
      requestedChainCount: result.requestedChainCount,
      upstreamRequestCount: result.upstreamRequestCount,
      queueTotal: stats.total,
      queueDue: stats.due ?? 0,
      oldestDueAt: stats.oldest_due_at,
    },
    lastError: result.lastError,
  };
}

/** Independent consumers keep GMGN latency/cooldown from occupying the native balance loop. */
export function runNativeHoldingsRefreshQueueCycle() {
  return runHoldingsRefreshQueueCycle({ provider: 'native' });
}

export function runGmgnHoldingsRefreshQueueCycle() {
  if (process.env.PILI_GMGN_RECOVERY_PAUSED === '1') {
    return Promise.resolve({
      sleepMs: 30_000,
      status: 'idle' as const,
      summary: { seeded: 0, processed: 0, queueTotal: 0, queueDue: 0 },
      lastError: 'paused for self-holdings recovery',
    });
  }
  return runHoldingsRefreshQueueCycle({ provider: 'gmgn' });
}

/** Compatibility export; production enqueue is durable rather than process-local. */
export const holdingsRefreshQueue = {
  enqueue: enqueueHoldingsRefresh,
  pendingCount: () => queueStats(getDb(), Date.now()).due ?? 0,
};
