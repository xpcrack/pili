import 'server-only';

import { ingestTelegramMonitorUpdate } from '@/lib/server/telegramMonitorIngest';
import { queueCompletenessPoke } from '@/lib/server/completenessRepo';
import { ingestTwitterRelayPayload } from '@/lib/server/twitterRelayIngest';
import {
  readTelegramIngestCursor,
  saveTelegramIngestCursor,
  touchWorkerHeartbeat,
  upsertWorkerStatus,
} from '@/lib/server/workerStateRepo';
import {
  extractMessage,
  looksLikeTwitterRelayMessage,
  parseTwitterRelayPayload,
  type TelegramUpdateLike,
} from '@/scripts/telegram-bridge-core';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const WORKER_KEY = 'telegram-bridge';
const WORKER_TYPE = 'telegram-bridge';
const POLL_TIMEOUT_SECONDS = 30;
const DEFAULT_SLEEP_MS = 1_000;
const RETRY_DELAY_MS = 3_000;

let bootstrapped = false;
let lastProcessedUpdateId = readTelegramIngestCursor(WORKER_KEY)?.last_update_id ?? 0;

interface TelegramApiResponse<T> {
  ok?: boolean;
  result?: T;
  description?: string;
}

interface ProcessedUpdateOutcome {
  processed: boolean;
}

export interface TelegramBridgeCycleResult {
  sleepMs: number;
  status: 'idle' | 'error' | 'missing-credentials';
  lastError: string | null;
  detail: {
    processedUpdateCount: number;
    lastUpdateId: number | null;
  };
}

export interface RunTelegramBridgeCycleOptions {
  bootstrap?: () => Promise<void>;
  fetchUpdates?: (params: {
    offset: number;
    timeoutSeconds: number;
    allowedUpdates: string[];
  }) => Promise<TelegramUpdateLike[]>;
}

function readBridgeBotToken() {
  return process.env.tgbot_in_token?.trim() || process.env.TELEGRAM_BRIDGE_BOT_TOKEN?.trim() || '';
}

function setWorkerStatus(status: string, input?: { lastError?: string | null; lastUpdateId?: number | null }) {
  upsertWorkerStatus({
    workerKey: WORKER_KEY,
    workerType: WORKER_TYPE,
    status,
    lastError: input?.lastError ?? null,
    lastUpdateId: input?.lastUpdateId ?? (lastProcessedUpdateId || null),
  });
}

function rememberProcessedUpdate(updateId: number | null) {
  if (typeof updateId !== 'number' || !Number.isFinite(updateId)) {
    return;
  }

  lastProcessedUpdateId = Math.max(lastProcessedUpdateId, Math.floor(updateId));
  saveTelegramIngestCursor(WORKER_KEY, lastProcessedUpdateId);
  touchWorkerHeartbeat(WORKER_KEY);
}

function getApiUrl(method: string) {
  return `${TELEGRAM_API_BASE}/bot${readBridgeBotToken()}/${method}`;
}

async function telegramApi<T>(method: string, body?: Record<string, unknown>) {
  const response = await fetch(getApiUrl(method), {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = (await response.json().catch(() => null)) as TelegramApiResponse<T> | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(`Telegram ${method} failed: ${response.status} ${payload?.description || 'unknown error'}`);
  }

  return payload.result as T;
}

function isTelegramGetUpdatesConflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /getUpdates failed: 409 Conflict/i.test(message);
}

async function bootstrap() {
  if (bootstrapped) {
    return;
  }

  await telegramApi('deleteWebhook', { drop_pending_updates: false });
  await telegramApi<{ username?: string; first_name?: string }>('getMe');
  bootstrapped = true;
}

