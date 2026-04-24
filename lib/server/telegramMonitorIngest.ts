import 'server-only';

import { sendTelegramTextMessage } from '@/lib/server/telegramNotify';
import { upsertEventsFromFeedRows } from '@/lib/server/eventsRepo';
import { consumeIngestAlertQuota } from '@/lib/server/ingestAlertRepo';
import { projectTelegramMonitorEvent } from '@/lib/server/telegramMonitorFeed';
import { readSystemConfig } from '@/lib/server/systemConfigRepo';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import { parseXxyyTelegramText } from '@/lib/server/xxyyTelegramParser';
import { upsertTelegramMonitorEvent } from '@/lib/server/telegramMonitorRepo';
import { createTwitterFetcher } from '@/lib/server/twitterFetcher';
import {
  parseTweetIdFromUrl,
  upsertEventTweetRefAndFetchMissing,
} from '@/lib/server/twitterLinkRefs';

function getMonitorAuthConfig() {
  const relayToken = process.env.TELEGRAM_MONITOR_INGEST_TOKEN?.trim() || '';
  return {
    relayToken,
    enabled: Boolean(relayToken),
  };
}

export function authorizeTelegramMonitorHeaders(headers: Headers) {
  const config = getMonitorAuthConfig();
  if (!config.enabled) {
    return {
      ok: false as const,
      status: 503,
      body: {
        ok: false,
        error: '未配置 TELEGRAM_MONITOR_INGEST_TOKEN',
      },
    };
  }

  const authHeader = headers.get('authorization')?.trim() || '';
  const telegramSecretToken = headers.get('x-telegram-bot-api-secret-token')?.trim() || '';
  const expectedBearer = `Bearer ${config.relayToken}`;
  const matchesBearer = authHeader === expectedBearer;
  const matchesTelegramSecret = telegramSecretToken === config.relayToken;

  if (matchesBearer || matchesTelegramSecret) {
    return {
      ok: true as const,
    };
  }

  return {
    ok: false as const,
    status: 401,
    body: {
      ok: false,
      error: '鉴权失败',
    },
  };
}

interface TelegramMessageEntityLike {
  type?: string;
  url?: string;
}

interface TelegramInlineKeyboardButtonLike {
  url?: string;
}

export interface TelegramMessageLike {
  message_id?: number;
  date?: number;
  chat?: {
    id?: number | string;
  };
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntityLike[];
  caption_entities?: TelegramMessageEntityLike[];
  reply_markup?: {
    inline_keyboard?: TelegramInlineKeyboardButtonLike[][];
  };
}

export interface TelegramUpdateLike {
  update_id?: number;
  message?: TelegramMessageLike;
  channel_post?: TelegramMessageLike;
  edited_message?: TelegramMessageLike;
  edited_channel_post?: TelegramMessageLike;
}

function extractMessage(update: TelegramUpdateLike) {
  if (update.message) return update.message;
  if (update.channel_post) return update.channel_post;
  if (update.edited_message) return update.edited_message;
  if (update.edited_channel_post) return update.edited_channel_post;
  return null;
}

const INGEST_ALERT_WINDOW_MS = 5 * 60 * 1000;

