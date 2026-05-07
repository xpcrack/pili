import 'server-only';

import {
  buildActivityFeed,
  type ActivityFeedSummary,
  type AddressDiagnostic,
} from '@/lib/activityFeed';
import {
  readFeedBackfillWindowState,
  readLastFailedSyncState,
  readLastSuccessfulSnapshotState,
  clearParserArtifactSnapshots,
  deleteFeedSnapshotWindowForUsers,
  getQualifiedActivityCountsByUser,
  replaceFeedSnapshot,
  saveFeedBackfillWindowState,
  saveLastFailureState,
  saveLastSuccessfulSnapshotState,
  upsertFeedSnapshot,
  upsertRawTransactions,
} from '@/lib/server/feedSnapshotRepo';
import { getDb } from '@/lib/server/sqlite';
import { sleep } from '@/lib/timing';
import {
  listTrackedUsers,
} from '@/lib/server/trackedUsersRepo';
import { appendSyncLog, pruneSyncLogs } from '@/lib/server/syncLogRepo';
import { flushConflictNotifications } from '@/lib/server/conflictNotifier';
import { notifySyncAddressFetchFailures } from '@/lib/server/syncFailureNotifier';
import {
  applyGlobalBackfillWindowState,
  applyRefreshWindowState,
  applyUserBackfillWindowState,
  createDefaultWindowState,
  mergeRefreshWindowState,
  normalizeSyncOptions,
  type TriggerSyncOptions,
} from '@/lib/server/syncWindowState';
import { runAssetSyncPipeline } from '@/lib/server/assetSyncPipeline';

const DEFAULT_STALE_MS = 30 * 60 * 1000;
const INITIAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const BACKFILL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface SyncRunRow {
  id: number;
  status: string;
  reason: string | null;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  total_addresses: number;
  successful_addresses: number;
  failed_addresses: number;
  error: string | null;
  summary_json: string | null;
}

interface ActiveRunState {
  id: number;
  reason: string;
  startedAt: number;
  options: Required<Pick<TriggerSyncOptions, 'mode' | 'scope'>> & { userId: string | null };
}

let activeRunState: ActiveRunState | null = null;
let activeRunPromise: Promise<void> | null = null;

async function flushConflictNotificationsSafely(limit: number) {
  try {
    await flushConflictNotifications(limit);
  } catch (error) {
    console.error('[syncService] flush conflict notifications failed:', error);
  }
}

async function notifySyncFailuresSafely(input: {
  runId: number;
  reason: string;
  mode: 'refresh' | 'backfill';
  scope: 'global' | 'user';
  userId: string | null;
  beginMs: number;
  endMs: number;
  diagnostics: AddressDiagnostic[];
}) {
  try {
    const alertResult = await notifySyncAddressFetchFailures(input);
    if (alertResult.sent || alertResult.reason === 'telegram-request-failed') {
      appendSyncLog({
        runKind: 'sync',
        runId: input.runId,
        level: alertResult.sent ? 'warn' : 'error',
        phase: 'alert',
        message: alertResult.sent
          ? 'sync failure alert sent'
          : 'sync failure alert send failed',
        payload: { ...alertResult },
      });
    }
  } catch (error) {
    console.error('[syncService] notify sync failures failed:', error);
  }
}

function parseJSON<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function createRun(reason: string) {
  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO sync_runs (
        status,
        reason,
        started_at,
        created_at,
        updated_at
      ) VALUES ('running', ?, ?, ?, ?)`
    )
    .run(reason, now, now, now);

  return {
    id: Number(result.lastInsertRowid),
    startedAt: now,
  };
}

function completeRunSuccess(runId: number, payload: {
  startedAt: number;
  summary: ActivityFeedSummary;
  diagnostics: AddressDiagnostic[];
  totalAddresses: number;
  successfulAddresses: number;
  failedAddresses: number;
}) {
  const db = getDb();
  const finishedAt = Date.now();
  db.prepare(
    `UPDATE sync_runs
     SET status = 'success',
         finished_at = ?,
         duration_ms = ?,
         total_addresses = ?,
         successful_addresses = ?,
         failed_addresses = ?,
         summary_json = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(
    finishedAt,
    finishedAt - payload.startedAt,
    payload.totalAddresses,
    payload.successfulAddresses,
    payload.failedAddresses,
    JSON.stringify({
      summary: payload.summary,
      diagnostics: payload.diagnostics,
    }),
    finishedAt,
    runId
  );
}

