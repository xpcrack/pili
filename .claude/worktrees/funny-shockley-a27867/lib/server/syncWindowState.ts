import type { AddressDiagnostic } from '@/lib/activityFeed';
import type { FeedBackfillWindowState } from '@/lib/server/feedSnapshotRepo';

export type SyncMode = 'refresh' | 'backfill';
export type BackfillScope = 'global' | 'user';

export interface TriggerSyncOptions {
  mode?: SyncMode;
  scope?: BackfillScope;
  userId?: string | null;
}

type SyncWindowUser = {
  id: string;
};

type SyncWindowDiagnostic = Pick<AddressDiagnostic, 'userId' | 'ok'>;

export function normalizeSyncOptions(options: TriggerSyncOptions | undefined) {
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

export function createDefaultWindowState(): FeedBackfillWindowState {
  return {
    globalEarliestMs: null,
    perUserEarliestMs: {},
    perUserHistoryComplete: {},
    perUserLastBackfillAt: {},
    perUserLocalQualifiedCount: {},
    globalAlignment: 'aligned',
    updatedAt: Date.now(),
  };
}

function getSuccessfulUserIds(diagnostics: ReadonlyArray<SyncWindowDiagnostic>) {
  return new Set(
    diagnostics
      .filter((item) => item.ok)
      .map((item) => item.userId)
  );
}

function getFullySuccessfulUserIds(diagnostics: ReadonlyArray<SyncWindowDiagnostic>) {
  const stats = new Map<string, { hasSuccess: boolean; hasFailure: boolean }>();
  for (const item of diagnostics) {
    const existing = stats.get(item.userId) ?? { hasSuccess: false, hasFailure: false };
    if (item.ok) {
      existing.hasSuccess = true;
    } else {
      existing.hasFailure = true;
    }
    stats.set(item.userId, existing);
  }

  return new Set(
    Array.from(stats.entries())
      .filter(([, value]) => value.hasSuccess && !value.hasFailure)
      .map(([userId]) => userId)
  );
}

export function applyRefreshWindowState(users: ReadonlyArray<SyncWindowUser>, beginMs: number) {
  const perUserEarliestMs: Record<string, number> = {};
  const perUserHistoryComplete: Record<string, boolean> = {};
  const perUserLastBackfillAt: Record<string, number> = {};
  const perUserLocalQualifiedCount: Record<string, number> = {};
  for (const user of users) {
    perUserEarliestMs[user.id] = beginMs;
    perUserHistoryComplete[user.id] = false;
    perUserLastBackfillAt[user.id] = 0;
    perUserLocalQualifiedCount[user.id] = 0;
  }

  return {
    globalEarliestMs: beginMs,
    perUserEarliestMs,
    perUserHistoryComplete,
    perUserLastBackfillAt,
    perUserLocalQualifiedCount,
    globalAlignment: 'aligned' as const,
    updatedAt: Date.now(),
  } satisfies FeedBackfillWindowState;
}

export function mergeRefreshWindowState(
  current: FeedBackfillWindowState,
  users: ReadonlyArray<SyncWindowUser>,
  beginMs: number,
  diagnostics: ReadonlyArray<SyncWindowDiagnostic>
) {
  const nextPerUserEarliest = {
    ...current.perUserEarliestMs,
  };
  const nextPerUserHistoryComplete = {
    ...current.perUserHistoryComplete,
  };
  const nextPerUserLastBackfillAt = {
    ...current.perUserLastBackfillAt,
  };
  const nextPerUserLocalQualifiedCount = {
    ...current.perUserLocalQualifiedCount,
  };

  for (const user of users) {
    if (typeof nextPerUserEarliest[user.id] === 'number') {
      nextPerUserHistoryComplete[user.id] = nextPerUserHistoryComplete[user.id] === true;
      nextPerUserLastBackfillAt[user.id] = nextPerUserLastBackfillAt[user.id] ?? 0;
      nextPerUserLocalQualifiedCount[user.id] = nextPerUserLocalQualifiedCount[user.id] ?? 0;
      continue;
    }
    nextPerUserEarliest[user.id] = beginMs;
    nextPerUserHistoryComplete[user.id] = false;
    nextPerUserLastBackfillAt[user.id] = 0;
    nextPerUserLocalQualifiedCount[user.id] = 0;
  }

  return {
    globalEarliestMs: current.globalEarliestMs ?? beginMs,
    perUserEarliestMs: nextPerUserEarliest,
    perUserHistoryComplete: nextPerUserHistoryComplete,
    perUserLastBackfillAt: nextPerUserLastBackfillAt,
    perUserLocalQualifiedCount: nextPerUserLocalQualifiedCount,
    globalAlignment: diagnostics.some((item) => !item.ok) ? 'partial' : 'aligned',
    updatedAt: Date.now(),
  } satisfies FeedBackfillWindowState;
}

export function applyGlobalBackfillWindowState(
  current: FeedBackfillWindowState,
  users: ReadonlyArray<SyncWindowUser>,
  beginMs: number,
  diagnostics: ReadonlyArray<SyncWindowDiagnostic>
) {
  const successfulUserIds = getSuccessfulUserIds(diagnostics);
  const fullySuccessfulUserIds = getFullySuccessfulUserIds(diagnostics);

  const next = {
    ...current,
    perUserEarliestMs: {
      ...current.perUserEarliestMs,
    },
    perUserHistoryComplete: {
      ...current.perUserHistoryComplete,
    },
    perUserLastBackfillAt: {
      ...current.perUserLastBackfillAt,
    },
    perUserLocalQualifiedCount: {
      ...current.perUserLocalQualifiedCount,
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
    next.perUserLastBackfillAt[user.id] = Date.now();
    if (beginMs === 0 && fullySuccessfulUserIds.has(user.id)) {
      next.perUserHistoryComplete[user.id] = true;
    }
  }

  next.globalAlignment = diagnostics.some((item) => !item.ok) ? 'partial' : 'aligned';
  return next;
}

export function applyUserBackfillWindowState(
  current: FeedBackfillWindowState,
  userId: string,
  beginMs: number,
  diagnostics: ReadonlyArray<SyncWindowDiagnostic>
) {
  const successfulUserIds = getSuccessfulUserIds(diagnostics);
  const fullySuccessfulUserIds = getFullySuccessfulUserIds(diagnostics);
  const hasSuccess = successfulUserIds.has(userId);
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
    perUserHistoryComplete: {
      ...current.perUserHistoryComplete,
      [userId]:
        beginMs === 0 && fullySuccessfulUserIds.has(userId)
          ? true
          : current.perUserHistoryComplete[userId] === true,
    },
    perUserLastBackfillAt: {
      ...current.perUserLastBackfillAt,
      [userId]: Date.now(),
    },
    perUserLocalQualifiedCount: {
      ...current.perUserLocalQualifiedCount,
    },
    updatedAt: Date.now(),
  } satisfies FeedBackfillWindowState;
}
