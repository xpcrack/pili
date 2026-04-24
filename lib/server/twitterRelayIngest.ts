import 'server-only';

import { consumeIngestAlertQuota } from '@/lib/server/ingestAlertRepo';
import { projectTwitterTweetsToFeed } from '@/lib/server/twitterFeedMapper';
import { readSystemConfig } from '@/lib/server/systemConfigRepo';
import { sendTelegramTextMessage } from '@/lib/server/telegramNotify';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import { upsertTwitterTweets, type UpsertTwitterTweetInput } from '@/lib/server/twitterRepo';
import { normalizeTwitterHandle } from '@/lib/userProfile';

export interface TwitterRelayPayload {
  tweetId?: string;
  action?: 'tweet' | 'quote' | 'reply' | string;
  content?: string;
  url?: string;
  authorHandle?: string;
  createdAtMs?: number;
  sourceChatId?: string | number;
  messageId?: number | null;
}

function normalize(value: string | undefined | null) {
  return (value || '').trim().toLowerCase();
}

function parseTweetId(input: TwitterRelayPayload) {
  const fromPayload = (input.tweetId || '').trim();
  if (fromPayload) return fromPayload;
  const text = (input.url || '').trim();
  const m = text.match(/status\/(\d+)/i);
  return m?.[1] || '';
}

const INGEST_ALERT_WINDOW_MS = 5 * 60 * 1000;

function isDigitsOnly(value: string) {
  return /^\d+$/.test(value);
}

function isValidTwitterHandle(value: string) {
  return /^[A-Za-z0-9_]{1,15}$/.test(value);
}

function parseTweetIdFromUrl(urlText: string) {
  const text = (urlText || '').trim();
  if (!text) {
    return '';
  }

  try {
    const url = new URL(text);
    if (!/^x\.com$/i.test(url.hostname) && !/^twitter\.com$/i.test(url.hostname)) {
      return '';
    }
  } catch {
    return '';
  }

  const m = text.match(/\/(?:i\/)?status\/(\d+)/i);
  return m?.[1] || '';
}

async function notifyTwitterRelayIssue(params: {
  reason: string;
  sourceChatId: string | null;
  sourceMessageId: number | null;
  previewText: string;
}) {
  const config = readSystemConfig();
  const chatId = config.telegramUnknownPersonAlertChatId?.trim() || '';
  if (!chatId) {
    return;
  }

  const rateKey = `twitter-relay|${params.sourceChatId || 'unknown'}|${params.reason}`;
  if (!consumeIngestAlertQuota(rateKey, INGEST_ALERT_WINDOW_MS)) {
    return;
  }

  const sourceRef = `${params.sourceChatId || 'unknown-chat'}:${params.sourceMessageId ?? 'unknown-message'}`;
  const text = [
    '⚠️ 拒收一条推特 relay 消息（格式/来源校验未通过）',
    '来源: twitter-relay',
    `原因: ${params.reason}`,
    `消息定位: ${sourceRef}`,
    `预览: ${params.previewText.slice(0, 180) || '(empty)'}`,
  ].join('\n');

  await sendTelegramTextMessage({ chatId, text });
}

export function authorizeTwitterRelayHeaders(headers: Headers) {
  const expectedToken =
    process.env.TWITTER_RELAY_INGEST_TOKEN?.trim() || process.env.TELEGRAM_MONITOR_INGEST_TOKEN?.trim() || '';
  if (!expectedToken) {
    return {
      ok: false as const,
      status: 503,
      body: { ok: false, error: 'missing TWITTER_RELAY_INGEST_TOKEN' },
    };
  }

  const auth = headers.get('authorization')?.trim() || '';
  const token = auth.startsWith('Bearer ')
    ? auth.slice('Bearer '.length).trim()
    : headers.get('x-telegram-bot-api-secret-token')?.trim() || '';

  if (token === expectedToken) {
    return { ok: true as const };
  }

  return {
    ok: false as const,
    status: 401,
    body: { ok: false, error: 'unauthorized' },
  };
}

export async function ingestTwitterRelayPayload(payload: TwitterRelayPayload) {
  const config = readSystemConfig();
  const allowedChatId = config.telegramTwitterMonitorSourceChatId?.trim() || '';
  const sourceMessageId = typeof payload.messageId === 'number' ? payload.messageId : null;
  const sourceChatId = String(payload.sourceChatId || '').trim();
  if (!allowedChatId) {
    await notifyTwitterRelayIssue({
      reason: 'missing-monitor-chat-config',
      sourceChatId: sourceChatId || null,
      sourceMessageId,
      previewText: (payload.content || payload.url || '').trim(),
    });
    return { ok: true, ignored: true, reason: 'missing-monitor-chat-config' as const };
  }

  if (!sourceChatId || sourceChatId !== allowedChatId) {
    return { ok: true, ignored: true, reason: 'chat-not-allowed' as const };
  }

  const tweetId = parseTweetId(payload);
  const fullText = (payload.content || '').trim();
  const authorHandle = normalizeTwitterHandle(payload.authorHandle || '');

  const normalizedAuthorHandle = normalize(authorHandle);
  const urlTweetId = parseTweetIdFromUrl(payload.url || '');
  const hasInvalidUrlTweetRef = Boolean((payload.url || '').trim()) && (!urlTweetId || (tweetId && urlTweetId !== tweetId));
  if (
    !tweetId ||
    !isDigitsOnly(tweetId) ||
    !fullText ||
    !normalizedAuthorHandle ||
    !isValidTwitterHandle(normalizedAuthorHandle) ||
    hasInvalidUrlTweetRef
  ) {
    await notifyTwitterRelayIssue({
      reason: 'invalid-twitter-format',
      sourceChatId,
      sourceMessageId,
      previewText: `${payload.authorHandle || ''} ${fullText}`.trim(),
    });
    return { ok: true, ignored: true, reason: 'invalid-twitter-format' as const };
  }

  const lane = payload.action === 'reply' ? 'replies' : 'timeline';

  const users = listTrackedUsers();
  const knownTwitterHandles = new Set(
    users.map((user) => normalizeTwitterHandle(user.twitter || '')).filter((value): value is string => Boolean(value)).map(normalize)
  );
  if (!knownTwitterHandles.has(normalizedAuthorHandle)) {
    await notifyTwitterRelayIssue({
      reason: 'invalid-twitter-format',
      sourceChatId,
      sourceMessageId,
      previewText: `${payload.authorHandle || ''} ${fullText}`.trim(),
    });
    return { ok: true, ignored: true, reason: 'invalid-twitter-format' as const };
  }

  const createdAtMs = Number.isFinite(payload.createdAtMs) ? Math.floor(payload.createdAtMs as number) : Date.now();
  const input: UpsertTwitterTweetInput = {
    tweetId,
    authorHandle: normalizedAuthorHandle,
    fullText,
    createdAtMs,
    lane,
    source: {
      provider: 'bot2bot',
      sourceChatId: sourceChatId || null,
      messageId: sourceMessageId,
      action: payload.action || null,
      url: payload.url || null,
    },
  };

  const stored = upsertTwitterTweets([input]);
  const projected = projectTwitterTweetsToFeed({
    sinceMs: Math.max(0, createdAtMs - 24 * 60 * 60 * 1000),
    tweetIds: [tweetId],
  });

  return {
    ok: true,
    storedCount: stored.storedCount,
    projectedCount: projected.projectedCount,
    tweetId,
  };
}
