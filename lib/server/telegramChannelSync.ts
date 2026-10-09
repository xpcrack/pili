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
import type { TelegramChannelSource, TelegramChannelSyncClient } from '@/lib/server/telegramChannelTypes';

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

function buildDefaultFetchTweetsByIds() {
  return async (ids: string[]) => {
    const fetcher = createTwitterFetcher();
    return fetcher.fetchTweetsByIds({ ids, intent: 'detail' });
  };
}

async function storeAndProjectTelegramChannelMessages(params: {
  source: TelegramChannelSource;
  resolved: {
    channelChatId: string;
    channelUsername: string | null;
    channelTitle: string | null;
    accessHash: string | null;
  };
  remoteMessages: Array<{
    messageId: number;
    groupedId: string | null;
    postedAtMs: number;
    editDateMs: number | null;
    text: string;
    textEntities: unknown[];
    media: string[];
    linkUrls: string[];
    forwardInfo: Record<string, unknown> | null;
    views: number | null;
    forwards: number | null;
    replies: number | null;
    raw: Record<string, unknown>;
  }>;
  fetchTweetsByIds: (ids: string[]) => Promise<{ provider: string; tweets: UpsertTwitterTweetInput[] }>;
}) {
  let storedCount = 0;
  let projectedCount = 0;
  let lastMessageId = params.source?.lastMessageId ?? null;

  for (const message of params.remoteMessages.sort((left, right) => left.messageId - right.messageId)) {
    const stored = upsertTelegramChannelPost({
      channelChatId: params.resolved.channelChatId,
      channelUsername: params.resolved.channelUsername,
      channelTitle: params.resolved.channelTitle,
      messageId: message.messageId,
      groupedId: message.groupedId,
      postedAtMs: message.postedAtMs,
      editDateMs: message.editDateMs,
      text: message.text,
      textEntities: message.textEntities,
      media: message.media,
      linkUrls: message.linkUrls,
      channelType: params.source.channelType,
      forwardInfo: message.forwardInfo,
      views: message.views,
      forwards: message.forwards,
      replies: message.replies,
      raw: message.raw,
    });
    storedCount += 1;
    await ingestTelegramChannelPost({
      source: {
        ...params.source,
        channelChatId: params.resolved.channelChatId,
        channelUsername: params.resolved.channelUsername,
        channelTitle: params.resolved.channelTitle,
        accessHash: params.resolved.accessHash,
        syncStatus: 'ready',
      },
      post: stored,
      fetchTweetsByIds: params.fetchTweetsByIds,
    });
    projectedCount += 1;
    lastMessageId = Math.max(lastMessageId || 0, message.messageId);
  }

  return {
    storedCount,
    projectedCount,
    lastMessageId,
  };
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
    params.fetchTweetsByIds || buildDefaultFetchTweetsByIds();

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

    // Catch-up loop：单轮 limit（默认 50）在合盖/宕机断档后会把中间消息跳过——
    // minMessageId 直接推进到最新一批的头部，断档期超出 limit 的消息永久丢失。
    // 循环拉取直到无新消息（拉回数 < limit）或达到安全上限，全部入库后才推进终态游标。
    // 上限防失控：正常轮次频道消息量远小于它；真的追到上限说明断档 > 40 轮容量，
    // 留到下一轮继续（游标只推进到已入库位置，不断档信息）。
    const perPageLimit =
      Number.parseInt(process.env.TELEGRAM_MTPROTO_CHANNEL_SYNC_LIMIT || '50', 10) || 50;
    const catchUpMaxMessages = Number.parseInt(
      process.env.TELEGRAM_CHANNEL_SYNC_CATCH_UP_MAX || '2000',
      10,
    ) || 2000;

    let totalStoredCount = 0;
    let totalProjectedCount = 0;
    let cursorMinMessageId = source.lastMessageId;
    let finalLastMessageId = source.lastMessageId;
    let reachedEnd = false;

    for (
      let round = 0;
      round < Math.ceil(catchUpMaxMessages / perPageLimit) && !reachedEnd;
      round += 1
    ) {
      const remoteMessages = await params.client.listChannelMessages({
        source,
        resolved,
        minMessageId: cursorMinMessageId,
        limit: perPageLimit,
      });

      const storedProjectResult = await storeAndProjectTelegramChannelMessages({
        source,
        resolved,
        remoteMessages,
        fetchTweetsByIds,
      });

      totalStoredCount += storedProjectResult.storedCount;
      totalProjectedCount += storedProjectResult.projectedCount;
      if (storedProjectResult.lastMessageId !== null) {
        finalLastMessageId = Math.max(finalLastMessageId || 0, storedProjectResult.lastMessageId);
      }

      // 本轮实际拉回数 < limit = 频道已无更多新消息 → 追平。
      // 用实际返回数判断（而非 storedCount），空文本等被 map 跳过的消息不会误判继续。
      if (remoteMessages.length < perPageLimit) {
        reachedEnd = true;
        break;
      }

      // 游标推进到本轮实际入库的最大 messageId，防止循环内某轮抛错后游标回退重拉。
      if (storedProjectResult.lastMessageId !== null) {
        cursorMinMessageId = storedProjectResult.lastMessageId;
      }
    }

    updateTelegramChannelSourceState(source.id, {
      channelChatId: resolved.channelChatId,
      channelUsername: resolved.channelUsername,
      channelTitle: resolved.channelTitle,
      accessHash: resolved.accessHash,
      syncStatus: 'ready',
      lastMessageId: finalLastMessageId,
      lastSyncedAtMs: Date.now(),
      lastError: null,
    });

    return {
      storedCount: totalStoredCount,
      projectedCount: totalProjectedCount,
      lastMessageId: finalLastMessageId,
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

export async function backfillTelegramChannelSourceHistory(params: {
  sourceId: string;
  client: TelegramChannelSyncClient;
  beforeMessageId?: number | null;
  startMs?: number | null;
  endMs?: number | null;
  fetchTweetsByIds?: (ids: string[]) => Promise<{ provider: string; tweets: UpsertTwitterTweetInput[] }>;
}) {
  const source = getTelegramChannelSourceById(params.sourceId);
  if (!source) {
    throw new Error(`telegram channel source not found: ${params.sourceId}`);
  }
  if (!source.enabled) {
    return {
      sourceId: source.id,
      fetchedCount: 0,
      storedCount: 0,
      projectedCount: 0,
      oldestScannedMessageId: null,
      oldestScannedMessageTimeMs: null,
      reachedHistoryBoundary: true,
      nextBeforeMessageId: null,
      lastMessageIdAfterRun: source.lastMessageId,
    };
  }

  const fetchTweetsByIds = params.fetchTweetsByIds || buildDefaultFetchTweetsByIds();

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

    const page = params.client.listChannelHistoryPage
      ? await params.client.listChannelHistoryPage({
          source,
          resolved,
          beforeMessageId: params.beforeMessageId ?? null,
          startMs: params.startMs ?? null,
          endMs: params.endMs ?? null,
          limit: Number.parseInt(process.env.TELEGRAM_MTPROTO_CHANNEL_SYNC_LIMIT || '50', 10) || 50,
        })
      : {
          messages: [],
          oldestScannedMessageId: null,
          oldestScannedMessageTimeMs: null,
          reachedHistoryBoundary: false,
          nextBeforeMessageId: null,
        };

    const storedProjectResult = await storeAndProjectTelegramChannelMessages({
      source,
      resolved,
      remoteMessages: page.messages,
      fetchTweetsByIds,
    });

    return {
      sourceId: source.id,
      fetchedCount: page.messages.length,
      storedCount: storedProjectResult.storedCount,
      projectedCount: storedProjectResult.projectedCount,
      oldestScannedMessageId: page.oldestScannedMessageId,
      oldestScannedMessageTimeMs: page.oldestScannedMessageTimeMs,
      reachedHistoryBoundary: page.reachedHistoryBoundary,
      nextBeforeMessageId: page.nextBeforeMessageId,
      lastMessageIdAfterRun: source.lastMessageId,
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

  // 并发同步（信号量 3）：单 source 卡在 socks 代理 10s 超时或 Twitter 链接抓取
  // 时不再阻塞其余 channel；flood_wait 由 gramjs floodSleepThreshold + backoff 兜底。
  // 串行版实测一轮可达 100s+（10×10s 超时排队），并发 3 后一轮 ≈ 最慢批次 + ε。
  const CONCURRENCY = 3;
  let cursor = 0;

  async function syncOne(source: (typeof sources)[number]): Promise<void> {
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
        // flood：本 worker 停止再领新任务；已在跑的其他 worker 完成自己的
        return;
      }
    }

    // 每个 source 之间保留最小间隔，平滑并发下的请求节奏
    if (source.id !== sources[sources.length - 1]?.id) {
      await sleepFn(policy.requestDelayMs);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, sources.length) }, async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= sources.length) {
        return;
      }
      await syncOne(sources[idx]);
    }
  });
  await Promise.all(workers);

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
