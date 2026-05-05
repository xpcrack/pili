import 'server-only';

import bigInt from 'big-integer';
import { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import { StringSession } from 'telegram/sessions';

import { readTelegramClientConfig } from '@/lib/server/telegramClientConfig';
import { readTelegramMtprotoPolicy } from '@/lib/server/telegramMtprotoPolicy';
import type {
  TelegramAgentReadItem,
  TelegramBridgeHistoryPage,
  TelegramChannelHistoryPage,
  TelegramChannelRemoteMessage,
  TelegramChannelResolveInput,
  TelegramChannelResolved,
  TelegramChannelSyncClient,
  TelegramChannelSource,
} from '@/lib/server/telegramChannelTypes';
import type { TelegramMessageEntityLike, TelegramMessageLike } from '@/scripts/telegram-bridge-core';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeIdLike(value: unknown): string | null {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  return normalizeString(value) || null;
}

function readTelegramDateSeconds(value: unknown) {
  if (value instanceof Date) {
    return Math.floor(value.getTime() / 1000);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  return Math.floor(Date.now() / 1000);
}

function buildTelegramSenderDisplayName(sender: Record<string, unknown>) {
  const firstName = normalizeString(sender.firstName);
  const lastName = normalizeString(sender.lastName);
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
  if (fullName) {
    return fullName;
  }
  return normalizeString(sender.title) || normalizeString(sender.username) || null;
}

function readTelegramRpcErrorCode(record: Record<string, unknown>) {
  const numericCodeCandidates = [record.errorCode, record.error_code, record.code];
  for (const candidate of numericCodeCandidates) {
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) {
      return candidate;
    }
    if (typeof candidate === 'string' && /^\d{3}$/.test(candidate.trim())) {
      return Number(candidate.trim());
    }
  }

  const messageCandidates = [record.message, record.errorMessage, record.error];
  for (const candidate of messageCandidates) {
    const message = normalizeString(candidate);
    if (!message) {
      continue;
    }
    const codeMatch = message.match(/\b([345]\d{2})\b/);
    if (codeMatch) {
      return Number(codeMatch[1]);
    }
  }
  return null;
}

function extractUnsupportedSearchRpcSignature(record: Record<string, unknown>) {
  const messageCandidates = [record.errorMessage, record.error, record.message];
  for (const candidate of messageCandidates) {
    const message = normalizeString(candidate);
    if (!message) {
      continue;
    }
    const rpcTokens = message.toUpperCase().match(/\b[A-Z][A-Z0-9_]{2,}\b/g) || [];
    const unsupportedToken = rpcTokens.find(
      (token) => /^SEARCH(?:_[A-Z0-9]+)*_(?:NOT_SUPPORTED|UNSUPPORTED)$/.test(token)
    );
    if (unsupportedToken) {
      return unsupportedToken;
    }
  }
  return null;
}

export function isUnsupportedTelegramSearchError(error: unknown) {
  const record = asRecord(error);
  if (!record) {
    return false;
  }

  const rpcErrorCode = readTelegramRpcErrorCode(record);
  if (rpcErrorCode !== 400) {
    return false;
  }

  return Boolean(extractUnsupportedSearchRpcSignature(record));
}

export function shouldUseTelegramSearchFallback(error: unknown): boolean {
  return isUnsupportedTelegramSearchError(error);
}

export function assertTelegramSearchFallbackOrThrow(error: unknown): void {
  if (!shouldUseTelegramSearchFallback(error)) {
    throw error;
  }
}

function collectUrlsFromText(text: string) {
  const urls = new Set<string>();
  const matches = text.match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  for (const match of matches) {
    const trimmed = match.trim();
    if (trimmed) {
      urls.add(trimmed);
    }
  }
  return urls;
}

function collectUrlsFromEntities(text: string, entities: unknown[]) {
  const urls = new Set<string>();
  for (const entity of entities) {
    const record = asRecord(entity);
    const textUrl = normalizeString(record?.url);
    if (textUrl) {
      urls.add(textUrl);
      continue;
    }

    const offset = typeof record?.offset === 'number' && Number.isFinite(record.offset) ? record.offset : null;
    const length = typeof record?.length === 'number' && Number.isFinite(record.length) ? record.length : null;
    if (offset === null || length === null || length <= 0) {
      continue;
    }

    const extracted = text.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, length)).trim();
    if (/^https?:\/\//i.test(extracted)) {
      urls.add(extracted);
    }
  }
  return urls;
}

