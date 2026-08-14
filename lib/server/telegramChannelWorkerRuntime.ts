import 'server-only';

import type { TelegramClientConfig } from '@/lib/server/telegramClientConfig';
import { readTelegramClientConfig } from '@/lib/server/telegramClientConfig';
import { createTelegramGramjsClient } from '@/lib/server/telegramGramjsClient';
import { syncAllTelegramChannelSources } from '@/lib/server/telegramChannelSync';
import { ensureLiveTelegramChannelClient } from '@/lib/server/telegramChannelLive';
import { classifyTelegramMtprotoError, readTelegramMtprotoPolicy } from '@/lib/server/telegramMtprotoPolicy';
import type { TelegramChannelSyncClient } from '@/lib/server/telegramChannelTypes';
import { queueCompletenessPoke } from '@/lib/server/completenessRepo';
import { upsertWorkerStatus } from '@/lib/server/workerStateRepo';

const WORKER_KEY = 'telegram-channel-sync';
const WORKER_TYPE = 'telegram-channel-sync';
const FAILURE_RETRY_DELAY_MS = 10_000;

function upsertChannelWorkerStatus(status: string, lastError?: string | null) {
  upsertWorkerStatus({
    workerKey: WORKER_KEY,
    workerType: WORKER_TYPE,
    status,
    lastError: lastError || null,
  });
}

export async function runTelegramChannelWorkerCycle() {
  return runTelegramChannelWorkerCycleWithDeps({});
}

export async function runTelegramChannelWorkerCycleWithDeps(deps: {
  readConfig?: () => TelegramClientConfig;
  createClient?: () => Promise<TelegramChannelSyncClient>;
}) {
  const policy = readTelegramMtprotoPolicy();
  const config = deps.readConfig ? deps.readConfig() : readTelegramClientConfig();

  if (config.status === 'missing_credentials') {
    const lastError = 'Missing TELEGRAM_API_ID or TELEGRAM_API_HASH';
    upsertChannelWorkerStatus('missing-credentials', lastError);
    console.log('[telegram-channel-worker] missing credentials, waiting for next interval');
    return {
      sleepMs: policy.channelSyncIntervalMs,
      status: 'missing-credentials',
      lastError,
    };
  }

  if (config.status === 'auth_required') {
    const lastError = 'Missing TELEGRAM_SESSION_STRING';
    upsertChannelWorkerStatus('auth-required', lastError);
    console.log('[telegram-channel-worker] missing user session, waiting for next interval');
    return {
      sleepMs: policy.channelSyncIntervalMs,
      status: 'auth-required',
      lastError,
    };
  }

  // 即时路径：常驻 client + updates 长连接。成功后兜底 sync 复用同一连接。
  // 失败则回退到「每 cycle 新建 client」的旧路径，确保兜底 sync 不中断。
  let useLiveClient = deps.createClient === undefined;
  let liveClient: TelegramChannelSyncClient | null = null;
  if (useLiveClient) {
    const live = await ensureLiveTelegramChannelClient();
    if (!live.client) {
      console.warn(`[telegram-channel-worker] live client unavailable, falling back to per-cycle client: ${live.error}`);
      useLiveClient = false;
    } else {
      liveClient = live.client;
    }
  }

  let client: TelegramChannelSyncClient | null = null;
  try {
    if (!useLiveClient || !liveClient) {
      client = deps.createClient ? await deps.createClient() : await createTelegramGramjsClient();
    } else {
      client = liveClient;
    }
    const result = await syncAllTelegramChannelSources({
      client,
    });

    if (result.sourceCount === 0) {
      upsertChannelWorkerStatus('idle');
      console.log('[telegram-channel-worker] no enabled telegram channel sources');
      return {
        sleepMs: policy.channelSyncIntervalMs,
        status: 'idle',
        lastError: null,
      };
    }

    for (const item of result.results) {
      if (item.ok) {
        console.log(
          `[telegram-channel-worker] ${item.channelRef} stored=${item.storedCount} projected=${item.projectedCount} lastMessageId=${item.lastMessageId ?? 'null'}`
        );
      } else {
        console.log(`[telegram-channel-worker] ${item.channelRef} failed=${item.error || 'unknown error'}`);
      }
    }

    const status = result.errorCount > 0 ? 'partial' : 'idle';
    const lastError = result.errorCount > 0 ? `${result.errorCount} source error(s)` : null;
    if (result.storedCount > 0 || result.projectedCount > 0) {
      queueCompletenessPoke({
        trigger: 'ingest',
        sourceHint: 'telegram-channel',
        reason: 'telegram channel realtime ingest',
      });
    }
    upsertChannelWorkerStatus(status, lastError);
    console.log(
      `[telegram-channel-worker] cycle complete sources=${result.sourceCount} synced=${result.syncedCount} errors=${result.errorCount} stored=${result.storedCount} projected=${result.projectedCount}`
    );
    return {
      sleepMs: Math.max(policy.channelSyncIntervalMs, result.backoffMs || 0),
      status,
      lastError,
    };
  } catch (error) {
    const classified = classifyTelegramMtprotoError(error);
    const status = classified.kind === 'auth_required' ? 'auth-required' : 'error';
    upsertChannelWorkerStatus(status, classified.message);
    console.error(`[telegram-channel-worker] cycle failed: ${classified.message}`);
    return {
      sleepMs: Math.max(
        Math.min(policy.channelSyncIntervalMs, FAILURE_RETRY_DELAY_MS),
        typeof classified.waitMs === 'number' && Number.isFinite(classified.waitMs) ? classified.waitMs : 0
      ),
      status,
      lastError: classified.message,
    };
  } finally {
    // live client 常驻跨 cycle，绝不 disconnect；仅断开 fallback 新建的 client
    if (!useLiveClient) {
      await client?.disconnect?.();
    }
  }
}
