import 'server-only';

import { TelegramClient, utils } from 'telegram';
import { Api } from 'telegram/tl';
import { StringSession } from 'telegram/sessions';

import { readTelegramClientConfig } from '@/lib/server/telegramClientConfig';
import { readTelegramMtprotoPolicy } from '@/lib/server/telegramMtprotoPolicy';
import type {
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
      channelId: BigInt(channelId),
      accessHash: BigInt(accessHash),
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
    async disconnect() {
      await client.disconnect();
    },
  };
}
