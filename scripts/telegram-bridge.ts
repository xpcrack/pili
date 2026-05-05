import { appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ingestTelegramMonitorUpdate } from '@/lib/server/telegramMonitorIngest';
import { queueCompletenessPoke } from '@/lib/server/completenessRepo';
import { acquireIngestionLease, heartbeatIngestionLease, releaseIngestionLease } from '@/lib/server/twitterRepo';
import { ingestTwitterRelayPayload } from '@/lib/server/twitterRelayIngest';
import { runTwitterSyncAction } from '@/lib/server/twitterSyncService';
import { readTelegramIngestCursor, saveTelegramIngestCursor, upsertWorkerStatus } from '@/lib/server/workerStateRepo';

import {
  extractMessage,
  loadEnvFile,
  looksLikeTwitterRelayMessage,
  parseTwitterRelayPayload,
  type TelegramUpdateLike,
} from './telegram-bridge-core';

loadEnvFile(path.join(process.cwd(), '.env.local'));

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const BRIDGE_BOT_TOKEN =
  process.env.tgbot_in_token?.trim() || process.env.TELEGRAM_BRIDGE_BOT_TOKEN?.trim() || '';
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN?.trim() || '';
const POLL_TIMEOUT_SECONDS = 30;
const RETRY_DELAY_MS = 3000;
const LEASE_RETRY_DELAY_MS = 10_000;
const WORKER_LEASE_TTL_MS = 90_000;
const WORKER_HEARTBEAT_MS = 30_000;
const WORKER_KEY = 'telegram-bridge';
const TELEGRAM_BRIDGE_CAPTURE_DIR = path.join(process.cwd(), '.data', 'telegram-bridge-captures');
const TWITTER_RAW_CAPTURE_FILE = path.join(TELEGRAM_BRIDGE_CAPTURE_DIR, 'twitter-relay-raw.ndjson');
const TWITTER_SYNC_INTERVAL_MS = Math.max(
  60_000,
  Number.parseInt(process.env.TWITTER_SYNC_INTERVAL_MS || '1800000', 10) || 1_800_000
);

let twitterSyncInFlight = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let leaseLost = false;
let lastProcessedUpdateId = readTelegramIngestCursor(WORKER_KEY)?.last_update_id ?? 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function upsertBridgeStatus(status: string, lastError?: string | null) {
  upsertWorkerStatus({
    workerKey: WORKER_KEY,
    workerType: 'telegram-bridge',
    status,
    lastUpdateId: lastProcessedUpdateId || null,
    lastError: lastError || null,
  });
}

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

