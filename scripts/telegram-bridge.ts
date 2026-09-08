import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { ingestTelegramMonitorUpdate } from '@/lib/server/telegramMonitorIngest';
import {
  createTelegramBotApiClient,
  readTelegramBotApiProxyList,
} from '@/lib/server/telegramBotApi';
import { pushBark } from '@/lib/server/barkNotify';
import { queueCompletenessPoke } from '@/lib/server/completenessRepo';
import { ingestTwitterRelayPayload } from '@/lib/server/twitterRelayIngest';
import { runTwitterSyncAction } from '@/lib/server/twitterSyncService';
import {
  readTelegramIngestCursor,
  saveTelegramIngestCursor,
  touchWorkerHeartbeat,
} from '@/lib/server/workerStateRepo';
import { sleep } from '@/lib/timing';

import {
  WorkerLease,
  createWorkerStatusReporter,
  installShutdownHandlers,
  loadWorkerEnv,
} from './lib/workerLifecycle';
import {
  extractMessage,
  looksLikeTwitterRelayMessage,
  parseTwitterRelayPayload,
  type TelegramUpdateLike,
} from './telegram-bridge-core';

loadWorkerEnv();

const BRIDGE_BOT_TOKEN =
  process.env.tgbot_in_token?.trim() || process.env.TELEGRAM_BRIDGE_BOT_TOKEN?.trim() || '';
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN?.trim() || '';
const POLL_TIMEOUT_SECONDS = 30;
const RETRY_DELAY_MS = 3000;
const WORKER_LEASE_TTL_MS = 90_000;
const WORKER_HEARTBEAT_MS = 30_000;
const WORKER_KEY = 'telegram-bridge';
const LOG_PREFIX = '[bridge]';
// 连续 N 次 getUpdates 失败 → Bark 告警「TG 通道断流」（告警一次后按
// REALERT_MS 节流，避免隧道挂一整晚时 Bark 被轰炸）。
const GETUPDATES_ALERT_THRESHOLD = 5;
const GETUPDATES_REALERT_MS = 30 * 60 * 1000;
// 批内并发度：一批 getUpdates 里的 updates 用 worker 池并发 ingest。
// 2026-09-09 审计（scripts/oneoff/latency-audit-2026-09-08.ts）：近14天
// 入桥延迟 p90=2.11h；backlog 消化期串行仅 5-6 条/min，高峰期生产 6+/min
// → 追平无限慢。并发 3 + cursor 批量提交是第一步吞吐修复。
const INGEST_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.TELEGRAM_INGEST_CONCURRENCY || '3', 10) || 3
);
// lag watchdog：连续 N 批平均 lag 超阈值 → Bark「TG 通道积压」。
const LAG_ALERT_THRESHOLD_SEC = Math.max(
  60,
  Number.parseInt(process.env.TELEGRAM_LAG_ALERT_SEC || '300', 10) || 300
);
const LAG_ALERT_CONSECUTIVE_BATCHES = Math.max(
  2,
  Number.parseInt(process.env.TELEGRAM_LAG_ALERT_BATCHES || '3', 10) || 3
);
const LAG_REALERT_MS = 30 * 60 * 1000;
const TELEGRAM_BRIDGE_CAPTURE_DIR = path.join(process.cwd(), '.data', 'telegram-bridge-captures');
const TWITTER_RAW_CAPTURE_FILE = path.join(TELEGRAM_BRIDGE_CAPTURE_DIR, 'twitter-relay-raw.ndjson');
// Default 60s (was 30min). Per-user due still gated by systemConfig
// twitterUncoveredPollingIntervalMinutes — this only sets how often we try.
// Override with TWITTER_SYNC_INTERVAL_MS. Floor 15s for 10s-class Bark SLA budget.
const TWITTER_SYNC_INTERVAL_MS = Math.max(
  15_000,
  Number.parseInt(process.env.TWITTER_SYNC_INTERVAL_MS || '60000', 10) || 60_000
);

const status = createWorkerStatusReporter(WORKER_KEY, 'telegram-bridge');
let lastProcessedUpdateId = readTelegramIngestCursor(WORKER_KEY)?.last_update_id ?? 0;

