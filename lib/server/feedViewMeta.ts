import 'server-only';

import { readCompletenessSourceStates } from '@/lib/server/completenessRepo';
import { computeGlobalProvenEndMs, computeGlobalProvenStartMs } from '@/lib/server/completenessStatus';
import { COMPLETENESS_SOURCES, type CompletenessSourceState } from '@/lib/server/completenessTypes';
import { readFeedBackfillWindowState, type FeedBackfillWindowState } from '@/lib/server/feedSnapshotRepo';
import { getDb } from '@/lib/server/sqlite';
import { readSystemConfig } from '@/lib/server/systemConfigRepo';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import { normalizeTwitterHandle } from '@/lib/userProfile';

export interface ActivityBreakdown {
  twitterCount: number;
  tradeCount: number;
}

export interface CompletenessWindow {
  scope: 'global' | 'user';
  startMs: number | null;
  endMs: number | null;
  label: string | null;
  complete: boolean;
}

interface BuildCompletenessWindowInput {
  scope: 'global' | 'user';
  userId?: string | null;
  endMs?: number | null;
  windowState?: FeedBackfillWindowState | null;
  requiredSourceStarts?: Array<number | null | undefined>;
  completeOverride?: boolean;
}

function normalizeTimestamp(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function mergeCompletenessSourceStates(sourceStates: CompletenessSourceState[]) {
  const stateBySource = new Map(sourceStates.map((state) => [state.source, state]));
  return COMPLETENESS_SOURCES.map(
    (source) =>
      stateBySource.get(source) || {
        source,
        requestedStartMs: null,
        provenStartMs: null,
        provenEndMs: null,
        status: 'idle' as const,
        failureCount: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        blockedReason: null,
        checkpointJson: null,
      }
  );
}

function formatShanghaiTimestamp(ms: number) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));

  const get = (type: string) => parts.find((part) => part.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function buildCompletenessLabel(startMs: number | null, endMs: number | null) {
  if (startMs === null || endMs === null) {
    return null;
  }

  return formatShanghaiTimestamp(startMs);
}

export function computeTwitterBackfillWindowDays(startMs: number | null | undefined, nowMs = Date.now()) {
  const normalizedStartMs = normalizeTimestamp(startMs);
  const normalizedNowMs = normalizeTimestamp(nowMs);
  if (normalizedStartMs === null || normalizedNowMs === null || normalizedNowMs <= normalizedStartMs) {
    return 7;
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  const rawDays = Math.ceil((normalizedNowMs - normalizedStartMs) / DAY_MS);
  return Math.max(1, Math.min(30, rawDays));
}

export function resolveUnifiedWindowStartMs(
  primaryStartMs: number | null | undefined,
  requiredSourceStarts: Array<number | null | undefined> = []
) {
  const baseStartMs = normalizeTimestamp(primaryStartMs);
  if (baseStartMs === null) {
    return null;
  }

  let resolvedStartMs = baseStartMs;
  for (const sourceStart of requiredSourceStarts) {
    const normalizedSourceStart = normalizeTimestamp(sourceStart);
    if (normalizedSourceStart === null) {
      return null;
    }
    if (normalizedSourceStart > resolvedStartMs) {
      resolvedStartMs = normalizedSourceStart;
    }
  }

  return resolvedStartMs;
}

export function resolveTwitterCoverageStartMs(
  rows: Array<{ lane: 'timeline' | 'replies'; coveredSinceMs: number | null | undefined }>
) {
  const laneStarts = new Map<'timeline' | 'replies', number | null>();
  for (const row of rows) {
    laneStarts.set(row.lane, normalizeTimestamp(row.coveredSinceMs));
  }

  if (!laneStarts.has('timeline') || !laneStarts.has('replies')) {
    return null;
  }

  const timelineStart = laneStarts.get('timeline') ?? null;
  const repliesStart = laneStarts.get('replies') ?? null;
  if (timelineStart === null || repliesStart === null) {
    return null;
  }

  return Math.max(timelineStart, repliesStart);
}

function readTwitterCoverageStartByUser() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT user_id, lane, covered_since_ms
       FROM twitter_sync_cursor`
    )
    .all() as Array<{ user_id: string; lane: 'timeline' | 'replies'; covered_since_ms: number | null }>;

  const grouped = new Map<string, Array<{ lane: 'timeline' | 'replies'; coveredSinceMs: number | null }>>();
  for (const row of rows) {
    const userId = (row.user_id || '').trim();
    if (!userId) {
      continue;
    }
    const existing = grouped.get(userId) || [];
    existing.push({
      lane: row.lane === 'replies' ? 'replies' : 'timeline',
      coveredSinceMs: row.covered_since_ms,
    });
    grouped.set(userId, existing);
  }

  const result: Record<string, number> = {};
  for (const [userId, cursorRows] of grouped.entries()) {
    const coverageStart = resolveTwitterCoverageStartMs(cursorRows);
    if (coverageStart === null) {
      continue;
    }
    result[userId] = coverageStart;
  }

  return result;
}

export function readActivityBreakdownByUser(userId: string): ActivityBreakdown {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    return {
      twitterCount: 0,
      tradeCount: 0,
    };
  }

  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN source = 'twitter' THEN 1 ELSE 0 END) AS twitter_count,
         SUM(CASE WHEN source = 'blockchain' THEN 1 ELSE 0 END) AS trade_count
       FROM activity_feed
       WHERE user_id = ?`
    )
    .get(normalizedUserId) as
    | {
        twitter_count: number | null;
        trade_count: number | null;
      }
    | undefined;

  return {
    twitterCount: row?.twitter_count ?? 0,
    tradeCount: row?.trade_count ?? 0,
  };
}