async function notifyIngestFormatIssue(params: {
  source: 'telegram-monitor';
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

  const rateKey = `${params.source}|${params.sourceChatId || 'unknown'}|${params.reason}`;
  if (!consumeIngestAlertQuota(rateKey, INGEST_ALERT_WINDOW_MS)) {
    return;
  }

  const sourceRef = `${params.sourceChatId || 'unknown-chat'}:${params.sourceMessageId ?? 'unknown-message'}`;
  const text = [
    '⚠️ 拒收一条监控消息（格式/来源校验未通过）',
    `来源: ${params.source}`,
    `原因: ${params.reason}`,
    `消息定位: ${sourceRef}`,
    `预览: ${params.previewText.slice(0, 180) || '(empty)'}`,
  ].join('\n');

  await sendTelegramTextMessage({ chatId, text });
}

function collectMessageLinks(message: TelegramMessageLike) {
  const links = new Set<string>();
  const entities = [...(message.entities || []), ...(message.caption_entities || [])];

  for (const entity of entities) {
    if (entity.type === 'text_link' && typeof entity.url === 'string' && entity.url.trim()) {
      links.add(entity.url.trim());
    }
  }

  for (const row of message.reply_markup?.inline_keyboard || []) {
    for (const button of row || []) {
      if (typeof button?.url === 'string' && button.url.trim()) {
        links.add(button.url.trim());
      }
    }
  }

  return Array.from(links);
}

function normalizeAlias(value: string | null | undefined) {
  return (value || '')
    .trim()
    .toLowerCase()
    .replace(/#/g, '');
}

function isEvmChain(chain: string | null | undefined) {
  return chain === 'bsc' || chain === 'ethereum' || chain === 'base';
}

function isCompatibleChain(addressChain: string, eventChain: string) {
  if (addressChain === eventChain) {
    return true;
  }
  return isEvmChain(addressChain) && isEvmChain(eventChain);
}

function hasTrackedUserMatch(parsed: {
  chain: string | null;
  walletAliasLabel: string | null;
  walletLabel: string | null;
  trackedWalletAddress: string | null;
}) {
  if (!parsed.chain) {
    return false;
  }

  const users = listTrackedUsers();
  const chain = parsed.chain;
  const trackedWalletAddress = (parsed.trackedWalletAddress || '').trim().toLowerCase();
  const aliasLabel = normalizeAlias(parsed.walletAliasLabel || parsed.walletLabel);

  for (const user of users) {
    for (const address of user.addresses) {
      if (!isCompatibleChain(address.chain, chain)) continue;

      if (trackedWalletAddress && address.address.trim().toLowerCase() === trackedWalletAddress) {
        return true;
      }

      if (aliasLabel) {
        const userAlias = normalizeAlias(user.name);
        const addressAlias = normalizeAlias(address.name);
        if (aliasLabel === `${userAlias}${addressAlias}` || aliasLabel === addressAlias || aliasLabel === userAlias) {
          return true;
        }
      }
    }
  }

  return false;
}

async function notifyUnknownTrackedUser(params: {
  parsed: {
    walletAliasLabel: string | null;
    walletLabel: string | null;
    trackedWalletAddress: string | null;
    tokenSymbol: string | null;
    tokenAddress: string | null;
    chain: string | null;
  };
  sourceChatId: string | null;
  sourceMessageId: number | null;
}) {
  const config = readSystemConfig();
  const chatId = config.telegramUnknownPersonAlertChatId;
  if (!chatId) {
    return;
  }

  const person = params.parsed.walletAliasLabel || params.parsed.walletLabel || '未知人物';
  const tracked = params.parsed.trackedWalletAddress || '未知地址';
  const token = params.parsed.tokenSymbol || params.parsed.tokenAddress || '未知Token';
  const chain = params.parsed.chain || 'unknown';
  const source = `${params.sourceChatId || 'unknown-chat'}:${params.sourceMessageId ?? 'unknown-message'}`;

  const text = [
    '⚠️ 拒收一条 XXYY 监控消息（人物未在 pilipili 中）',
    `人物: ${person}`,
    `链: ${chain}`,
    `钱包: ${tracked}`,
    `Token: ${token}`,
    `来源: ${source}`,
    '请去 xxyy 取消该人物跟踪。',
  ].join('\n');

  await sendTelegramTextMessage({ chatId, text });
}

export async function ingestTelegramMonitorUpdate(body: TelegramUpdateLike) {
  const message = extractMessage(body);
  if (!message) {
    return { ok: true, ignored: true, reason: 'no-message' as const };
  }

  const text =
    (typeof message.text === 'string' && message.text.trim()) ||
    (typeof message.caption === 'string' && message.caption.trim()) ||
    '';

  if (!text) {
    return { ok: true, ignored: true, reason: 'empty-text' as const };
  }

  const sourceChatId = message.chat?.id ? String(message.chat.id) : null;
  const sourceMessageId = typeof message.message_id === 'number' ? message.message_id : null;
  const config = readSystemConfig();
  const allowedChatId = config.telegramTradeMonitorSourceChatId?.trim() || '';
  if (!allowedChatId) {
    await notifyIngestFormatIssue({
      source: 'telegram-monitor',
      reason: 'missing-monitor-chat-config',
      sourceChatId,
      sourceMessageId,
      previewText: text,
    });
    return { ok: true, ignored: true, reason: 'missing-monitor-chat-config' as const };
  }

  if (!sourceChatId || sourceChatId !== allowedChatId) {
    return { ok: true, ignored: true, reason: 'chat-not-allowed' as const };
  }

  const messageLinks = collectMessageLinks(message);
  const parsed = parseXxyyTelegramText(
    text,
    typeof message.date === 'number' ? message.date * 1000 : Date.now(),
    messageLinks
  );

  if (!parsed.chain || !parsed.tokenAddress || !parsed.action) {
    await notifyIngestFormatIssue({
      source: 'telegram-monitor',
      reason: 'invalid-trade-format',
      sourceChatId,
      sourceMessageId,
      previewText: text,
    });
    return { ok: true, ignored: true, reason: 'invalid-trade-format' as const };
  }

  if (!hasTrackedUserMatch(parsed)) {
    await notifyUnknownTrackedUser({
      parsed,
      sourceChatId,
      sourceMessageId,
    });

    return {
      ok: true,
      ignored: true,
      reason: 'unknown-tracked-user' as const,
      parsed: {
        chain: parsed.chain,
        walletLabel: parsed.walletLabel,
        walletAliasLabel: parsed.walletAliasLabel,
        trackedWalletAddress: parsed.trackedWalletAddress,
      },
    };
  }

  const eventTimeMs = parsed.eventTimeMs ?? (typeof message.date === 'number' ? message.date * 1000 : Date.now());
  const saved = upsertTelegramMonitorEvent({
    provider: 'xxyy',
    sourceChatId,
    sourceMessageId,
    updateId: typeof body.update_id === 'number' ? body.update_id : null,
    chain: parsed.chain,
    tokenAddress: parsed.tokenAddress,
    tokenSymbol: parsed.tokenSymbol,
    txHash: parsed.txHash,
    marketCapUsd: parsed.marketCapUsd,
    priceUsd: parsed.priceUsd,
    quoteAmount: parsed.quoteAmount,
    quoteSymbol: parsed.quoteSymbol,
    action: parsed.action,
    actionLabel: parsed.actionLabel,
    actionVariant: parsed.actionVariant,
    walletLabel: parsed.walletLabel,
    walletGroupLabel: parsed.walletGroupLabel,
    walletAliasLabel: parsed.walletAliasLabel,
    trackedWalletAddress: parsed.trackedWalletAddress,
    eventTimeMs,
    rawText: text,
    messageLinks,
    payload: body as unknown as Record<string, unknown>,
  });

  if (!saved.ok) {
    throw new Error(`telegram monitor event save failed: ${saved.reason}`);
  }

  const projected = await projectTelegramMonitorEvent({
    event: {
      chain: parsed.chain,
      tokenAddress: parsed.tokenAddress,
      tokenSymbol: parsed.tokenSymbol,
      txHash: parsed.txHash,
      marketCapUsd: parsed.marketCapUsd,
      priceUsd: parsed.priceUsd,
      quoteAmount: parsed.quoteAmount,
      quoteSymbol: parsed.quoteSymbol,
      action: parsed.action,
      actionLabel: parsed.actionLabel,
      actionVariant: parsed.actionVariant,
      walletLabel: parsed.walletLabel,
      walletGroupLabel: parsed.walletGroupLabel,
      walletAliasLabel: parsed.walletAliasLabel,
      trackedWalletAddress: parsed.trackedWalletAddress,
      eventTimeMs,
      rawText: text,
      updatedAt: Date.now(),
    },
  });

  if (projected) {
    upsertEventsFromFeedRows([projected], 'telegram-monitor-ingest');
    const tweetUrls = messageLinks.filter((item) => Boolean(parseTweetIdFromUrl(item)));
    if (tweetUrls.length > 0) {
      await upsertEventTweetRefAndFetchMissing({
        eventId: projected.activity.id,
        tweetUrls,
        refSource: 'telegram-monitor',
        fetchTweetsByIds: async (ids) => {
          const fetcher = createTwitterFetcher();
          return fetcher.fetchTweetsByIds({ ids, intent: 'detail' });
        },
      });
    }
  }

  return {
    ok: true,
    saved,
    projected: Boolean(projected),
    parsed: {
      chain: parsed.chain,
      tokenAddress: parsed.tokenAddress,
      txHash: parsed.txHash,
      marketCapUsd: parsed.marketCapUsd,
      action: parsed.action,
      actionLabel: parsed.actionLabel,
      actionVariant: parsed.actionVariant,
      walletLabel: parsed.walletLabel,
      walletGroupLabel: parsed.walletGroupLabel,
      walletAliasLabel: parsed.walletAliasLabel,
      trackedWalletAddress: parsed.trackedWalletAddress,
    },
  };
}