async function processUpdate(update: TelegramUpdateLike): Promise<ProcessedUpdateOutcome> {
  const message = extractMessage(update);
  if (!message) {
    return { processed: false };
  }

  if (message.from?.is_bot !== true) {
    return { processed: false };
  }

  const text = (message.text || message.caption || '').trim();
  if (!text) {
    return { processed: false };
  }

  if (looksLikeTwitterRelayMessage(message)) {
    const payload = parseTwitterRelayPayload(message);
    if (!payload) {
      return { processed: false };
    }

    const result = await ingestTwitterRelayPayload(payload);
    if (!('ignored' in result && result.ignored)) {
      queueCompletenessPoke({
        trigger: 'ingest',
        sourceHint: 'telegram-bridge',
        reason: 'telegram twitter relay ingest',
      });
    }
    return { processed: true };
  }

  const result = await ingestTelegramMonitorUpdate(update);
  if (!('ignored' in result && result.ignored)) {
    queueCompletenessPoke({
      trigger: 'ingest',
      sourceHint: 'telegram-bridge',
      reason: 'telegram monitor ingest',
    });
  }

  return { processed: true };
}

export function resetTelegramBridgeRuntimeStateForTests() {
  bootstrapped = false;
  lastProcessedUpdateId = 0;
}

export async function runTelegramBridgeCycle(
  options: RunTelegramBridgeCycleOptions = {}
): Promise<TelegramBridgeCycleResult> {
  const bridgeBotToken = readBridgeBotToken();
  if (!bridgeBotToken) {
    const lastError = 'Missing TELEGRAM_BRIDGE_BOT_TOKEN';
    setWorkerStatus('missing-credentials', { lastError, lastUpdateId: lastProcessedUpdateId || null });
    return {
      sleepMs: RETRY_DELAY_MS,
      status: 'missing-credentials',
      lastError,
      detail: {
        processedUpdateCount: 0,
        lastUpdateId: lastProcessedUpdateId || null,
      },
    };
  }

  try {
    await (options.bootstrap ?? bootstrap)();
    const savedCursor = readTelegramIngestCursor(WORKER_KEY);
    lastProcessedUpdateId = savedCursor?.last_update_id ?? lastProcessedUpdateId;
    const offset = lastProcessedUpdateId > 0 ? lastProcessedUpdateId + 1 : 0;

    const fetchUpdates = options.fetchUpdates
      ? () =>
          options.fetchUpdates!({
            timeoutSeconds: POLL_TIMEOUT_SECONDS,
            offset,
            allowedUpdates: ['message', 'channel_post', 'edited_message', 'edited_channel_post'],
          })
      : () =>
          telegramApi<TelegramUpdateLike[]>('getUpdates', {
            timeout: POLL_TIMEOUT_SECONDS,
            offset,
            allowed_updates: ['message', 'channel_post', 'edited_message', 'edited_channel_post'],
          });

    const updates = await fetchUpdates();

    let processedUpdateCount = 0;
    for (const update of updates) {
      const updateId =
        typeof update.update_id === 'number' && Number.isFinite(update.update_id)
          ? Math.floor(update.update_id)
          : null;

      const result = await processUpdate(update);
      if (result.processed) {
        processedUpdateCount += 1;
      }
      rememberProcessedUpdate(updateId);
    }

    setWorkerStatus('idle', {
      lastError: null,
      lastUpdateId: lastProcessedUpdateId || null,
    });

    return {
      sleepMs: DEFAULT_SLEEP_MS,
      status: 'idle',
      lastError: null,
      detail: {
        processedUpdateCount,
        lastUpdateId: lastProcessedUpdateId || null,
      },
    };
  } catch (error) {
    const lastError = error instanceof Error ? error.message : String(error);
    if (isTelegramGetUpdatesConflict(error)) {
      setWorkerStatus('idle', {
        lastError,
        lastUpdateId: lastProcessedUpdateId || null,
      });
      return {
        sleepMs: RETRY_DELAY_MS,
        status: 'idle',
        lastError,
        detail: {
          processedUpdateCount: 0,
          lastUpdateId: lastProcessedUpdateId || null,
        },
      };
    }

    setWorkerStatus('error', {
      lastError,
      lastUpdateId: lastProcessedUpdateId || null,
    });
    return {
      sleepMs: RETRY_DELAY_MS,
      status: 'error',
      lastError,
      detail: {
        processedUpdateCount: 0,
        lastUpdateId: lastProcessedUpdateId || null,
      },
    };
  }
}