function collectUrlsFromReplyMarkup(replyMarkup: unknown) {
  const urls = new Set<string>();
  const rows = Array.isArray(asRecord(replyMarkup)?.rows) ? (asRecord(replyMarkup)?.rows as unknown[]) : [];
  for (const row of rows) {
    const buttons = Array.isArray(asRecord(row)?.buttons) ? (asRecord(row)?.buttons as unknown[]) : [];
    for (const button of buttons) {
      const url = normalizeString(asRecord(button)?.url);
      if (url) {
        urls.add(url);
      }
    }
  }
  return urls;
}

function mapEntities(entities: unknown[]): TelegramMessageEntityLike[] {
  const result: TelegramMessageEntityLike[] = [];
  for (const entity of entities) {
    const record = asRecord(entity);
    if (!record) {
      continue;
    }
    const className = normalizeString(record.className).toLowerCase();
    let type = '';
    if (className.includes('messageentitytexturl')) {
      type = 'text_link';
    } else if (className.includes('messageentityurl')) {
      type = 'url';
    } else {
      continue;
    }
    result.push({
      type,
      url: normalizeString(record.url) || undefined,
      offset: typeof record.offset === 'number' && Number.isFinite(record.offset) ? Math.floor(record.offset) : undefined,
      length: typeof record.length === 'number' && Number.isFinite(record.length) ? Math.floor(record.length) : undefined,
    });
  }
  return result;
}

function mapInlineKeyboard(replyMarkup: unknown) {
  const rows = Array.isArray(asRecord(replyMarkup)?.rows) ? (asRecord(replyMarkup)?.rows as unknown[]) : [];
  const inlineKeyboard: Array<Array<{ text?: string; url?: string }>> = [];
  for (const row of rows) {
    const buttons = Array.isArray(asRecord(row)?.buttons) ? (asRecord(row)?.buttons as unknown[]) : [];
    const nextRow: Array<{ text?: string; url?: string }> = [];
    for (const button of buttons) {
      const record = asRecord(button);
      const url = normalizeString(record?.url);
      const text = normalizeString(record?.text);
      if (!url && !text) {
        continue;
      }
      nextRow.push({
        text: text || undefined,
        url: url || undefined,
      });
    }
    if (nextRow.length > 0) {
      inlineKeyboard.push(nextRow);
    }
  }
  return inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined;
}

function summarizeMedia(message: Record<string, unknown>) {
  const media: string[] = [];
  if (message.photo) media.push('photo');
  if (message.video) media.push('video');
  if (message.voice) media.push('voice');
  if (message.audio) media.push('audio');
  if (message.document) media.push('document');
  return media;
}

function summarizeReplyMarkup(replyMarkup: unknown) {
  const rows = Array.isArray(asRecord(replyMarkup)?.rows) ? (asRecord(replyMarkup)?.rows as unknown[]) : [];
  return rows.map((row) => {
    const buttons = Array.isArray(asRecord(row)?.buttons) ? (asRecord(row)?.buttons as unknown[]) : [];
    return {
      buttons: buttons
        .map((button) => {
          const record = asRecord(button);
          const text = normalizeString(record?.text) || null;
          const url = normalizeString(record?.url) || null;
          if (!text && !url) {
            return null;
          }
          return {
            text,
            url,
          };
        })
        .filter((button): button is { text: string | null; url: string | null } => Boolean(button)),
    };
  });
}

function summarizeForwardInfo(forward: unknown) {
  const record = asRecord(forward);
  if (!record) {
    return null;
  }

  return {
    date: typeof record.date === 'number' ? record.date : null,
    fromName: normalizeString(record.fromName) || null,
    savedFromMsgId:
      typeof record.savedFromMsgId === 'number' && Number.isFinite(record.savedFromMsgId)
        ? record.savedFromMsgId
        : null,
  };
}