export function buildCompletenessWindow(input: BuildCompletenessWindowInput): CompletenessWindow {
  const windowState = input.windowState ?? null;
  const scope = input.scope;
  const primaryStartMs = normalizeTimestamp(
    scope === 'user' && input.userId
      ? windowState?.perUserEarliestMs?.[input.userId]
      : windowState?.globalEarliestMs
  );
  const startMs = resolveUnifiedWindowStartMs(primaryStartMs, input.requiredSourceStarts || []);
  const endMs = normalizeTimestamp(input.endMs);
  const complete =
    typeof input.completeOverride === 'boolean'
      ? input.completeOverride
      : startMs !== null &&
        endMs !== null &&
        (scope === 'global' ? windowState?.globalAlignment !== 'partial' : true);

  return {
    scope,
    startMs,
    endMs,
    label: buildCompletenessLabel(startMs, endMs),
    complete,
  };
}

export function readFeedViewMeta(options?: { userId?: string | null; endMs?: number | null }) {
  const userId = typeof options?.userId === 'string' && options.userId.trim() ? options.userId.trim() : null;
  const systemConfig = readSystemConfig();
  const configuredStartMs =
    typeof systemConfig.completenessStartMs === 'number' && Number.isFinite(systemConfig.completenessStartMs)
      ? systemConfig.completenessStartMs
      : null;
  if (configuredStartMs !== null) {
    const sourceStates = mergeCompletenessSourceStates(readCompletenessSourceStates());
    const globalProvenStartMs = computeGlobalProvenStartMs(sourceStates);
    const globalProvenEndMs = computeGlobalProvenEndMs(sourceStates);
    const requestedEndMs = normalizeTimestamp(options?.endMs);
    const complete =
      sourceStates.length > 0 &&
      sourceStates.every(
        (sourceState) =>
          typeof sourceState.provenStartMs === 'number' &&
          Number.isFinite(sourceState.provenStartMs) &&
          sourceState.provenStartMs <= configuredStartMs
      ) &&
      globalProvenEndMs !== null &&
      (requestedEndMs === null || globalProvenEndMs >= requestedEndMs);
    const effectiveEndMs =
      globalProvenEndMs === null
        ? null
        : requestedEndMs === null
          ? globalProvenEndMs
          : Math.min(requestedEndMs, globalProvenEndMs);
    return {
      activityBreakdown: userId ? readActivityBreakdownByUser(userId) : null,
      completenessWindow: buildCompletenessWindow({
        scope: userId ? 'user' : 'global',
        userId,
        endMs: effectiveEndMs,
        windowState: {
          globalEarliestMs: globalProvenStartMs,
          perUserEarliestMs:
            userId && globalProvenStartMs !== null
              ? {
                  [userId]: globalProvenStartMs,
                }
              : {},
          perUserHistoryComplete: {},
          perUserLastBackfillAt: {},
          perUserLocalQualifiedCount: {},
          globalAlignment: complete ? 'aligned' : 'partial',
          updatedAt: Date.now(),
        },
        requiredSourceStarts: [],
        completeOverride: complete,
      }),
    };
  }

  const windowState = readFeedBackfillWindowState();
  const users = listTrackedUsers();
  const scopedUsers = userId ? users.filter((user) => user.id === userId) : users;
  const twitterStartsByUser = readTwitterCoverageStartByUser();
  const requiredSourceStarts = scopedUsers
    .filter((user) => Boolean(normalizeTwitterHandle(user.twitter || '')))
    .map((user) => twitterStartsByUser[user.id] ?? null);

  return {
    activityBreakdown: userId ? readActivityBreakdownByUser(userId) : null,
    completenessWindow: buildCompletenessWindow({
      scope: userId ? 'user' : 'global',
      userId,
      endMs: options?.endMs ?? null,
      windowState,
      requiredSourceStarts,
    }),
  };
}
