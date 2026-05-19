import 'server-only';

import { isIngestAlertQuotaAvailable, markIngestAlertQuotaConsumed } from '@/lib/server/ingestAlertRepo';
import { readSystemConfig, type SystemConfigSnapshot } from '@/lib/server/systemConfigRepo';
import { sendTelegramTextMessage } from '@/lib/server/telegramNotify';
import { type TwitterLane } from '@/lib/server/twitterRepo';
import { type TwitterFetcherProvider } from '@/lib/server/twitterFetcher';

const ALERT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURE_LINES = 12;

export interface TwitterProviderFailureItem {
  userId: string;
  userName: string;
  handle: string;
  lane: TwitterLane;
  providerChain: TwitterFetcherProvider[];
}

export interface NotifyTwitterProviderFailuresInput {
  runId: number | null;
  failures: TwitterProviderFailureItem[];
}

interface NotifyTwitterProviderFailuresDeps {
  readConfig?: () => SystemConfigSnapshot;
  isQuotaAvailable?: (rateKey: string, windowMs: number) => boolean;
  markQuotaConsumed?: (rateKey: string, windowMs: number) => void;
  sendMessage?: typeof sendTelegramTextMessage;
}

export interface NotifyTwitterProviderFailuresResult {
  sent: boolean;
  reason:
    | 'no-failures'
    | 'missing-chat-id'
    | 'rate-limited'
    | 'telegram-request-failed'
    | 'sent';
  failureCount: number;
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

function formatProviderChain(chain: TwitterFetcherProvider[]) {
  const filtered = chain.filter((item) => item === '6551' || item === 'xread');
  return filtered.length > 0 ? filtered.join(' -> ') : '6551/xread';
}

function buildRateKey(input: NotifyTwitterProviderFailuresInput) {
  const handles = Array.from(new Set(input.failures.map((item) => normalize(item.handle).toLowerCase()).filter(Boolean)))
    .sort()
    .slice(0, 20)
    .join(',');
  return `twitter-provider-failure|structured|${handles || 'unknown'}`;
}

export function buildTwitterProviderFailureAlertMessage(input: NotifyTwitterProviderFailuresInput) {
  const failures = input.failures.slice(0, MAX_FAILURE_LINES);
  const lines = failures.map((item) => {
    return `- ${item.userName} @${item.handle} ${item.lane} (${formatProviderChain(item.providerChain)})`;
  });

  if (input.failures.length > MAX_FAILURE_LINES) {
    lines.push(`- ... 另外 ${input.failures.length - MAX_FAILURE_LINES} 个账号/lane 未展开`);
  }

  return [
    '⚠️ Twitter 结构化源抓取失败',
    `runId: ${input.runId ?? 'unknown'}`,
    `失败 lane: ${input.failures.length}`,
    '6551 + Xread 均未成功返回，本轮不会自动降级 opencli/dokobot。',
    ...lines,
  ].join('\n');
}

export async function notifyTwitterProviderFailures(
  input: NotifyTwitterProviderFailuresInput,
  deps?: NotifyTwitterProviderFailuresDeps
): Promise<NotifyTwitterProviderFailuresResult> {
  if (input.failures.length === 0) {
    return {
      sent: false,
      reason: 'no-failures',
      failureCount: 0,
    };
  }

  const config = deps?.readConfig ? deps.readConfig() : readSystemConfig();
  const chatId = pickAlertChatId(config);
  if (!chatId) {
    return {
      sent: false,
      reason: 'missing-chat-id',
      failureCount: input.failures.length,
    };
  }

  const rateKey = buildRateKey(input);
  const isQuotaAvailable = deps?.isQuotaAvailable || isIngestAlertQuotaAvailable;
  const markQuotaConsumed = deps?.markQuotaConsumed || markIngestAlertQuotaConsumed;
  if (!isQuotaAvailable(rateKey, ALERT_RATE_LIMIT_WINDOW_MS)) {
    return {
      sent: false,
      reason: 'rate-limited',
      failureCount: input.failures.length,
    };
  }

  const sendMessage = deps?.sendMessage || sendTelegramTextMessage;
  const result = await sendMessage({
    chatId,
    text: buildTwitterProviderFailureAlertMessage(input),
  });
  if (!result.ok) {
    return {
      sent: false,
      reason: 'telegram-request-failed',
      failureCount: input.failures.length,
    };
  }

  markQuotaConsumed(rateKey, ALERT_RATE_LIMIT_WINDOW_MS);
  return {
    sent: true,
    reason: 'sent',
    failureCount: input.failures.length,
  };
}