function normalizeChatIdToChannelId(chatId: string | null | undefined) {
  const trimmed = normalizeString(chatId);
  if (!trimmed) {
    return null;
  }
  if (/^-100\d+$/.test(trimmed)) {
    return trimmed.slice(4);
  }
  if (/^-?\d+$/.test(trimmed)) {
    return trimmed.replace(/^-/, '');
  }
  return null;
}

export function buildTelegramChannelEntityRef(input: TelegramChannelResolveInput) {
  const channelId = normalizeChatIdToChannelId(input.channelChatId);
  const accessHash = normalizeString(input.accessHash);
  if (channelId && accessHash && /^\d+$/.test(channelId) && /^-?\d+$/.test(accessHash)) {
    return new Api.InputPeerChannel({
      channelId: bigInt(channelId),
      accessHash: bigInt(accessHash),
    });
  }

  const username = normalizeString(input.channelUsername);
  if (username) {
    return `@${username.replace(/^@+/, '')}`;
  }

  return input.channelRef;
}

export function mapTelegramMessageToRemoteMessage(message: Record<string, unknown>): TelegramChannelRemoteMessage | null {
  const messageId = typeof message.id === 'number' && Number.isFinite(message.id) ? Math.floor(message.id) : 0;
  if (messageId <= 0) {
    return null;
  }

  const text = normalizeString(message.text) || normalizeString(message.message);
  const textEntities = Array.isArray(message.entities) ? (message.entities as unknown[]) : [];
  const linkUrls = new Set<string>();
  for (const url of collectUrlsFromText(text)) {
    linkUrls.add(url);
  }
  for (const url of collectUrlsFromEntities(text, textEntities)) {
    linkUrls.add(url);
  }
  for (const url of collectUrlsFromReplyMarkup(message.replyMarkup)) {
    linkUrls.add(url);
  }

  const rawDate = message.date;
  const rawEditDate = message.editDate;
  const postedAtMs =
    rawDate instanceof Date
      ? rawDate.getTime()
      : typeof rawDate === 'number' && Number.isFinite(rawDate)
        ? Math.floor(rawDate) * 1000
        : Date.now();
  const editDateMs =
    rawEditDate instanceof Date
      ? rawEditDate.getTime()
      : typeof rawEditDate === 'number' && Number.isFinite(rawEditDate)
        ? Math.floor(rawEditDate) * 1000
        : null;
  const repliesRecord = asRecord(message.replies);

  return {
    messageId,
    groupedId:
      typeof message.groupedId === 'bigint'
        ? message.groupedId.toString()
        : normalizeString(message.groupedId) || null,
    postedAtMs,
    editDateMs,
    text,
    textEntities,
    media: summarizeMedia(message),
    linkUrls: Array.from(linkUrls.values()),
    forwardInfo: summarizeForwardInfo(message.fwdFrom),
    views: typeof message.views === 'number' && Number.isFinite(message.views) ? Math.floor(message.views) : null,
    forwards:
      typeof message.forwards === 'number' && Number.isFinite(message.forwards) ? Math.floor(message.forwards) : null,
    replies:
      typeof repliesRecord?.replies === 'number' && Number.isFinite(repliesRecord.replies)
        ? Math.floor(repliesRecord.replies)
        : null,
    raw: {
      id: messageId,
      text,
      date: postedAtMs,
      editDate: editDateMs,
      groupedId:
        typeof message.groupedId === 'bigint'
          ? message.groupedId.toString()
          : normalizeString(message.groupedId) || null,
      views: typeof message.views === 'number' ? message.views : null,
      forwards: typeof message.forwards === 'number' ? message.forwards : null,
      replies:
        typeof repliesRecord?.replies === 'number' && Number.isFinite(repliesRecord.replies)
          ? Math.floor(repliesRecord.replies)
          : null,
      entities: textEntities,
      replyMarkup: {
        rows: summarizeReplyMarkup(message.replyMarkup),
      },
      forwardInfo: summarizeForwardInfo(message.fwdFrom),
      media: summarizeMedia(message),
    },
  };
}

