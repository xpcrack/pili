import 'server-only';

import type { TrackedTwitterUser, TwitterCursor, TwitterLane } from '@/lib/server/twitterRepo';
import { computeTwitterSyncWindowDaysFromStartMs } from '@/lib/server/twitterSyncService';

import {
  normalizeCompletenessTimestamp,
  parseCompletenessCheckpoint,
  type CompletenessRunSourceResult,
  type CompletenessSourceAdapter,
} from '@/lib/server/completenessSourceAdapters/types';

interface TwitterCompletenessAdapterDeps {
  now?: () => number;
  listTrackedUsers: () => TrackedTwitterUser[];
  runSyncAction: (input: {
    action: 'sync';
    userId: null;
    windowDays: number;
    force: boolean;
  }) => Promise<{
    ok: boolean;
    error?: string;
    summary?: {
      budgetExhausted?: boolean;
      budgetReasons?: string[];
    };
  }>;
  readCursor: (userId: string, lane: TwitterLane) => TwitterCursor | null;
}

function readUserLaneCoverageStart(
  deps: Pick<TwitterCompletenessAdapterDeps, 'readCursor'>,
  userId: string
) {
  const timelineStart = normalizeCompletenessTimestamp(deps.readCursor(userId, 'timeline')?.coveredSinceMs ?? null);
  const repliesStart = normalizeCompletenessTimestamp(deps.readCursor(userId, 'replies')?.coveredSinceMs ?? null);
  if (timelineStart === null || repliesStart === null) {
    return null;
  }

  return Math.max(timelineStart, repliesStart);
}

function buildCoverageCheckpoint(
  deps: Pick<TwitterCompletenessAdapterDeps, 'readCursor'>,
  users: TrackedTwitterUser[]
) {
  const coverageByUserId: Record<string, { timelineStartMs: number | null; repliesStartMs: number | null }> = {};
  for (const user of users) {
    coverageByUserId[user.id] = {
      timelineStartMs: normalizeCompletenessTimestamp(deps.readCursor(user.id, 'timeline')?.coveredSinceMs ?? null),
      repliesStartMs: normalizeCompletenessTimestamp(deps.readCursor(user.id, 'replies')?.coveredSinceMs ?? null),
    };
  }

  return JSON.stringify({
    coverageByUserId,
  });
}

export function createTwitterCompletenessAdapter(
  deps: TwitterCompletenessAdapterDeps
): CompletenessSourceAdapter {
  return {
    source: 'twitter',
    async runStep(input) {
      const nowMs = deps.now ? deps.now() : Date.now();
      const users = deps.listTrackedUsers();
      if (users.length === 0) {
        return {
          status: 'complete',
          provenStartMs: input.configuredStartMs,
          provenEndMs: nowMs,
          fetchedCount: 0,
          storedCount: 0,
          projectedCount: 0,
          blockedReason: null,
          checkpointJson: JSON.stringify({ coverageByUserId: {} }),
          madeProgress: false,
        };
      }

      const previousCheckpoint = parseCompletenessCheckpoint<{
        coverageByUserId?: Record<string, { timelineStartMs?: number | null; repliesStartMs?: number | null }>;
      }>(input.state.checkpointJson);
      const syncResult = await deps.runSyncAction({
        action: 'sync',
        userId: null,
        windowDays: computeTwitterSyncWindowDaysFromStartMs(input.configuredStartMs, nowMs),
        force: true,
      });

      if (!syncResult.ok) {
        return {
          status: 'retrying',
          provenStartMs: null,
          provenEndMs: null,
          fetchedCount: 0,
          storedCount: 0,
          projectedCount: 0,
          blockedReason: syncResult.error || null,
          checkpointJson: input.state.checkpointJson,
          madeProgress: false,
        };
      }

      let provenStartMs: number | null = null;
      let provenEndMs: number | null = null;
      let madeProgress = false;
      const checkpointJson = buildCoverageCheckpoint(deps, users);
      for (const user of users) {
        const userCoverageStart = readUserLaneCoverageStart(deps, user.id);
        const lastSuccessAtMs = Math.min(
          normalizeCompletenessTimestamp(deps.readCursor(user.id, 'timeline')?.lastSuccessAtMs ?? null) ?? nowMs,
          normalizeCompletenessTimestamp(deps.readCursor(user.id, 'replies')?.lastSuccessAtMs ?? null) ?? nowMs
        );
        if (typeof lastSuccessAtMs === 'number' && (provenEndMs === null || lastSuccessAtMs < provenEndMs)) {
          provenEndMs = lastSuccessAtMs;
        }

        if (userCoverageStart === null) {
          provenStartMs = null;
          continue;
        }

        provenStartMs = provenStartMs === null ? userCoverageStart : Math.max(provenStartMs, userCoverageStart);
        const previousUserCoverage = previousCheckpoint?.coverageByUserId?.[user.id];
        const previousTimelineStart = normalizeCompletenessTimestamp(previousUserCoverage?.timelineStartMs ?? null);
        const previousRepliesStart = normalizeCompletenessTimestamp(previousUserCoverage?.repliesStartMs ?? null);
        const previousWorstLane =
          typeof previousTimelineStart === 'number' && typeof previousRepliesStart === 'number'
            ? Math.max(previousTimelineStart, previousRepliesStart)
            : null;
        if (previousWorstLane === null || userCoverageStart < previousWorstLane) {
          madeProgress = true;
        }
      }

      const budgetExhausted = syncResult.summary?.budgetExhausted === true;

      return {
        status:
          !budgetExhausted &&
          typeof provenStartMs === 'number' &&
          provenStartMs <= input.configuredStartMs
            ? 'complete'
            : 'partial',
        provenStartMs,
        provenEndMs,
        fetchedCount: 0,
        storedCount: 0,
        projectedCount: 0,
        blockedReason: budgetExhausted ? (syncResult.summary?.budgetReasons || []).join(', ') || 'budget_exhausted' : null,
        checkpointJson,
        madeProgress,
      } satisfies CompletenessRunSourceResult;
    },
  };
}
