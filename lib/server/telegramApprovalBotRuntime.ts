import 'server-only';

import crypto from 'node:crypto';

import { handleTelegramApprovalBotMessage } from '@/lib/server/telegramAgentApprovalBot';
import { resolveTelegramBotToken } from '@/lib/server/telegramBotToken';
import {
  acquireWorkerLease,
  markWorkerUpdateProcessed,
  readTelegramIngestCursor,
  saveTelegramIngestCursor,
  upsertWorkerStatus,
} from '@/lib/server/workerStateRepo';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const WORKER_KEY = 'telegram-agent-approval-bot';
const WORKER_TYPE = 'telegram-agent-approval-bot';
const DEFAULT_APPROVAL_CHAT_ID = '-5130530086';
const POLL_TIMEOUT_SECONDS = 30;
const FAILURE_SLEEP_MS = 3_000;
const LEASE_DURATION_MS = 90_000;
const LEASE_WAIT_SLEEP_MS = 500;
const WORKER_OWNER_ID = `${process.pid}:${crypto.randomUUID()}`;
const BOT_USERNAME_CACHE = new Map<string, string>();

interface TelegramBotApiPayload<T> {
  ok?: boolean;
  result?: T;
  description?: string;
}

interface TelegramUserLike {
  id?: number | string;
  username?: string;
}

interface TelegramChatLike {
  id?: number | string;
}

interface TelegramMessageLike {
  text?: string;
  from?: TelegramUserLike;
  chat?: TelegramChatLike;
}

export interface TelegramApprovalUpdate {
  update_id?: number;
  message?: TelegramMessageLike;
  edited_message?: TelegramMessageLike;
}

export interface RunTelegramApprovalBotCycleInput {
  approvalChatId?: string;
  botUsername?: string | null;
  fetchUpdates?: (params: { offset: number; timeoutSeconds: number }) => Promise<TelegramApprovalUpdate[]>;
  handleMessage?: (input: {
    approvalChatId: string;
    text: string;
    fromUserId: string;
    fromUsername?: string | null;
    botUsername?: string | null;
    sendMessage: (params: { chatId: string; text: string }) => Promise<void>;
  }) => Promise<{ handled: boolean }>;
  readOffset?: () => number;
  saveOffset?: (lastUpdateId: number) => void;
}

export interface RunTelegramApprovalBotCycleResult {
  status: 'running' | 'idle' | 'missing-credentials' | 'error';
  lastUpdateId: number;
  updateCount: number;
  handledCount: number;
  sleepMs: number;
  lastError: string | null;
}

function normalize(value: string | null | undefined) {
  return (value || '').trim();
}

function readStoredOffset() {
  return readTelegramIngestCursor(WORKER_KEY)?.last_update_id ?? 0;
}

function saveStoredOffset(lastUpdateId: number) {
  saveTelegramIngestCursor(WORKER_KEY, lastUpdateId);
}

function upsertApprovalBotStatus(input: {
  status: RunTelegramApprovalBotCycleResult['status'];
  lastUpdateId: number;
  lastError?: string | null;
}) {
  upsertWorkerStatus({
    workerKey: WORKER_KEY,
    workerType: WORKER_TYPE,
    status: input.status,
    lastUpdateId: input.lastUpdateId,
    lastError: input.lastError || null,
  });
}

function toInteger(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function toStringId(value: string | number | null | undefined) {
  if (typeof value === 'string') {
    return normalize(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.floor(value));
  }
  return '';
}

async function telegramApi<T>(token: string, method: string, body?: Record<string, unknown>) {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body
      ? {
          'Content-Type': 'application/json',
        }
      : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = (await response.json().catch(() => null)) as TelegramBotApiPayload<T> | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(`Telegram ${method} failed: ${response.status} ${payload?.description || 'unknown error'}`);
  }

  return payload.result as T;
}

async function fetchUpdatesFromBotApi(params: { offset: number; timeoutSeconds: number }) {
  const token = normalize(resolveTelegramBotToken());
  if (!token) {
    throw new Error('Missing TELEGRAM bot token');
  }

  return telegramApi<TelegramApprovalUpdate[]>(token, 'getUpdates', {
    timeout: params.timeoutSeconds,
    offset: params.offset,
    allowed_updates: ['message', 'edited_message'],
  });
}

async function fetchBotUsernameFromBotApi(token: string) {
  const payload = await telegramApi<{ username?: string }>(token, 'getMe');
  return normalize(payload?.username).replace(/^@+/, '');
}

async function resolveApprovalBotUsername(input: { explicitBotUsername?: string | null; token: string }) {
  const explicitBotUsername = normalize(input.explicitBotUsername).replace(/^@+/, '');
  if (explicitBotUsername) {
    return explicitBotUsername;
  }

  const envBotUsername = normalize(process.env.TELEGRAM_APPROVAL_BOT_USERNAME).replace(/^@+/, '');
  if (envBotUsername) {
    return envBotUsername;
  }

  const token = normalize(input.token);
  if (!token) {
    return '';
  }

  const cached = BOT_USERNAME_CACHE.get(token);
  if (cached) {
    return cached;
  }

  try {
    const fromApi = await fetchBotUsernameFromBotApi(token);
    if (fromApi) {
      BOT_USERNAME_CACHE.set(token, fromApi);
      return fromApi;
    }
  } catch {
    return '';
  }
  return '';
}