export function mapTelegramMessageToAgentReadItem(message: Record<string, unknown>): TelegramAgentReadItem | null {
  const messageId = typeof message.id === 'number' && Number.isFinite(message.id) ? Math.floor(message.id) : 0;
  if (messageId <= 0) {
    return null;
  }

  const senderRecord = asRecord(message.sender);
  const fromIdRecord = asRecord(message.fromId);
  const senderId =
    normalizeIdLike(senderRecord?.id) ||
    normalizeIdLike(fromIdRecord?.userId) ||
    normalizeIdLike(fromIdRecord?.channelId) ||
    normalizeIdLike(fromIdRecord?.chatId);
  const senderUsername = senderRecord ? normalizeString(senderRecord.username) || null : null;
  const senderDisplayName = senderRecord ? buildTelegramSenderDisplayName(senderRecord) : null;
  const sender =
    senderId || senderUsername || senderDisplayName
      ? {
          id: senderId,
          username: senderUsername,
          displayName: senderDisplayName,
        }
      : null;

  return {
    messageId,
    date: readTelegramDateSeconds(message.date),
    text: normalizeString(message.text) || normalizeString(message.message),
    sender,
  };
}

function toBridgeMessage(chatId: string, message: Record<string, unknown>): TelegramMessageLike | null {
  const messageId = typeof message.id === 'number' && Number.isFinite(message.id) ? Math.floor(message.id) : 0;
  if (messageId <= 0) {
    return null;
  }

  const text = normalizeString(message.text) || normalizeString(message.message);
  const date =
    message.date instanceof Date
      ? Math.floor(message.date.getTime() / 1000)
      : typeof message.date === 'number' && Number.isFinite(message.date)
        ? Math.floor(message.date)
        : Math.floor(Date.now() / 1000);

  const entities = Array.isArray(message.entities) ? mapEntities(message.entities as unknown[]) : [];
  const replyMarkup = mapInlineKeyboard(message.replyMarkup);

  return {
    message_id: messageId,
    date,
    chat: {
      id: chatId,
      type: 'supergroup',
      title: normalizeString(asRecord(message.peerId)?.title) || undefined,
    },
    text: text || undefined,
    entities: entities.length > 0 ? entities : undefined,
    reply_markup: replyMarkup,
  };
}

function resolveHistoryPageBoundary(input: {
  requestedLimit: number;
  oldestScannedMessageId: number | null;
  oldestScannedMessageTimeMs: number | null;
  scannedCount: number;
}) {
  const reachedHistoryBoundary = input.scannedCount < input.requestedLimit;
  return {
    oldestScannedMessageId: input.oldestScannedMessageId,
    oldestScannedMessageTimeMs: input.oldestScannedMessageTimeMs,
    reachedHistoryBoundary,
    nextBeforeMessageId:
      reachedHistoryBoundary || input.oldestScannedMessageId === null ? null : input.oldestScannedMessageId,
  };
}