function completeRunFailure(runId: number, payload: {
  startedAt: number;
  error: string;
  totalAddresses: number;
  successfulAddresses: number;
  failedAddresses: number;
}) {
  const db = getDb();
  const finishedAt = Date.now();
  db.prepare(
    `UPDATE sync_runs
     SET status = 'failed',
         finished_at = ?,
         duration_ms = ?,
         total_addresses = ?,
         successful_addresses = ?,
         failed_addresses = ?,
         error = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(
    finishedAt,
    finishedAt - payload.startedAt,
    payload.totalAddresses,
    payload.successfulAddresses,
    payload.failedAddresses,
    payload.error,
    finishedAt,
    runId
  );
}

async function runSync(
  runId: number,
  reason: string,
  startedAt: number,
  options: Required<Pick<TriggerSyncOptions, 'mode' | 'scope'>> & { userId: string | null }
) {
  appendSyncLog({
    runKind: 'sync',
    runId,
    level: 'info',
    phase: 'start',
    message: `sync run started: ${reason}`,
    payload: {
      mode: options.mode,
      scope: options.scope,
      userId: options.userId,
    },
  });
  const users = listTrackedUsers();
  const totalAddresses = users.reduce((sum, user) => sum + user.addresses.length, 0);

  appendSyncLog({
    runKind: 'sync',
    runId,
    level: 'info',
    phase: 'scan-users',
    message: `loaded tracked users`,
    payload: {
      userCount: users.length,
      totalAddresses,
    },
  });

  if (users.length === 0 || totalAddresses === 0) {
    appendSyncLog({
      runKind: 'sync',
      runId,
      level: 'warn',
      phase: 'empty',
      message: 'no tracked users or addresses, writing empty snapshot',
    });
    clearParserArtifactSnapshots();
    replaceFeedSnapshot([]);
    const summary: ActivityFeedSummary = {
      userCount: users.length,
      addressCount: totalAddresses,
      transactionCount: 0,
      successfulAddressCount: 0,
      failedAddressCount: 0,
      emptyAddressCount: totalAddresses,
      completedAt: Date.now(),
    };

    saveLastSuccessfulSnapshotState({
      summary,
      diagnostics: [],
      runId,
    });
    saveFeedBackfillWindowState(createDefaultWindowState());
    completeRunSuccess(runId, {
      startedAt,
      summary,
      diagnostics: [],
      totalAddresses,
      successfulAddresses: 0,
      failedAddresses: 0,
    });
    appendSyncLog({
      runKind: 'sync',
      runId,
      level: 'info',
      phase: 'done',
      message: 'sync run completed with empty snapshot',
    });
    await flushConflictNotificationsSafely(50);
    return;
  }

  const now = Date.now();
  const currentWindowState = readFeedBackfillWindowState() || createDefaultWindowState();

  let targetUsers = users;
  let beginMs = Math.max(0, now - INITIAL_WINDOW_MS);
  let endMs = now;
  const shouldDeleteWindowBeforeWrite = true;

  if (options.mode === 'backfill') {
    if (options.scope === 'user' && options.userId) {
      targetUsers = users.filter((user) => user.id === options.userId);
      const baseEarliest =
        currentWindowState.perUserEarliestMs[options.userId] ??
        currentWindowState.globalEarliestMs ??
        Math.max(0, now - INITIAL_WINDOW_MS);
      endMs = baseEarliest;
      beginMs = Math.max(0, baseEarliest - BACKFILL_WINDOW_MS);
    } else {
      const baseEarliest = currentWindowState.globalEarliestMs ?? Math.max(0, now - INITIAL_WINDOW_MS);
      endMs = baseEarliest;
      beginMs = Math.max(0, baseEarliest - BACKFILL_WINDOW_MS);
    }
  }

  appendSyncLog({
    runKind: 'sync',
    runId,
    level: 'info',
    phase: 'build-feed',
    message: 'building activity feed window',
    payload: {
      targetUserCount: targetUsers.length,
      beginMs,
      endMs,
      mode: options.mode,
      scope: options.scope,
    },
  });

  if (targetUsers.length === 0) {
    appendSyncLog({
      runKind: 'sync',
      runId,
      level: 'warn',
      phase: 'empty-target',
      message: 'no target users matched for current run options',
      payload: {
        mode: options.mode,
        scope: options.scope,
        userId: options.userId,
      },
    });
    const summary: ActivityFeedSummary = {
      userCount: 0,
      addressCount: 0,
      transactionCount: 0,
      successfulAddressCount: 0,
      failedAddressCount: 0,
      emptyAddressCount: 0,
      completedAt: Date.now(),
    };

    saveLastSuccessfulSnapshotState({
      summary,
      diagnostics: [],
      runId,
    });

    completeRunSuccess(runId, {
      startedAt,
      summary,
      diagnostics: [],
      totalAddresses: 0,
      successfulAddresses: 0,
      failedAddresses: 0,
    });
    appendSyncLog({
      runKind: 'sync',
      runId,
      level: 'info',
      phase: 'done',
      message: 'sync run completed with zero target users',
    });
    await flushConflictNotificationsSafely(50);
    return;
  }

  const result = await buildActivityFeed(targetUsers, {
    beginMs,
    endMs,
    requireTrackedInitiator: true,
  });

  appendSyncLog({
    runKind: 'sync',
    runId,
    level: 'info',
    phase: 'feed-built',
    message: 'activity feed window built',
    payload: {
      feedCount: result.feed.length,
      successfulAddressCount: result.summary.successfulAddressCount,
      failedAddressCount: result.summary.failedAddressCount,
      emptyAddressCount: result.summary.emptyAddressCount,
    },
  });

  await notifySyncFailuresSafely({
    runId,
    reason,
    mode: options.mode,
    scope: options.scope,
    userId: options.userId,
    beginMs,
    endMs,
    diagnostics: result.diagnostics,
  });

  clearParserArtifactSnapshots();
  if (shouldDeleteWindowBeforeWrite) {
    deleteFeedSnapshotWindowForUsers(targetUsers, beginMs, endMs);
  }
  upsertRawTransactions(result.rawTransactions);
  upsertFeedSnapshot(result.feed);
  const assetSync = await runAssetSyncPipeline({
    users: targetUsers,
    addressAssets: result.addressAssets,
    userAssets: result.userAssets,
    diagnostics: result.diagnostics,
    syncedAt: Date.now(),
  });

  if (assetSync.blockedUsers.length > 0) {
    appendSyncLog({
      runKind: 'sync',
      runId,
      level: 'warn',
      phase: 'asset-peak-validation',
      message: 'blocked suspicious peak asset snapshots',
      payload: {
        blockedUserIds: assetSync.blockedUsers.map((item) => item.userId),
        blockedCount: assetSync.blockedUsers.length,
      },
    });
  }

  let nextWindowState = currentWindowState;
  if (options.mode === 'refresh') {
    nextWindowState =
      currentWindowState.globalEarliestMs === null
        ? applyRefreshWindowState(users, beginMs)
        : mergeRefreshWindowState(currentWindowState, users, beginMs, result.diagnostics);
  } else if (options.scope === 'user' && options.userId) {
    nextWindowState = applyUserBackfillWindowState(currentWindowState, options.userId, beginMs, result.diagnostics);
  } else {
    nextWindowState = applyGlobalBackfillWindowState(currentWindowState, users, beginMs, result.diagnostics);
  }
  const latestQualifiedCounts = getQualifiedActivityCountsByUser();
  nextWindowState.perUserLocalQualifiedCount = {
    ...nextWindowState.perUserLocalQualifiedCount,
    ...latestQualifiedCounts,
  };
  for (const user of users) {
    nextWindowState.perUserLocalQualifiedCount[user.id] = latestQualifiedCounts[user.id] ?? 0;
  }
  saveFeedBackfillWindowState(nextWindowState);

  saveLastSuccessfulSnapshotState({
    summary: result.summary,
    diagnostics: result.diagnostics,
    runId,
  });

  completeRunSuccess(runId, {
    startedAt,
    summary: result.summary,
    diagnostics: result.diagnostics,
    totalAddresses: result.summary.addressCount,
    successfulAddresses: result.summary.successfulAddressCount,
    failedAddresses: result.summary.failedAddressCount,
  });

  appendSyncLog({
    runKind: 'sync',
    runId,
    level: 'info',
    phase: 'done',
    message: 'sync run completed',
    payload: {
      transactionCount: result.summary.transactionCount,
      successfulAddressCount: result.summary.successfulAddressCount,
      failedAddressCount: result.summary.failedAddressCount,
    },
  });
  await flushConflictNotificationsSafely(50);
  pruneSyncLogs();
}

export function triggerSync(reason = 'manual', options?: TriggerSyncOptions) {
  if (activeRunState && activeRunPromise) {
    return {
      started: false,
      running: true,
      runId: activeRunState.id,
      startedAt: activeRunState.startedAt,
    };
  }

  const normalizedOptions = normalizeSyncOptions(options);

  const run = createRun(reason);
  activeRunState = {
    id: run.id,
    reason,
    startedAt: run.startedAt,
    options: normalizedOptions,
  };

  activeRunPromise = runSync(run.id, reason, run.startedAt, normalizedOptions)
    .catch((error) => {
      const message = error instanceof Error ? error.message : '后台同步失败';
      const debugError =
        error instanceof Error && process.env.NODE_ENV !== 'production'
          ? error.stack || error.message
          : message;
      const users = listTrackedUsers();
      const totalAddresses = users.reduce((sum, user) => sum + user.addresses.length, 0);
      completeRunFailure(run.id, {
        startedAt: run.startedAt,
        error: message,
        totalAddresses,
        successfulAddresses: 0,
        failedAddresses: totalAddresses,
      });
      appendSyncLog({
        runKind: 'sync',
        runId: run.id,
        level: 'error',
        phase: 'failed',
        message,
        payload: {
          debugError,
        },
      });
      saveLastFailureState({
        error: debugError,
        failedAt: Date.now(),
        runId: run.id,
      });
      console.error('[syncService] sync failed:', error);
    })
    .finally(() => {
      activeRunPromise = null;
      activeRunState = null;
    });

  return {
    started: true,
    running: true,
    runId: run.id,
    startedAt: run.startedAt,
  };
}

export async function waitForSyncIdle(timeoutMs = 90_000) {
  const running = activeRunPromise;
  if (!running) {
    return true;
  }

  await Promise.race([
    running,
    sleep(timeoutMs),
  ]);

  return activeRunPromise === null;
}

export async function waitForSyncCompletion() {
  const running = activeRunPromise;
  if (!running) {
    return;
  }

  await running;
}

function getLatestRun() {
  const db = getDb();
  return db
    .prepare(
      `SELECT
        id,
        status,
        reason,
        started_at,
        finished_at,
        duration_ms,
        total_addresses,
        successful_addresses,
        failed_addresses,
        error,
        summary_json
      FROM sync_runs
      ORDER BY started_at DESC
      LIMIT 1`
    )
    .get() as SyncRunRow | undefined;
}

export function getSyncStatus() {
  const latestRun = getLatestRun();
  const lastSuccess = readLastSuccessfulSnapshotState();
  const lastFailure = readLastFailedSyncState();
  const windowState = readFeedBackfillWindowState();

  const lastSuccessAt = lastSuccess?.summary?.completedAt ?? null;
  const stale = !lastSuccessAt || Date.now() - lastSuccessAt > DEFAULT_STALE_MS;
  const hasUnresolvedFailure =
    Boolean(lastFailure) &&
    (!lastSuccessAt || (lastFailure?.failedAt ?? 0) > lastSuccessAt);

  const parsedLatestSummary = parseJSON<{
    summary?: ActivityFeedSummary;
    diagnostics?: AddressDiagnostic[];
  }>(latestRun?.summary_json, {});

  return {
    running: Boolean(activeRunState),
    activeRunId: activeRunState?.id ?? null,
    stale,
    lastSuccessAt,
    lastError: hasUnresolvedFailure ? lastFailure?.error || latestRun?.error || null : null,
    lastFailureAt: hasUnresolvedFailure ? lastFailure?.failedAt || null : null,
    latestRun: latestRun
      ? {
          id: latestRun.id,
          status: latestRun.status,
          reason: latestRun.reason,
          startedAt: latestRun.started_at,
          finishedAt: latestRun.finished_at,
          durationMs: latestRun.duration_ms,
          totalAddresses: latestRun.total_addresses,
          successfulAddresses: latestRun.successful_addresses,
          failedAddresses: latestRun.failed_addresses,
          summary: parsedLatestSummary.summary || null,
        }
      : null,
    lastSuccessSnapshot: lastSuccess,
    windowState,
  };
}