async function sendTelegramMessage(params: { chatId: string; text: string }) {
  const token = normalize(resolveTelegramBotToken());
  if (!token) {
    throw new Error('Missing TELEGRAM bot token');
  }

  await telegramApi(token, 'sendMessage', {
    chat_id: params.chatId,
    text: params.text,
    disable_web_page_preview: true,
  });
}

export async function deleteTelegramApprovalBotWebhook() {
  const token = normalize(resolveTelegramBotToken());
  if (!token) {
    throw new Error('Missing TELEGRAM bot token');
  }

  await telegramApi(token, 'deleteWebhook', { drop_pending_updates: false });
}

export async function runTelegramApprovalBotCycle(
  input: RunTelegramApprovalBotCycleInput = {}
): Promise<RunTelegramApprovalBotCycleResult> {
  const readOffset = input.readOffset || readStoredOffset;
  const saveOffset = input.saveOffset || saveStoredOffset;
  const fetchUpdates = input.fetchUpdates || fetchUpdatesFromBotApi;
  const handleMessage = input.handleMessage || handleTelegramApprovalBotMessage;
  const approvalChatId = normalize(input.approvalChatId) || DEFAULT_APPROVAL_CHAT_ID;
  const token = normalize(resolveTelegramBotToken());
  const botUsername = await resolveApprovalBotUsername({
    explicitBotUsername: input.botUsername,
    token,
  });
  const baseOffset = toInteger(readOffset(), 0);
  let committedOffset = baseOffset;
  let handledCount = 0;
  let processedCount = 0;
  const hasLease = acquireWorkerLease({
    workerKey: WORKER_KEY,
    ownerId: WORKER_OWNER_ID,
    leaseMs: LEASE_DURATION_MS,
  });

  if (!hasLease) {
    return {
      status: 'idle',
      lastUpdateId: baseOffset,
      updateCount: 0,
      handledCount: 0,
      sleepMs: LEASE_WAIT_SLEEP_MS,
      lastError: null,
    };
  }

  if (!token && !input.fetchUpdates) {
    const lastError = 'Missing TELEGRAM bot token';
    upsertApprovalBotStatus({
      status: 'missing-credentials',
      lastUpdateId: baseOffset,
      lastError,
    });
    return {
      status: 'missing-credentials',
      lastUpdateId: baseOffset,
      updateCount: 0,
      handledCount: 0,
      sleepMs: FAILURE_SLEEP_MS,
      lastError,
    };
  }

  try {
    const updates = await fetchUpdates({
      offset: baseOffset > 0 ? baseOffset + 1 : 0,
      timeoutSeconds: POLL_TIMEOUT_SECONDS,
    });

    for (const update of updates || []) {
      const updateId = toInteger(update?.update_id, committedOffset);
      const canCommitUpdateId = updateId > committedOffset;

      const message = update?.message || update?.edited_message;
      const sourceChatId = toStringId(message?.chat?.id);
      const text = normalize(message?.text);
      if (message && sourceChatId === approvalChatId && text) {
        const shouldHandle = markWorkerUpdateProcessed({
          workerKey: WORKER_KEY,
          updateId,
        });
        if (!shouldHandle) {
          processedCount += 1;
          if (canCommitUpdateId) {
            saveOffset(updateId);
            committedOffset = updateId;
          }
          continue;
        }

        const result = await handleMessage({
          approvalChatId: sourceChatId,
          text,
          fromUserId: toStringId(message.from?.id),
          fromUsername: normalize(message.from?.username) || null,
          botUsername,
          sendMessage: sendTelegramMessage,
        });
        if (result.handled) {
          handledCount += 1;
        }
      }
      processedCount += 1;

      if (canCommitUpdateId) {
        saveOffset(updateId);
        committedOffset = updateId;
      }
    }

    const status = updates.length > 0 ? 'running' : 'idle';
    upsertApprovalBotStatus({
      status,
      lastUpdateId: committedOffset,
      lastError: null,
    });
    return {
      status,
      lastUpdateId: committedOffset,
      updateCount: processedCount,
      handledCount,
      sleepMs: 0,
      lastError: null,
    };
  } catch (error) {
    const lastError = error instanceof Error ? error.message : String(error);
    upsertApprovalBotStatus({
      status: 'error',
      lastUpdateId: committedOffset,
      lastError,
    });
    return {
      status: 'error',
      lastUpdateId: committedOffset,
      updateCount: processedCount,
      handledCount,
      sleepMs: FAILURE_SLEEP_MS,
      lastError,
    };
  }
}