function setStatus(state: string, lastError?: string | null) {
  status.set(state, {
    lastError,
    lastUpdateId: lastProcessedUpdateId || null,
  });
}

const lease = new WorkerLease({
  workerKey: WORKER_KEY,
  status: { set: (state, update) => setStatus(state, update?.lastError ?? null) },
  leaseTtlMs: WORKER_LEASE_TTL_MS,
  heartbeatMs: WORKER_HEARTBEAT_MS,
  onHeartbeat: () => touchWorkerHeartbeat(WORKER_KEY),
  waitingStatus: 'waiting-for-lease',
  pokeOnAcquired: {
    trigger: 'recovery',
    sourceHint: 'telegram-bridge',
    reason: 'telegram bridge lease recovered',
  },
  log: (message) => console.log(`${LOG_PREFIX} ${message}`),
});

let twitterSyncInFlight = false;

function isPotentialTwitterRelayUpdate(update: TelegramUpdateLike) {
  const message = extractMessage(update);
  const chatId = message?.chat?.id ? String(message.chat.id) : '';
  const text = (message?.text || message?.caption || '').trim();
  const headline = text.split('\n')[0] || '';

  if (!text) {
    return false;
  }
  if (looksLikeTwitterRelayMessage(message || {})) {
    return true;
  }
  if (chatId === '-5299035575') {
    return true;
  }
  return /(?:监控到新推文|发推|转推|引用推文|回复推文)/.test(headline);
}

function captureRawTwitterLikeUpdate(
  update: TelegramUpdateLike,
  context: { chatId: string; source: string; preview: string }
) {
  if (!isPotentialTwitterRelayUpdate(update)) {
    return;
  }

  mkdirSync(TELEGRAM_BRIDGE_CAPTURE_DIR, { recursive: true });
  appendFileSync(
    TWITTER_RAW_CAPTURE_FILE,
    `${JSON.stringify({
      capturedAtMs: Date.now(),
      chatId: context.chatId,
      source: context.source,
      preview: context.preview,
      update,
    })}\n`,
    'utf8'
  );
}

const PROXY_POOL = readTelegramBotApiProxyList();
// 断流告警状态（进程内）：连续失败计数 + 上次 Bark 时间。
let consecutiveGetUpdatesErrors = 0;
let lastOutageAlertAtMs = 0;
// lag watchdog 状态：连续高滞后批计数 + 上次 Bark 时间。
let consecutiveHighLagBatches = 0;
let lastLagAlertAtMs = 0;

async function alertGetUpdatesOutage(reason: string) {
  const now = Date.now();
  const throttled = now - lastOutageAlertAtMs < GETUPDATES_REALERT_MS;
  if (consecutiveGetUpdatesErrors < GETUPDATES_ALERT_THRESHOLD || throttled) {
    return;
  }
  lastOutageAlertAtMs = now;
  console.error(`${LOG_PREFIX} ALERT: TG getUpdates outage (${consecutiveGetUpdatesErrors} consecutive failures): ${reason}`);
  void pushBark({
    title: '⚠️ pili TG 通道断流',
    body: `bridge 连续 ${consecutiveGetUpdatesErrors} 次 getUpdates 失败（代理池 ${PROXY_POOL.join(', ') || '无'}）。同车提醒会延迟。原因: ${reason.slice(0, 160)}`,
    group: 'pili-bridge',
    level: 'timeSensitive',
  }).catch(() => {});
}

/**
 * lag watchdog：本批消息的「 TG 消息时间 → 落库时间」平均滞后。
 * 连续 N 批（LAG_ALERT_CONSECUTIVE_BATCHES）超阈值（LAG_ALERT_THRESHOLD_SEC）
 * → Bark「TG 通道积压」。批间不重置（只有低滞后批才清零），一条 30min
 * REALERT 节流防轰炸。消息时间取 update.message.date / channel_post.date。
 */
