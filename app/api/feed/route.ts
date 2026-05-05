import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/server/apiGuard';
import { readEventsFeed, readLatestActivityAtByUser } from '@/lib/server/eventsRepo';
import { countQualifiedActivitiesByUser, readFeedBackfillWindowState } from '@/lib/server/feedSnapshotRepo';
import { scheduleBackfillCompanionAfterPrimarySync } from '@/lib/server/feedBackfillScheduler';
import { readPrewarmProgressSnapshot } from '@/lib/server/feedPrewarmService';
import { computeTwitterBackfillWindowDays, readFeedViewMeta } from '@/lib/server/feedViewMeta';
import { getSyncStatus, triggerSync, waitForSyncCompletion } from '@/lib/server/syncService';
import { readSystemConfig } from '@/lib/server/systemConfigRepo';
import { scheduleTelegramMonitorRepairBatch } from '@/lib/server/telegramMonitorReconciler';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import { readTelegramMonitorFeed } from '@/lib/server/telegramMonitorFeed';
import { runTwitterSyncAction } from '@/lib/server/twitterSyncService';
import { normalizeTwitterHandle } from '@/lib/userProfile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function buildAssetSnapshotsFromUsers(users: ReturnType<typeof listTrackedUsers>) {
  const addressAssets = users.flatMap((user) =>
    user.addresses
      .filter((address) => typeof address.assetUpdatedAt === 'number')
      .map((address) => ({
        userId: user.id,
        chain: address.chain,
        address: address.address,
        totalAssetUsd: address.totalAssetUsd,
        updatedAt: address.assetUpdatedAt as number,
      }))
  );

  const userAssets = users
    .filter((user) => typeof user.assetUpdatedAt === 'number')
    .map((user) => ({
      userId: user.id,
      totalAssetUsd: user.totalAssetUsd,
      updatedAt: user.assetUpdatedAt as number,
    }));

  return {
    addressAssets,
    userAssets,
  };
}

function parsePagination(request: NextRequest) {
  const page = Number.parseInt(request.nextUrl.searchParams.get('page') || '1', 10);
  const pageSize = Number.parseInt(
    request.nextUrl.searchParams.get('pageSize') || request.nextUrl.searchParams.get('limit') || '50',
    10
  );
  const userId = request.nextUrl.searchParams.get('userId');
  const search = request.nextUrl.searchParams.get('search') || request.nextUrl.searchParams.get('q');
  const cursor = request.nextUrl.searchParams.get('cursor');
  const source = request.nextUrl.searchParams.get('source');
  const chain = request.nextUrl.searchParams.get('chain');
  const from = request.nextUrl.searchParams.get('from');
  const to = request.nextUrl.searchParams.get('to');
  const normalizedPage = Number.isFinite(page) && page > 0 ? page : 1;
  const normalizedPageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.min(200, pageSize) : 50;

  const fromMs = from && Number.isFinite(Number(from)) ? Number(from) : null;
  const toMs = to && Number.isFinite(Number(to)) ? Number(to) : null;

  return {
    page: normalizedPage,
    pageSize: normalizedPageSize,
    userId: typeof userId === 'string' && userId.trim() ? userId.trim() : null,
    search: typeof search === 'string' && search.trim() ? search.trim() : null,
    cursor: typeof cursor === 'string' && cursor.trim() ? cursor.trim() : null,
    source: typeof source === 'string' && source.trim() ? source.trim() : null,
    chain: typeof chain === 'string' && chain.trim() ? chain.trim() : null,
    fromMs,
    toMs,
  };
}

function shouldUseTelegramMonitorFeed(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get('mode')?.trim().toLowerCase();
  if (mode === 'poll') return false;
  if (mode === 'telegram') return true;

  const env = (process.env.FEED_SOURCE_MODE || '').trim().toLowerCase();
  return env === 'telegram';
}

