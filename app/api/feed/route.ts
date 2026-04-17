import { NextRequest, NextResponse } from 'next/server';

import { readFeedSnapshot, readLatestActivityAtByUser } from '@/lib/server/feedSnapshotRepo';
import { getSyncStatus, triggerSync, waitForSyncIdle } from '@/lib/server/syncService';
import { importTrackedUsers, listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import { sanitizeUsersPayload } from '@/lib/server/userPayload';

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
  const limit = Number.parseInt(request.nextUrl.searchParams.get('limit') || '200', 10);
  const offset = Number.parseInt(request.nextUrl.searchParams.get('offset') || '0', 10);
  const userId = request.nextUrl.searchParams.get('userId');
  return {
    limit: Number.isFinite(limit) ? limit : 200,
    offset: Number.isFinite(offset) ? offset : 0,
    userId: typeof userId === 'string' && userId.trim() ? userId.trim() : null,
  };
}

function buildFeedPayload(limit: number, offset: number, userId?: string | null) {
  const snapshot = readFeedSnapshot(limit, offset, userId);
  const latestActivityAtByUser = readLatestActivityAtByUser();
  const syncStatus = getSyncStatus();
  const users = listTrackedUsers();
  const selectedUser = userId ? users.find((user) => user.id === userId) || null : null;
  const { addressAssets, userAssets } = buildAssetSnapshotsFromUsers(users);
  const diagnostics = selectedUser
    ? (syncStatus.lastSuccessSnapshot?.diagnostics || []).filter((item) => item.userId === selectedUser.id)
    : (syncStatus.lastSuccessSnapshot?.diagnostics || []);
  const globalSummary = syncStatus.lastSuccessSnapshot?.summary || {
    userCount: users.length,
    addressCount: users.reduce((sum, user) => sum + user.addresses.length, 0),
    transactionCount: snapshot.total,
    successfulAddressCount: 0,
    failedAddressCount: 0,
    emptyAddressCount: 0,
    completedAt: 0,
  };
  const summary = selectedUser
    ? {
        userCount: 1,
        addressCount: selectedUser.addresses.length,
        transactionCount: snapshot.total,
        successfulAddressCount: diagnostics.filter((item) => item.ok).length,
        failedAddressCount: diagnostics.filter((item) => !item.ok).length,
        emptyAddressCount: diagnostics.filter((item) => item.ok && item.transactionCount === 0).length,
        completedAt: globalSummary.completedAt,
      }
    : globalSummary;

  return {
    ok: true,
    feed: snapshot.feed,
    total: snapshot.total,
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

export async function GET(request: NextRequest) {
  try {
    const { limit, offset, userId } = parsePagination(request);
    return NextResponse.json(buildFeedPayload(limit, offset, userId));
  } catch (error) {
    const message = error instanceof Error ? error.message : '读取快照失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const users = sanitizeUsersPayload(body?.users);
    const { limit, offset, userId } = parsePagination(request);

    if (users.length > 0) {
      importTrackedUsers(users, { replaceExisting: true });
    }

    const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'api-feed-post';
    const mode = body?.mode === 'backfill' ? 'backfill' : 'refresh';
    const scope = body?.scope === 'user' ? 'user' : 'global';
    const sync = triggerSync(reason, {
      mode,
      scope,
      userId: typeof body?.syncUserId === 'string' && body.syncUserId.trim() ? body.syncUserId.trim() : null,
    });
    // refresh 走异步触发，避免首屏加载被长耗时同步阻塞超时；
    // backfill 需要尽量拿到补拉后的结果，仍等待同步结束再返回。
    if (mode === 'backfill') {
      await waitForSyncIdle();
    }

    return NextResponse.json({
      ...buildFeedPayload(limit, offset, userId),
      syncTrigger: sync,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '触发同步失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