async function checkBatchLag(lagsSec: number[]) {
  if (lagsSec.length === 0) return;
  const avgLag = lagsSec.reduce((sum, v) => sum + v, 0) / lagsSec.length;
  if (avgLag * 1000 >= LAG_ALERT_THRESHOLD_SEC * 1000) {
    consecutiveHighLagBatches += 1;
    if (consecutiveHighLagBatches >= LAG_ALERT_CONSECUTIVE_BATCHES) {
      const now = Date.now();
      const throttled = now - lastLagAlertAtMs < LAG_REALERT_MS;
      if (!throttled) {
        lastLagAlertAtMs = now;
        console.error(
          `${LOG_PREFIX} ALERT: TG ingest backlog (avg lag ${avgLag.toFixed(0)}s over ${consecutiveHighLagBatches} batches, n=${lagsSec.length})`
        );
        void pushBark({
          title: '⚠️ pili TG 通道积压',
          body: `bridge 落后 ${Math.round(avgLag / 60)}min（连续 ${consecutiveHighLagBatches} 批，本批 ${lagsSec.length} 条）。同车提醒会延迟。`,
          group: 'pili-bridge',
          level: 'timeSensitive',
        }).catch(() => {});
      }
    }
  } else {
    consecutiveHighLagBatches = 0;
  }
}

const telegramApi = createTelegramBotApiClient({
  token: BRIDGE_BOT_TOKEN,
  proxyUrl: PROXY_POOL,
  onNetworkFailure: ({ attempt, proxy, error }) => {
    if (attempt >= (Number(process.env.TG_BOT_API_MAX_ATTEMPTS) || 3)) {
      // 一轮完整调用耗尽重试才算一次「失败」，计数在主循环的 catch 里做。
      return;
    }
    console.warn(`${LOG_PREFIX} getUpdates attempt ${attempt} failed via ${proxy ?? 'direct'}: ${error.slice(0, 160)}`);
  },
});

async function runTwitterSyncFallback(reason: 'startup' | 'interval') {
  if (!ADMIN_API_TOKEN) {
    console.log(`${LOG_PREFIX} twitter-sync fallback disabled: missing ADMIN_API_TOKEN`);
    return;
  }

  if (twitterSyncInFlight) {
    console.log(`${LOG_PREFIX} twitter-sync fallback skipped: already running (${reason})`);
    return;
  }

  twitterSyncInFlight = true;
  console.log(`${LOG_PREFIX} twitter-sync fallback started (${reason})`);

  try {
    const result = await runTwitterSyncAction({ action: 'sync', windowDays: 7 });

    if (!result.ok && result.errorCode === 'lease_not_acquired') {
      console.log(`${LOG_PREFIX} twitter-sync fallback skipped: lease busy (${reason})`);
      return;
    }

    if (!result.ok) {
      throw new Error(result.error);
    }

    console.log(
      `${LOG_PREFIX} twitter-sync fallback completed (${reason}) run=${'runId' in result ? result.runId : '-'}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} twitter-sync fallback failed (${reason}): ${message}`);
  } finally {
    twitterSyncInFlight = false;
  }
}

function startTwitterSyncSchedule() {
  if (!ADMIN_API_TOKEN) {
    console.log(`${LOG_PREFIX} twitter-sync fallback disabled: missing ADMIN_API_TOKEN`);
    return;
  }

  void runTwitterSyncFallback('startup');
  setInterval(() => {
    void runTwitterSyncFallback('interval');
  }, TWITTER_SYNC_INTERVAL_MS);
  console.log(`${LOG_PREFIX} twitter sync interval: ${TWITTER_SYNC_INTERVAL_MS}ms`);
}

async function bootstrap() {
  if (!BRIDGE_BOT_TOKEN) {
    throw new Error('Missing TELEGRAM_BRIDGE_BOT_TOKEN');
  }

  await telegramApi('deleteWebhook', { drop_pending_updates: false });
  const me = await telegramApi<{ username?: string; first_name?: string }>('getMe');
  console.log(`${LOG_PREFIX} bot ready: ${me.username || me.first_name || 'unknown'}`);
  console.log(`${LOG_PREFIX} target chat: (all bot chats, filtered by service)`);
  console.log(`${LOG_PREFIX} ingest mode: direct sqlite-backed services`);
}