export async function createTelegramGramjsClient(): Promise<TelegramChannelSyncClient> {
  const config = readTelegramClientConfig();
  const policy = readTelegramMtprotoPolicy();
  if (config.status === 'missing_credentials') {
    throw new Error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH');
  }
  if (config.status === 'auth_required' || !config.sessionString) {
    throw new Error('Telegram user session required. Run telegram-channel-login first.');
  }

  const client = new TelegramClient(new StringSession(config.sessionString), config.apiId, config.apiHash, {
    connectionRetries: 5,
    floodSleepThreshold: policy.floodSleepThresholdSec,
  });
  await client.connect();

  if (!(await client.checkAuthorization())) {
    await client.disconnect();
    throw new Error('Telegram session is not authorized.');
  }

  return {
    async resolveChannel(input: TelegramChannelResolveInput): Promise<TelegramChannelResolved> {
      const entityRef = buildTelegramChannelEntityRef(input);
      const entity = (await client.getEntity(entityRef)) as unknown as Record<string, unknown>;
      const peerId = await client.getPeerId(entity as never);
      return {
        channelChatId: String(peerId),
        channelUsername: normalizeString(entity.username) || null,
        channelTitle: normalizeString(entity.title) || normalizeString(entity.firstName) || null,
        accessHash:
          typeof entity.accessHash === 'bigint'
            ? entity.accessHash.toString()
            : normalizeString(entity.accessHash) || null,
      };
    },
    async listChannelMessages(params: {
      source: TelegramChannelSource;
      resolved: TelegramChannelResolved;
      minMessageId: number | null;
      limit?: number;
    }) {
      const entityRef = buildTelegramChannelEntityRef({
        channelRef: params.source.channelRef,
        channelUsername: params.resolved.channelUsername || params.source.channelUsername,
        channelChatId: params.resolved.channelChatId || params.source.channelChatId,
        accessHash: params.resolved.accessHash || params.source.accessHash,
      });
      const results: TelegramChannelRemoteMessage[] = [];

      for await (const message of client.iterMessages(entityRef, {
        limit: params.limit || 50,
        minId: params.minMessageId || 0,
      })) {
        const mapped = mapTelegramMessageToRemoteMessage(message as unknown as Record<string, unknown>);
        if (mapped) {
          results.push(mapped);
        }
      }

      return results.sort((left, right) => left.messageId - right.messageId);
    },
    async listChannelHistoryPage(params: {
      source: TelegramChannelSource;
      resolved: TelegramChannelResolved;
      beforeMessageId?: number | null;
      startMs?: number | null;
      endMs?: number | null;
      limit?: number;
    }): Promise<TelegramChannelHistoryPage> {
      const entityRef = buildTelegramChannelEntityRef({
        channelRef: params.source.channelRef,
        channelUsername: params.resolved.channelUsername || params.source.channelUsername,
        channelChatId: params.resolved.channelChatId || params.source.channelChatId,
        accessHash: params.resolved.accessHash || params.source.accessHash,
      });
      const requestedLimit = params.limit || 50;
      const results: TelegramChannelRemoteMessage[] = [];
      let scannedCount = 0;
      let oldestScannedMessageId: number | null = null;
      let oldestScannedMessageTimeMs: number | null = null;

      for await (const message of client.iterMessages(entityRef, {
        limit: requestedLimit,
        maxId:
          typeof params.beforeMessageId === 'number' && Number.isFinite(params.beforeMessageId) && params.beforeMessageId > 0
            ? Math.max(0, Math.floor(params.beforeMessageId) - 1)
            : undefined,
      })) {
        scannedCount += 1;
        const mapped = mapTelegramMessageToRemoteMessage(message as unknown as Record<string, unknown>);
        if (!mapped) {
          continue;
        }
        if (typeof params.endMs === 'number' && Number.isFinite(params.endMs) && mapped.postedAtMs > params.endMs) {
          continue;
        }
        results.push(mapped);
        oldestScannedMessageId = oldestScannedMessageId === null ? mapped.messageId : Math.min(oldestScannedMessageId, mapped.messageId);
        oldestScannedMessageTimeMs =
          oldestScannedMessageTimeMs === null ? mapped.postedAtMs : Math.min(oldestScannedMessageTimeMs, mapped.postedAtMs);
      }

      const boundary = resolveHistoryPageBoundary({
        requestedLimit,
        oldestScannedMessageId,
        oldestScannedMessageTimeMs,
        scannedCount,
      });
      return {
        messages: results.sort((left, right) => left.messageId - right.messageId),
        ...boundary,
      };
    },
    async listBridgeChatMessages(params: { chatId: string; limit: number }) {
      const results: TelegramMessageLike[] = [];
      await client.getDialogs({
        limit: 1000,
      });
      const entity = await client.getEntity(params.chatId);
      for await (const message of client.iterMessages(entity, {
        limit: params.limit,
      })) {
        const mapped = toBridgeMessage(params.chatId, message as unknown as Record<string, unknown>);
        if (mapped) {
          results.push(mapped);
        }
      }
      return results.sort((left, right) => (left.message_id || 0) - (right.message_id || 0));
    },
    async listBridgeChatHistoryPage(params: {
      chatId: string;
      beforeMessageId?: number | null;
      startMs?: number | null;
      endMs?: number | null;
      limit: number;
    }): Promise<TelegramBridgeHistoryPage> {
      const results: TelegramMessageLike[] = [];
      let scannedCount = 0;
      let oldestScannedMessageId: number | null = null;
      let oldestScannedMessageTimeMs: number | null = null;
      await client.getDialogs({
        limit: 1000,
      });
      const entity = await client.getEntity(params.chatId);
      for await (const message of client.iterMessages(entity, {
        limit: params.limit,
        maxId:
          typeof params.beforeMessageId === 'number' && Number.isFinite(params.beforeMessageId) && params.beforeMessageId > 0
            ? Math.max(0, Math.floor(params.beforeMessageId) - 1)
            : undefined,
      })) {
        scannedCount += 1;
        const mapped = toBridgeMessage(params.chatId, message as unknown as Record<string, unknown>);
        if (!mapped) {
          continue;
        }
        const messageTimeMs =
          typeof mapped.date === 'number' && Number.isFinite(mapped.date) ? Math.floor(mapped.date) * 1000 : null;
        if (typeof params.endMs === 'number' && Number.isFinite(params.endMs) && messageTimeMs !== null && messageTimeMs > params.endMs) {
          continue;
        }
        results.push(mapped);
        const mappedMessageId =
          typeof mapped.message_id === 'number' && Number.isFinite(mapped.message_id) ? Math.floor(mapped.message_id) : null;
        if (mappedMessageId !== null) {
          oldestScannedMessageId =
            oldestScannedMessageId === null ? mappedMessageId : Math.min(oldestScannedMessageId, mappedMessageId);
        }
        if (messageTimeMs !== null) {
          oldestScannedMessageTimeMs =
            oldestScannedMessageTimeMs === null ? messageTimeMs : Math.min(oldestScannedMessageTimeMs, messageTimeMs);
        }
      }

      const boundary = resolveHistoryPageBoundary({
        requestedLimit: params.limit,
        oldestScannedMessageId,
        oldestScannedMessageTimeMs,
        scannedCount,
      });
      return {
        messages: results.sort((left, right) => (left.message_id || 0) - (right.message_id || 0)),
        ...boundary,
      };
    },
    async listAgentChatMessages(params: { chatId: string; limit: number }) {
      const results: TelegramAgentReadItem[] = [];
      await client.getDialogs({
        limit: 1000,
      });
      const entity = await client.getEntity(params.chatId);
      for await (const message of client.iterMessages(entity, {
        limit: params.limit,
      })) {
        const mapped = mapTelegramMessageToAgentReadItem(message as unknown as Record<string, unknown>);
        if (mapped) {
          results.push(mapped);
        }
      }
      return results.sort((left, right) => left.messageId - right.messageId);
    },
    async searchAgentChatMessages(params: { chatId: string; query: string; limit: number }) {
      const query = normalizeString(params.query);
      if (!query) {
        return {
          searchMode: 'telegram' as const,
          items: [],
        };
      }

      await client.getDialogs({
        limit: 1000,
      });
      const entity = await client.getEntity(params.chatId);

      try {
        const results: TelegramAgentReadItem[] = [];
        for await (const message of client.iterMessages(entity, {
          search: query,
          limit: params.limit,
        })) {
          const mapped = mapTelegramMessageToAgentReadItem(message as unknown as Record<string, unknown>);
          if (mapped) {
            results.push(mapped);
          }
        }
        return {
          searchMode: 'telegram' as const,
          items: results.sort((left, right) => left.messageId - right.messageId),
        };
      } catch (error) {
        assertTelegramSearchFallbackOrThrow(error);
      }

      const queryLower = query.toLowerCase();
      const fallbackResults: TelegramAgentReadItem[] = [];
      for await (const message of client.iterMessages(entity, {
        limit: params.limit,
      })) {
        const mapped = mapTelegramMessageToAgentReadItem(message as unknown as Record<string, unknown>);
        if (mapped && mapped.text.toLowerCase().includes(queryLower)) {
          fallbackResults.push(mapped);
        }
      }
      return {
        searchMode: 'recent-scan' as const,
        items: fallbackResults.sort((left, right) => left.messageId - right.messageId),
      };
    },
    async disconnect() {
      await client.disconnect();
    },
  };
}
