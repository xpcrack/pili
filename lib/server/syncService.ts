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
  replaceFeedSnapshot,
  saveFeedBackfillWindowState,
  saveLastFailureState,
  saveLastSuccessfulSnapshotState,
  upsertActivityJudgments,
  upsertFeedSnapshot,
  upsertRawTransactions,
  type FeedBackfillWindowState,
} from '@/lib/server/feedSnapshotRepo';
import { getDb } from '@/lib/server/sqlite';
import {
  listTrackedUsers,
  markAddressesSynced,
  updateAssetSnapshots,
} from '@/lib/server/trackedUsersRepo';

const DEFAULT_STALE_MS = 30 * 60 * 1000;
const INITIAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const BACKFILL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type SyncMode = 'refresh' | 'backfill';
type BackfillScope = 'global' | 'user';

interface TriggerSyncOptions {
  mode?: SyncMode;
  scope?: BackfillScope;
  userId?: string | null;
}

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizeSyncOptions(options: TriggerSyncOptions | undefined) {
  const mode: SyncMode = options?.mode === 'backfill' ? 'backfill' : 'refresh';
  const scope: BackfillScope = options?.scope === 'user' ? 'user' : 'global';
  const userId = typeof options?.userId === 'string' && options.userId.trim() ? options.userId.trim() : null;

  if (mode !== 'backfill') {
    return {
      mode,
      scope: 'global' as const,
      userId: null,
    };
  }

  if (scope === 'user' && userId) {
    return {
      mode,
      scope,
      userId,
    };
  }

  return {
    mode,
    scope: 'global' as const,
    userId: null,
  };
}

function createDefaultWindowState(): FeedBackfillWindowState {
  return {
    globalEarliestMs: null,
    perUserEarliestMs: {},
    globalAlignment: 'aligned',
    updatedAt: Date.now(),
  };
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

function applyRefreshWindowState(users: ReturnType<typeof listTrackedUsers>, beginMs: number) {
  const perUserEarliestMs: Record<string, number> = {};
  for (const user of users) {
    perUserEarliestMs[user.id] = beginMs;
  }

  return {
    globalEarliestMs: beginMs,
    perUserEarliestMs,
    globalAlignment: 'aligned' as const,
    updatedAt: Date.now(),
  } satisfies FeedBackfillWindowState;
}

function mergeRefreshWindowState(
  current: FeedBackfillWindowState,
  users: ReturnType<typeof listTrackedUsers>,
  beginMs: number,
  diagnostics: AddressDiagnostic[]
) {
  const nextPerUserEarliest = {
    ...current.perUserEarliestMs,
  };

  for (const user of users) {
    if (typeof nextPerUserEarliest[user.id] === 'number') {
      continue;
    }
    nextPerUserEarliest[user.id] = beginMs;
  }

  return {
    globalEarliestMs: current.globalEarliestMs ?? beginMs,
    perUserEarliestMs: nextPerUserEarliest,
    globalAlignment: diagnostics.some((item) => !item.ok) ? 'partial' : 'aligned',
    updatedAt: Date.now(),
  } satisfies FeedBackfillWindowState;
}

function applyGlobalBackfillWindowState(
  current: FeedBackfillWindowState,
  users: ReturnType<typeof listTrackedUsers>,
  beginMs: number,
  diagnostics: AddressDiagnostic[]
) {
  const successfulUserIds = new Set(
    diagnostics
      .filter((item) => item.ok)
      .map((item) => item.userId)
  );

  const next = {
    ...current,
    perUserEarliestMs: {
      ...current.perUserEarliestMs,
    },
    updatedAt: Date.now(),
  };

  if (successfulUserIds.size > 0) {
    next.globalEarliestMs = beginMs;
  }

  for (const user of users) {
    if (!successfulUserIds.has(user.id)) {
      continue;
    }
    next.perUserEarliestMs[user.id] = beginMs;
  }

  next.globalAlignment = diagnostics.some((item) => !item.ok) ? 'partial' : 'aligned';
  return next;
}

function applyUserBackfillWindowState(
  current: FeedBackfillWindowState,
  userId: string,
  beginMs: number,
  diagnostics: AddressDiagnostic[]
) {
  const hasSuccess = diagnostics.some((item) => item.ok);
  if (!hasSuccess) {
    return {
      ...current,
      updatedAt: Date.now(),
    } satisfies FeedBackfillWindowState;
  }

  return {
    ...current,
    perUserEarliestMs: {
      ...current.perUserEarliestMs,
      [userId]: beginMs,
    },
    updatedAt: Date.now(),
  } satisfies FeedBackfillWindowState;
}

async function runSync(
  runId: number,
  reason: string,
  startedAt: number,
  options: Required<Pick<TriggerSyncOptions, 'mode' | 'scope'>> & { userId: string | null }
) {
  const users = listTrackedUsers();
  const totalAddresses = users.reduce((sum, user) => sum + user.addresses.length, 0);

  if (users.length === 0 || totalAddresses === 0) {
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
    return;
  }

  const now = Date.now();
  const currentWindowState = readFeedBackfillWindowState() || createDefaultWindowState();

  let targetUsers = users;
  let beginMs = Math.max(0, now - INITIAL_WINDOW_MS);
  let endMs = now;
  let writeMode: 'replace' | 'append' = 'replace';

  if (options.mode === 'backfill') {
    writeMode = 'append';

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

  if (targetUsers.length === 0) {
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
    return;
  }

  const result = await buildActivityFeed(targetUsers, {
    beginMs,
    endMs,
    requireTrackedInitiator: true,
  });

  // Persist parser artifacts for compatibility/audit flows, but keep result.feed
  // as the semantic snapshot source of truth that readFeedSnapshot returns by default.
  upsertRawTransactions(result.rawTransactions);
  upsertActivityJudgments(result.judgments);
  if (writeMode === 'replace') {
    replaceFeedSnapshot(result.feed);
  } else {
    upsertFeedSnapshot(result.feed);
  }
  updateAssetSnapshots(result.addressAssets, result.userAssets);

  const syncedAt = Date.now();
  markAddressesSynced(
    result.diagnostics
      .filter((item) => item.ok)
      .map((item) => ({
        chain: item.chain,
        address: item.address,
        syncedAt,
      }))
  );

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
