import 'server-only';

import type { AddressDiagnostic } from '@/lib/activityFeed';
import { isIngestAlertQuotaAvailable, markIngestAlertQuotaConsumed } from '@/lib/server/ingestAlertRepo';
import { readSystemConfig, type SystemConfigSnapshot } from '@/lib/server/systemConfigRepo';
import { sendTelegramTextMessage } from '@/lib/server/telegramNotify';

const ALERT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURE_LINES = 8;

export interface NotifySyncFailureInput {
  runId: number;
  reason: string;
  mode: 'refresh' | 'backfill';
  scope: 'global' | 'user';
  userId: string | null;
  beginMs: number;
  endMs: number;
  diagnostics: AddressDiagnostic[];
}

interface NotifySyncFailureDeps {
  readConfig?: () => SystemConfigSnapshot;
  isQuotaAvailable?: (rateKey: string, windowMs: number) => boolean;
  markQuotaConsumed?: (rateKey: string, windowMs: number) => void;
  sendMessage?: typeof sendTelegramTextMessage;
}

export interface NotifySyncFailureResult {
  sent: boolean;
  reason:
    | 'no-failures'
    | 'no-retry-exhausted-failures'
    | 'missing-chat-id'
    | 'rate-limited'
    | 'telegram-request-failed'
    | 'sent';
  totalFailed: number;
  alertedFailed: number;
}

function normalize(value: string | null | undefined) {
  return (value || '').trim();
}

function pickAlertChatId(config: SystemConfigSnapshot) {
  return (
    normalize(config.conflictNotificationTelegramChatId) ||
    normalize(config.telegramUnknownPersonAlertChatId) ||
    ''
  );
}

function errorBucket(error: string | null | undefined) {
  const normalized = normalize(error).toLowerCase();
  if (!normalized) {
    return 'unknown';
  }
  if (normalized.includes('okx api 429')) {
    return 'okx-429';
  }
  if (/okx api 5\d\d/.test(normalized)) {
    return 'okx-5xx';
  }
  if (normalized.includes('超时') || normalized.includes('timeout')) {
    return 'timeout';
  }
  if (normalized.includes('network') || normalized.includes('网络')) {
    return 'network';
  }
  return 'other';
}

function buildFailureRateKey(item: AddressDiagnostic) {
  return [
    'sync-address-fetch-failure',
    normalize(item.chain).toLowerCase(),
    normalize(item.address).toLowerCase(),
    errorBucket(item.error),
  ].join('|');
}

function trimOneLine(value: string | null | undefined, max = 80) {
  const normalized = normalize(value).replace(/\s+/g, ' ');
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

function formatShanghaiTimestamp(ms: number) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));

  const get = (type: string) => parts.find((part) => part.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} CST`;
}

export function buildSyncFailureAlertMessage(input: {
  runId: number;
  reason: string;
  mode: 'refresh' | 'backfill';
  scope: 'global' | 'user';
  userId: string | null;
  beginMs: number;
  endMs: number;
  totalFailed: number;
  alertedFailed: number;
  failures: AddressDiagnostic[];
}) {
  const lines = input.failures.slice(0, MAX_FAILURE_LINES).map((item) => {
    const attempts =
      typeof item.fetchAttempts === 'number' && Number.isFinite(item.fetchAttempts)
        ? `重试=${Math.max(1, Math.floor(item.fetchAttempts))}`
        : '重试=unknown';
    const errorText = trimOneLine(item.error || 'unknown error', 100);
    return `- ${item.userName}/${item.addressName} ${item.chain} ${attempts} ${errorText}`;
  });

  if (input.failures.length > MAX_FAILURE_LINES) {
    lines.push(`- ... 另外 ${input.failures.length - MAX_FAILURE_LINES} 个失败地址未展开`);
  }

  return [
    '⚠️ 地址拉取多次重试后仍失败',
    `runId: ${input.runId}`,
    `reason: ${input.reason}`,
    `mode: ${input.mode} / scope: ${input.scope}${input.userId ? ` / userId: ${input.userId}` : ''}`,
    `window: ${formatShanghaiTimestamp(input.beginMs)} -> ${formatShanghaiTimestamp(input.endMs)}`,
    `失败地址: ${input.totalFailed}，触发告警: ${input.alertedFailed}`,
    ...lines,
  ].join('\n');
}

export async function notifySyncAddressFetchFailures(
  input: NotifySyncFailureInput,
  deps?: NotifySyncFailureDeps
): Promise<NotifySyncFailureResult> {
  const allFailures = input.diagnostics.filter((item) => !item.ok);
  if (allFailures.length === 0) {
    return {
      sent: false,
      reason: 'no-failures',
      totalFailed: 0,
      alertedFailed: 0,
    };
  }

  const retryExhaustedFailures = allFailures.filter((item) => item.retryExhausted === true);
  if (retryExhaustedFailures.length === 0) {
    return {
      sent: false,
      reason: 'no-retry-exhausted-failures',
      totalFailed: allFailures.length,
      alertedFailed: 0,
    };
  }

  const config = deps?.readConfig ? deps.readConfig() : readSystemConfig();
  const chatId = pickAlertChatId(config);
  if (!chatId) {
    return {
      sent: false,
      reason: 'missing-chat-id',
      totalFailed: retryExhaustedFailures.length,
      alertedFailed: 0,
    };
  }

  const isQuotaAvailable = deps?.isQuotaAvailable || isIngestAlertQuotaAvailable;
  const markQuotaConsumed = deps?.markQuotaConsumed || markIngestAlertQuotaConsumed;
  const alertedFailures = retryExhaustedFailures.filter((item) =>
    isQuotaAvailable(buildFailureRateKey(item), ALERT_RATE_LIMIT_WINDOW_MS)
  );
  if (alertedFailures.length === 0) {
    return {
      sent: false,
      reason: 'rate-limited',
      totalFailed: retryExhaustedFailures.length,
      alertedFailed: 0,
    };
  }

  const text = buildSyncFailureAlertMessage({
    runId: input.runId,
    reason: input.reason,
    mode: input.mode,
    scope: input.scope,
    userId: input.userId,
    beginMs: input.beginMs,
    endMs: input.endMs,
    totalFailed: retryExhaustedFailures.length,
    alertedFailed: alertedFailures.length,
    failures: alertedFailures,
  });

  const sendMessage = deps?.sendMessage || sendTelegramTextMessage;
  const result = await sendMessage({
    chatId,
    text,
  });
  if (!result.ok) {
    return {
      sent: false,
      reason: 'telegram-request-failed',
      totalFailed: retryExhaustedFailures.length,
      alertedFailed: alertedFailures.length,
    };
  }

  for (const item of alertedFailures) {
    try {
      markQuotaConsumed(buildFailureRateKey(item), ALERT_RATE_LIMIT_WINDOW_MS);
    } catch (error) {
      console.error('[syncFailureNotifier] failed to mark quota consumed', {
        rateKey: buildFailureRateKey(item),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    sent: true,
    reason: 'sent',
    totalFailed: retryExhaustedFailures.length,
    alertedFailed: alertedFailures.length,
  };
}