function captureRawTwitterLikeUpdate(update: TelegramUpdateLike, context: { chatId: string; source: string; preview: string }) {
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

function getApiUrl(method: string) {
  return `${TELEGRAM_API_BASE}/bot${BRIDGE_BOT_TOKEN}/${method}`;
}

async function telegramApi<T>(method: string, body?: Record<string, unknown>) {
  const response = await fetch(getApiUrl(method), {
    method: body ? 'POST' : 'GET',
    headers: body
      ? {
          'Content-Type': 'application/json',
        }
      : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = (await response.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(`Telegram ${method} failed: ${response.status} ${payload?.description || 'unknown error'}`);
  }

  return payload.result as T;
}

async function runTwitterSyncFallback(reason: 'startup' | 'interval') {
  if (!ADMIN_API_TOKEN) {
    console.log('[bridge] twitter-sync fallback disabled: missing ADMIN_API_TOKEN');
    return;
  }

  if (twitterSyncInFlight) {
    console.log(`[bridge] twitter-sync fallback skipped: already running (${reason})`);
    return;
  }

  twitterSyncInFlight = true;
  console.log(`[bridge] twitter-sync fallback started (${reason})`);

  try {
    const result = await runTwitterSyncAction({
      action: 'sync',
      windowDays: 7,
    });

    if (!result.ok && result.errorCode === 'lease_not_acquired') {
      console.log(`[bridge] twitter-sync fallback skipped: lease busy (${reason})`);
      return;
    }

    if (!result.ok) {
      throw new Error(result.error);
    }

    console.log(`[bridge] twitter-sync fallback completed (${reason}) run=${'runId' in result ? result.runId : '-'}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[bridge] twitter-sync fallback failed (${reason}): ${message}`);
  } finally {
    twitterSyncInFlight = false;
  }
}

function startTwitterSyncSchedule() {
  if (!ADMIN_API_TOKEN) {
    console.log('[bridge] twitter-sync fallback disabled: missing ADMIN_API_TOKEN');
    return;
  }

  void runTwitterSyncFallback('startup');
  setInterval(() => {
    void runTwitterSyncFallback('interval');
  }, TWITTER_SYNC_INTERVAL_MS);
  console.log(`[bridge] twitter sync interval: ${TWITTER_SYNC_INTERVAL_MS}ms`);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    if (!heartbeatIngestionLease(WORKER_KEY, getWorkerOwner(), now, WORKER_LEASE_TTL_MS)) {
      leaseLost = true;
      upsertBridgeStatus('lease-lost', 'worker lease heartbeat failed');
      return;
    }

    upsertBridgeStatus('running');
  }, WORKER_HEARTBEAT_MS);
}

function getWorkerOwner() {
  return `${os.hostname()}:${process.pid}`;
}

async function waitForWorkerLease() {
  while (true) {
    const now = Date.now();
    if (acquireIngestionLease(WORKER_KEY, getWorkerOwner(), now, WORKER_LEASE_TTL_MS)) {
      leaseLost = false;
      upsertBridgeStatus('running');
      queueCompletenessPoke({
        trigger: 'recovery',
        sourceHint: 'telegram-bridge',
        reason: 'telegram bridge lease recovered',
      });
      startHeartbeat();
      console.log('[bridge] worker lease acquired');
      return;
    }

    upsertBridgeStatus('waiting-for-lease');
    console.log('[bridge] worker lease busy, waiting...');
    await sleep(LEASE_RETRY_DELAY_MS);
  }
}

function releaseWorkerLease() {
  stopHeartbeat();
  releaseIngestionLease(WORKER_KEY, getWorkerOwner());
}

async function bootstrap() {
  if (!BRIDGE_BOT_TOKEN) {
    throw new Error('Missing TELEGRAM_BRIDGE_BOT_TOKEN');
  }

  await telegramApi('deleteWebhook', { drop_pending_updates: false });
  const me = await telegramApi<{ username?: string; first_name?: string }>('getMe');
  console.log(`[bridge] bot ready: ${me.username || me.first_name || 'unknown'}`);
  console.log('[bridge] target chat: (all bot chats, filtered by service)');
  console.log('[bridge] ingest mode: direct sqlite-backed services');
}

function rememberProcessedUpdate(updateId: number | undefined) {
  if (typeof updateId !== 'number' || !Number.isFinite(updateId)) {
    return;
  }

  lastProcessedUpdateId = Math.max(lastProcessedUpdateId, Math.floor(updateId));
  saveTelegramIngestCursor(WORKER_KEY, lastProcessedUpdateId);
  upsertBridgeStatus('running');
}

function installShutdownHandlers() {
  const shutdown = (signal: string) => {
    console.log(`[bridge] shutting down (${signal})`);
    upsertBridgeStatus('stopped');
    releaseWorkerLease();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

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
  installShutdownHandlers();
  upsertBridgeStatus('starting');

  await bootstrap();
  await waitForWorkerLease();
  startTwitterSyncSchedule();

  const savedCursor = readTelegramIngestCursor(WORKER_KEY);
  lastProcessedUpdateId = savedCursor?.last_update_id ?? 0;
  let offset = lastProcessedUpdateId > 0 ? lastProcessedUpdateId + 1 : 0;
  console.log(`[bridge] resume offset: ${offset}`);

  while (true) {
    try {
      if (leaseLost) {
        console.warn('[bridge] lease lost, reacquiring...');
        releaseWorkerLease();
        await waitForWorkerLease();
      }

      const updates = await telegramApi<TelegramUpdateLike[]>('getUpdates', {
        timeout: POLL_TIMEOUT_SECONDS,
        offset,
        allowed_updates: ['message', 'channel_post', 'edited_message', 'edited_channel_post'],
      });

      for (const update of updates) {
        const updateId = typeof update.update_id === 'number' && Number.isFinite(update.update_id) ? Math.floor(update.update_id) : null;
        const nextOffset = typeof updateId === 'number' ? updateId + 1 : offset;
        const result = await processUpdate(update);

        if (result.kind === 'telegram-monitor') {
          if ('ignored' in result.result && result.result.ignored) {
            console.log(
              `[bridge] monitor ignored chat=${result.chatId} source=${result.source} reason=${result.result.reason} preview=${result.preview}`
            );
          } else {
            queueCompletenessPoke({
              trigger: 'ingest',
              sourceHint: 'telegram-bridge',
              reason: 'telegram monitor ingest',
            });
            console.log(
              `[bridge] monitor ingested chat=${result.chatId} source=${result.source} projected=${String(result.result.projected)} preview=${result.preview}`
            );
          }
        } else if (result.kind === 'twitter-relay') {
          if ('ignored' in result.result && result.result.ignored) {
            console.log(
              `[bridge] twitter-relay ignored chat=${result.chatId} source=${result.source} reason=${result.result.reason} preview=${result.preview}`
            );
          } else {
            queueCompletenessPoke({
              trigger: 'ingest',
              sourceHint: 'telegram-bridge',
              reason: 'telegram twitter relay ingest',
            });
            console.log(
              `[bridge] twitter-relay ingested chat=${result.chatId} source=${result.source} tweet=${result.payload.tweetId || '-'} projected=${result.result.projectedCount} preview=${result.preview}`
            );
          }
        } else if (result.kind === 'twitter-relay-parse-failed') {
          console.warn(
            `[bridge] twitter-relay parse-failed chat=${result.chatId} source=${result.source} reason=${result.reason} preview=${result.preview}`
          );
        } else {
          console.log(`[bridge] skip chat=${result.chatId} source=${result.source} reason=${result.reason} preview=${result.preview}`);
        }

        rememberProcessedUpdate(updateId ?? undefined);
        offset = nextOffset;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      upsertBridgeStatus('error', message);
      console.error(`[bridge] error: ${message}`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  upsertBridgeStatus('error', message);
  console.error(message);
  releaseWorkerLease();
  process.exit(1);
});