function buildFeedPayload(
  pageSize: number,
  userId?: string | null,
  search?: string | null,
  cursor?: string | null,
  source?: string | null,
  chain?: string | null,
  fromMs?: number | null,
  toMs?: number | null
) {
  const prewarm = readPrewarmProgressSnapshot();
  const snapshot = readEventsFeed({
    limit: pageSize,
    userId,
    q: search,
    cursor,
    source,
    chain,
    fromMs,
    toMs,
  });

  const syncStatus = getSyncStatus();
  const users = listTrackedUsers();
  const liveAddressCount = users.reduce((sum, user) => sum + user.addresses.length, 0);
  const selectedUser = userId ? users.find((user) => user.id === userId) || null : null;
  const historyState = readFeedBackfillWindowState();
  const localQualifiedCount = selectedUser ? countQualifiedActivitiesByUser(selectedUser.id) : snapshot.total;
  const historyComplete = selectedUser ? historyState?.perUserHistoryComplete[selectedUser.id] === true : null;
  const { addressAssets, userAssets } = buildAssetSnapshotsFromUsers(users);
  const diagnostics = selectedUser
    ? (syncStatus.lastSuccessSnapshot?.diagnostics || []).filter((item) => item.userId === selectedUser.id)
    : (syncStatus.lastSuccessSnapshot?.diagnostics || []);
  const globalSummary = syncStatus.lastSuccessSnapshot?.summary || {
    userCount: users.length,
    addressCount: liveAddressCount,
    transactionCount: snapshot.total,
    successfulAddressCount: 0,
    failedAddressCount: 0,
    emptyAddressCount: 0,
    completedAt: 0,
  };
  const normalizedGlobalSummary = {
    ...globalSummary,
    userCount: users.length,
    addressCount: liveAddressCount,
    transactionCount: snapshot.total,
  };
  const summary = selectedUser
    ? {
        userCount: 1,
        addressCount: selectedUser.addresses.length,
        transactionCount: snapshot.total,
        successfulAddressCount: diagnostics.filter((item) => item.ok).length,
        failedAddressCount: diagnostics.filter((item) => !item.ok).length,
        emptyAddressCount: diagnostics.filter((item) => item.ok && item.transactionCount === 0).length,
        completedAt: normalizedGlobalSummary.completedAt,
      }
    : normalizedGlobalSummary;
  const feedViewMeta = readFeedViewMeta({
    userId: selectedUser?.id ?? null,
    endMs: normalizedGlobalSummary.completedAt > 0 ? normalizedGlobalSummary.completedAt : Date.now(),
  });

  const latestActivityAtByUser = readLatestActivityAtByUser();

  return {
    ok: true,
    prewarm,
    feed: snapshot.feed,
    total: snapshot.total,
    page: 1,
    pageSize,
    hasMore: snapshot.hasMore,
    nextCursor: snapshot.nextCursor,
    historyComplete,
    localQualifiedCount,
    activityBreakdown: feedViewMeta.activityBreakdown,
    completenessWindow: feedViewMeta.completenessWindow,
    latestActivityAtByUser,
    summary,
    diagnostics,
    addressAssets,
    userAssets,
    users,
    sync: {
      running: syncStatus.running,
      stale: syncStatus.stale,
      activeRunId: syncStatus.activeRunId,
      lastSuccessAt: syncStatus.lastSuccessAt,
      lastError: syncStatus.lastError,
      lastFailureAt: syncStatus.lastFailureAt,
      latestRun: syncStatus.latestRun,
    },
  };
}

function hasTrackedTwitterSource(users: ReturnType<typeof listTrackedUsers>, userId: string | null) {
  if (userId) {
    const user = users.find((item) => item.id === userId) || null;
    return Boolean(user && normalizeTwitterHandle(user.twitter || ''));
  }

  return users.some((user) => Boolean(normalizeTwitterHandle(user.twitter || '')));
}

function triggerRefreshCompanionSyncs(options: {
  scope: 'global' | 'user';
  userId: string | null;
}) {
  if (typeof readSystemConfig().completenessStartMs === 'number') {
    return;
  }
  const users = listTrackedUsers();
  if (!hasTrackedTwitterSource(users, options.userId)) {
    return;
  }

  void runTwitterSyncAction({
    action: 'sync',
    userId: options.scope === 'user' ? options.userId : null,
    windowDays: 7,
  }).catch((error) => {
    console.error('[api/feed] twitter refresh companion sync failed:', error);
  });
}

function triggerBackfillCompanionSyncs(options: {
  scope: 'global' | 'user';
  userId: string | null;
}) {
  if (typeof readSystemConfig().completenessStartMs === 'number') {
    return {
      twitter: {
        ok: true,
        skipped: true,
        reason: 'unified-completeness-authoritative',
      },
    };
  }
  const users = listTrackedUsers();
  if (!hasTrackedTwitterSource(users, options.userId)) {
    return {
      twitter: {
        ok: true,
        skipped: true,
        reason: 'no-tracked-twitter-source',
      },
    };
  }

  const windowState = readFeedBackfillWindowState();
  const startMs =
    options.scope === 'user' && options.userId
      ? windowState?.perUserEarliestMs?.[options.userId] ?? windowState?.globalEarliestMs ?? null
      : windowState?.globalEarliestMs ?? null;
  const windowDays = computeTwitterBackfillWindowDays(startMs, Date.now());

  void runTwitterSyncAction({
    action: 'sync',
    userId: options.scope === 'user' ? options.userId : null,
    windowDays,
  }).catch((error) => {
    console.error('[api/feed] twitter backfill companion sync failed:', error);
  });

  return {
    twitter: {
      ok: true,
      started: true,
      background: true,
      windowDays,
      userId: options.scope === 'user' ? options.userId : null,
    },
  };
}

