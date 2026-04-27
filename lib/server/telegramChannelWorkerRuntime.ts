import 'server-only';

import type { TelegramClientConfig } from '@/lib/server/telegramClientConfig';
import { readTelegramClientConfig } from '@/lib/server/telegramClientConfig';
import { createTelegramGramjsClient } from '@/lib/server/telegramGramjsClient';
import { syncAllTelegramChannelSources } from '@/lib/server/telegramChannelSync';
import { classifyTelegramMtprotoError, readTelegramMtprotoPolicy } from '@/lib/server/telegramMtprotoPolicy';
import type { TelegramChannelSyncClient } from '@/lib/server/telegramChannelTypes';
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

  let client: TelegramChannelSyncClient | null = null;
  try {
    client = deps.createClient ? await deps.createClient() : await createTelegramGramjsClient();
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
    await client?.disconnect?.();
  }
}
