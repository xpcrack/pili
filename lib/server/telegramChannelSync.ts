import 'server-only';

import { createTwitterFetcher } from '@/lib/server/twitterFetcher';
import { classifyTelegramMtprotoError, readTelegramMtprotoPolicy, sleep } from '@/lib/server/telegramMtprotoPolicy';
import {
  bootstrapTelegramChannelSourcesFromTrackedUsers,
  listTelegramChannelSources,
} from '@/lib/server/telegramChannelSourceRepo';
import type { UpsertTwitterTweetInput } from '@/lib/server/twitterRepo';
import {
  getTelegramChannelSourceById,
  updateTelegramChannelSourceState,
} from '@/lib/server/telegramChannelSourceRepo';
import { ingestTelegramChannelPost } from '@/lib/server/telegramChannelIngest';
import { upsertTelegramChannelPost } from '@/lib/server/telegramChannelPostRepo';
import type { TelegramChannelSyncClient } from '@/lib/server/telegramChannelTypes';

export interface TelegramChannelSweepResultItem {
  sourceId: string;
  channelRef: string;
  storedCount: number;
  projectedCount: number;
  lastMessageId: number | null;
  ok: boolean;
  error?: string;
  errorKind?: ReturnType<typeof classifyTelegramMtprotoError>['kind'];
  waitMs?: number | null;
}

export async function syncTelegramChannelSource(params: {
  sourceId: string;
  client: TelegramChannelSyncClient;
  fetchTweetsByIds?: (ids: string[]) => Promise<{ provider: string; tweets: UpsertTwitterTweetInput[] }>;
}) {
  const source = getTelegramChannelSourceById(params.sourceId);
  if (!source) {
    throw new Error(`telegram channel source not found: ${params.sourceId}`);
  }
  if (!source.enabled) {
    return {
      storedCount: 0,
      projectedCount: 0,
      lastMessageId: source.lastMessageId,
    };
  }

  const fetchTweetsByIds =
    params.fetchTweetsByIds ||
    (async (ids: string[]) => {
      const fetcher = createTwitterFetcher();
      return fetcher.fetchTweetsByIds({ ids, intent: 'detail' });
    });

  try {
    const resolved = await params.client.resolveChannel({
      channelRef: source.channelRef,
      channelUsername: source.channelUsername,
      channelChatId: source.channelChatId,
      accessHash: source.accessHash,
    });
    updateTelegramChannelSourceState(source.id, {
      channelChatId: resolved.channelChatId,
      channelUsername: resolved.channelUsername,
      channelTitle: resolved.channelTitle,
      accessHash: resolved.accessHash,
      syncStatus: 'ready',
      lastError: null,
    });

    const remoteMessages = await params.client.listChannelMessages({
      source,
      resolved,
      minMessageId: source.lastMessageId,
      limit: Number.parseInt(process.env.TELEGRAM_MTPROTO_CHANNEL_SYNC_LIMIT || '50', 10) || 50,
    });

    let storedCount = 0;
    let projectedCount = 0;
    let lastMessageId = source.lastMessageId;
    for (const message of remoteMessages.sort((left, right) => left.messageId - right.messageId)) {
      const stored = upsertTelegramChannelPost({
        channelChatId: resolved.channelChatId,
        channelUsername: resolved.channelUsername,
        channelTitle: resolved.channelTitle,
        messageId: message.messageId,
        groupedId: message.groupedId,
        postedAtMs: message.postedAtMs,
        editDateMs: message.editDateMs,
        text: message.text,
        textEntities: message.textEntities,
        media: message.media,
        linkUrls: message.linkUrls,
        forwardInfo: message.forwardInfo,
        views: message.views,
        forwards: message.forwards,
        replies: message.replies,
        raw: message.raw,
      });
      storedCount += 1;
      await ingestTelegramChannelPost({
        source: {
          ...source,
          channelChatId: resolved.channelChatId,
          channelUsername: resolved.channelUsername,
          channelTitle: resolved.channelTitle,
          accessHash: resolved.accessHash,
          syncStatus: 'ready',
        },
        post: stored,
        fetchTweetsByIds,
      });
      projectedCount += 1;
      lastMessageId = Math.max(lastMessageId || 0, message.messageId);
    }

    updateTelegramChannelSourceState(source.id, {
      channelChatId: resolved.channelChatId,
      channelUsername: resolved.channelUsername,
      channelTitle: resolved.channelTitle,
      accessHash: resolved.accessHash,
      syncStatus: 'ready',
      lastMessageId,
      lastSyncedAtMs: Date.now(),
      lastError: null,
    });

    return {
      storedCount,
      projectedCount,
      lastMessageId,
    };
  } catch (error) {
    const classified = classifyTelegramMtprotoError(error);
    updateTelegramChannelSourceState(source.id, {
      syncStatus:
        classified.kind === 'auth_required'
          ? 'auth_required'
          : classified.kind === 'unavailable'
            ? 'unavailable'
            : 'error',
      lastError: classified.message.slice(0, 1000),
    });
    throw error;
  }
}

export async function syncAllTelegramChannelSources(params: {
  client: TelegramChannelSyncClient;
  fetchTweetsByIds?: (ids: string[]) => Promise<{ provider: string; tweets: UpsertTwitterTweetInput[] }>;
  sleepFn?: (ms: number) => Promise<void>;
}) {
  bootstrapTelegramChannelSourcesFromTrackedUsers();
  const policy = readTelegramMtprotoPolicy();
  const sleepFn = params.sleepFn || sleep;
  const sources = listTelegramChannelSources({ enabledOnly: true }).sort((left, right) => left.updatedAt - right.updatedAt);
  const results: TelegramChannelSweepResultItem[] = [];
  let syncedCount = 0;
  let errorCount = 0;
  let storedCount = 0;
  let projectedCount = 0;
  let backoffMs: number | null = null;

  for (const source of sources) {
    try {
      const result = await syncTelegramChannelSource({
        sourceId: source.id,
        client: params.client,
        fetchTweetsByIds: params.fetchTweetsByIds,
      });
      syncedCount += 1;
      storedCount += result.storedCount;
      projectedCount += result.projectedCount;
      results.push({
        sourceId: source.id,
        channelRef: source.channelRef,
        storedCount: result.storedCount,
        projectedCount: result.projectedCount,
        lastMessageId: result.lastMessageId,
        ok: true,
      });
    } catch (error) {
      const classified = classifyTelegramMtprotoError(error);
      errorCount += 1;
      results.push({
        sourceId: source.id,
        channelRef: source.channelRef,
        storedCount: 0,
        projectedCount: 0,
        lastMessageId: source.lastMessageId,
        ok: false,
        error: classified.message,
        errorKind: classified.kind,
        waitMs: classified.waitMs,
      });
      if (classified.kind === 'flood_wait') {
        backoffMs =
          typeof classified.waitMs === 'number' && Number.isFinite(classified.waitMs)
            ? Math.max(backoffMs || 0, classified.waitMs)
            : backoffMs;
        break;
      }
    }

    if (source.id !== sources[sources.length - 1]?.id) {
      await sleepFn(policy.requestDelayMs);
    }
  }

  return {
    sourceCount: sources.length,
    syncedCount,
    errorCount,
    storedCount,
    projectedCount,
    backoffMs,
    results,
  };
}