function scheduleBackfillCompanionSyncs(options: {
  scope: 'global' | 'user';
  userId: string | null;
}) {
  if (typeof readSystemConfig().completenessStartMs === 'number') {
    return {
      twitter: {
        ok: true,
        skipped: true,
        reason: 'unified-completeness-authoritative',
      },
    };
  }
  const users = listTrackedUsers();
  if (!hasTrackedTwitterSource(users, options.userId)) {
    return {
      twitter: {
        ok: true,
        skipped: true,
        reason: 'no-tracked-twitter-source',
      },
    };
  }

  return scheduleBackfillCompanionAfterPrimarySync({
    waitForPrimarySync: waitForSyncCompletion,
    runCompanionSyncs: () => triggerBackfillCompanionSyncs(options),
    onError: (error) => {
      console.error('[api/feed] deferred backfill companion sync failed:', error);
    },
  });
}

export async function GET(request: NextRequest) {
  try {
    const { pageSize, userId, search, cursor, source, chain, fromMs, toMs } = parsePagination(request);
    const prewarm = readPrewarmProgressSnapshot();

    if (shouldUseTelegramMonitorFeed(request)) {
      void Promise.resolve().then(() => {
        scheduleTelegramMonitorRepairBatch(5);
      });
      const monitorFeed = await readTelegramMonitorFeed(Math.max(pageSize, 200));
      const filteredByUser = userId ? monitorFeed.filter((item) => item.user.id === userId) : monitorFeed;
      const paged = filteredByUser.slice(0, pageSize);
      const users = listTrackedUsers();
      const latestActivityAtByUser = Object.fromEntries(
        monitorFeed.map((item) => [item.user.id, item.activity.timestamp])
      );
      const selectedUser = userId ? users.find((user) => user.id === userId) || null : null;
      const feedViewMeta = readFeedViewMeta({
        userId: selectedUser?.id ?? null,
        endMs: Date.now(),
      });

      return NextResponse.json({
        ok: true,
        prewarm,
        feed: paged,
        total: filteredByUser.length,
        page: 1,
        pageSize,
        hasMore: filteredByUser.length > paged.length,
        nextCursor: null,
        historyComplete: true,
        localQualifiedCount: filteredByUser.length,
        activityBreakdown: feedViewMeta.activityBreakdown,
        completenessWindow: feedViewMeta.completenessWindow,
        latestActivityAtByUser,
        summary: {
          userCount: users.length,
          addressCount: users.reduce((sum, user) => sum + user.addresses.length, 0),
          transactionCount: filteredByUser.length,
          successfulAddressCount: 0,
          failedAddressCount: 0,
          emptyAddressCount: 0,
          completedAt: Date.now(),
        },
        diagnostics: [],
        addressAssets: [],
        userAssets: [],
        users,
        sync: {
          running: false,
          stale: false,
          activeRunId: null,
          lastSuccessAt: null,
          lastError: null,
          lastFailureAt: null,
          latestRun: null,
        },
      });
    }

    return NextResponse.json(buildFeedPayload(pageSize, userId, search, cursor, source, chain, fromMs, toMs));
  } catch (error) {
    const message = error instanceof Error ? error.message : '读取快照失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const unauthorizedResponse = requireAdmin(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  try {
    const body = await request.json().catch(() => null);
    const { pageSize, userId, search, cursor, source, chain, fromMs, toMs } = parsePagination(request);

    const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'api-feed-post';
    const mode = body?.mode === 'backfill' ? 'backfill' : 'refresh';
    const scope = body?.scope === 'user' ? 'user' : 'global';
    const sync = triggerSync(reason, {
      mode,
      scope,
      userId: typeof body?.syncUserId === 'string' && body.syncUserId.trim() ? body.syncUserId.trim() : null,
    });
    let sourceSyncs: ReturnType<typeof scheduleBackfillCompanionSyncs> | null = null;

    if (mode === 'backfill') {
      sourceSyncs = scheduleBackfillCompanionSyncs({
        scope,
        userId: typeof body?.syncUserId === 'string' && body.syncUserId.trim() ? body.syncUserId.trim() : null,
      });
    } else {
      triggerRefreshCompanionSyncs({
        scope,
        userId: typeof body?.syncUserId === 'string' && body.syncUserId.trim() ? body.syncUserId.trim() : null,
      });
    }

    return NextResponse.json({
      ...buildFeedPayload(pageSize, userId, search, cursor, source, chain, fromMs, toMs),
      syncTrigger: sync,
      sourceSyncs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '触发同步失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