// 2026-09-09 吞吐改造后 cursor 改为批级提交（见主循环 batchMaxUpdateId），
// 此函数仅保留给 shutdown 等非热路径使用。
function rememberProcessedUpdate(updateId: number | undefined) {
  if (typeof updateId !== 'number' || !Number.isFinite(updateId)) {
    return;
  }

  lastProcessedUpdateId = Math.max(lastProcessedUpdateId, Math.floor(updateId));
  saveTelegramIngestCursor(WORKER_KEY, lastProcessedUpdateId);
  setStatus('running');
}

installShutdownHandlers({
  onShutdown: (signal) => {
    console.log(`${LOG_PREFIX} shutting down (${signal})`);
    setStatus('stopped');
    lease.release();
  },
});

async function processUpdate(update: TelegramUpdateLike) {
  const message = extractMessage(update);
  if (!message) {
    return {
      kind: 'skip' as const,
      reason: 'missing-message',
      chatId: 'unknown',
      source: 'unknown',
      preview: '(no text)',
    };
  }

  const chatId = message.chat?.id ? String(message.chat.id) : 'unknown';
  const source = message.from?.username || (message.from?.is_bot ? 'bot' : 'user');
  const preview = (message.text || message.caption || '').split('\n')[0]?.slice(0, 120) || '(no text)';

  if (message.from?.is_bot !== true) {
    return {
      kind: 'skip' as const,
      reason: 'non-bot',
      chatId,
      source,
      preview,
    };
  }

  if (!((message.text || '').trim() || (message.caption || '').trim())) {
    return {
      kind: 'skip' as const,
      reason: 'empty-text',
      chatId,
      source,
      preview,
    };
  }

  captureRawTwitterLikeUpdate(update, { chatId, source, preview });

  if (looksLikeTwitterRelayMessage(message)) {
    const payload = parseTwitterRelayPayload(message);
    if (!payload) {
      return {
        kind: 'twitter-relay-parse-failed' as const,
        reason: 'missing-tweet-ref-or-author-or-content',
        chatId,
        source,
        preview,
      };
    }

    const result = await ingestTwitterRelayPayload(payload);
    return {
      kind: 'twitter-relay' as const,
      chatId,
      source,
      preview,
      payload,
      result,
    };
  }

  const result = await ingestTelegramMonitorUpdate(update);
  return {
    kind: 'telegram-monitor' as const,
    chatId,
    source,
    preview,
    result,
  };
}

async function main() {
  setStatus('starting');

  await bootstrap();
  await lease.waitForAcquire();
  startTwitterSyncSchedule();

  const savedCursor = readTelegramIngestCursor(WORKER_KEY);
  lastProcessedUpdateId = savedCursor?.last_update_id ?? 0;
  let offset = lastProcessedUpdateId > 0 ? lastProcessedUpdateId + 1 : 0;
  console.log(`${LOG_PREFIX} resume offset: ${offset}`);

  while (true) {
    try {
      if (lease.isLost()) {
        console.warn(`${LOG_PREFIX} lease lost, reacquiring...`);
        lease.release();
        await lease.waitForAcquire();
      }

      const updates = await telegramApi<TelegramUpdateLike[]>('getUpdates', {
        timeout: POLL_TIMEOUT_SECONDS,
        offset,
        allowed_updates: ['message', 'channel_post', 'edited_message', 'edited_channel_post'],
      });

      if (consecutiveGetUpdatesErrors > 0) {
        console.log(
          `${LOG_PREFIX} getUpdates recovered after ${consecutiveGetUpdatesErrors} consecutive failures`
        );
      }
      consecutiveGetUpdatesErrors = 0;

      // 批内并发 ingest：processUpdate 的耗时大头是每条 1-2 次同步 sqlite
      // 写（cursor/lease/status）+ projection，串行仅 5-6 条/min，backlog
      // 消化期被高峰生产速率追平。改 worker 池并发（INGEST_CONCURRENCY），
      // offset 只取本批最大 update_id（Telegram getUpdates 语义允许一次
      // 确认整批），单条失败仍不卡批（8/12 死锁教训保留）。
      const batchLagsSec: number[] = [];
      let batchPoked = 0;
      let batchMaxUpdateId: number | null = null;

      const processOne = async (update: TelegramUpdateLike) => {
        const updateId =
          typeof update.update_id === 'number' && Number.isFinite(update.update_id)
            ? Math.floor(update.update_id)
            : null;
        const message = extractMessage(update);
        const msgDateSec = message?.date;
        if (typeof msgDateSec === 'number' && msgDateSec > 0) {
          batchLagsSec.push(Date.now() / 1000 - msgDateSec);
        }
        try {
          return { updateId, result: await processUpdate(update) };
        } catch (error) {
          const message2 = error instanceof Error ? error.message : String(error);
          console.error(`${LOG_PREFIX} update ${updateId ?? '?'} failed, skipped: ${message2}`);
          return { updateId, result: null };
        }
      };

      const results: Awaited<ReturnType<typeof processOne>>[] = [];
      if (INGEST_CONCURRENCY <= 1) {
        for (const update of updates) {
          results.push(await processOne(update));
        }
      } else {
        let cursor = 0;
        const workers = Array.from(
          { length: Math.min(INGEST_CONCURRENCY, Math.max(updates.length, 1)) },
          async () => {
            while (cursor < updates.length) {
              const index = cursor;
              cursor += 1;
              results.push(await processOne(updates[index]));
            }
          }
        );
        await Promise.all(workers);
      }

      for (const { updateId, result } of results) {
        if (result) {
          if (result.kind === 'telegram-monitor') {
            if ('ignored' in result.result && result.result.ignored) {
              console.log(
                `${LOG_PREFIX} monitor ignored chat=${result.chatId} source=${result.source} reason=${result.result.reason} preview=${result.preview}`
              );
            } else {
              batchPoked += 1;
              const feedMode =
                'feedMode' in result.result && result.result.feedMode
                  ? String(result.result.feedMode)
                  : '-';
              const doorbell =
                'doorbell' in result.result ? String(Boolean(result.result.doorbell)) : '-';
              console.log(
                `${LOG_PREFIX} monitor ingested chat=${result.chatId} source=${result.source} feedMode=${feedMode} doorbell=${doorbell} projected=${String(result.result.projected)} preview=${result.preview}`
              );
            }
          } else if (result.kind === 'twitter-relay') {
            if ('ignored' in result.result && result.result.ignored) {
              console.log(
                `${LOG_PREFIX} twitter-relay ignored chat=${result.chatId} source=${result.source} reason=${result.result.reason} preview=${result.preview}`
              );
            } else {
              batchPoked += 1;
              console.log(
                `${LOG_PREFIX} twitter-relay ingested chat=${result.chatId} source=${result.source} tweet=${result.payload.tweetId || '-'} projected=${result.result.projectedCount} preview=${result.preview}`
              );
            }
          } else if (result.kind === 'twitter-relay-parse-failed') {
            console.warn(
              `${LOG_PREFIX} twitter-relay parse-failed chat=${result.chatId} source=${result.source} reason=${result.reason} preview=${result.preview}`
            );
          } else {
            console.log(
              `${LOG_PREFIX} skip chat=${result.chatId} source=${result.source} reason=${result.reason} preview=${result.preview}`
            );
          }
        }

        if (typeof updateId === 'number') {
          batchMaxUpdateId = Math.max(batchMaxUpdateId ?? updateId, updateId);
        }
      }

      // 批级提交：cursor 一次、poke 一次、心跳一次（原来每条 2-3 次写）。
      if (batchMaxUpdateId !== null) {
        lastProcessedUpdateId = Math.max(lastProcessedUpdateId, batchMaxUpdateId);
        saveTelegramIngestCursor(WORKER_KEY, lastProcessedUpdateId);
        offset = batchMaxUpdateId + 1;
        setStatus('running');
      }
      if (batchPoked > 0) {
        queueCompletenessPoke({
          trigger: 'ingest',
          sourceHint: 'telegram-bridge',
          reason: 'telegram monitor ingest',
        });
      }
      await checkBatchLag(batchLagsSec);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus('error', message);
      console.error(`${LOG_PREFIX} error: ${message}`);
      consecutiveGetUpdatesErrors += 1;
      // 仅当 getUpdates 本身因网络错误抛出（含代理池 failover 耗尽）时告警。
      if (/getUpdates network failed/i.test(message)) {
        void alertGetUpdatesOutage(message);
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  setStatus('error', message);
  console.error(message);
  lease.release();
  process.exit(1);
});
