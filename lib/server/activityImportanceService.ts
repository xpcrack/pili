import 'server-only';

import {
  computeActivityImportance,
  resolveActivityImportanceSourceKind,
  type ActivityImportance,
} from '@/lib/activityImportance';
import { getDb } from '@/lib/server/sqlite';
import type { Activity, User } from '@/types';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface FeedImportanceRow {
  user: User;
  activity: Activity;
  stableId?: string;
}

function normalizeSource(source: Activity['source']) {
  return source === 'blockchain' ? 'wallet' : 'social';
}

function withImportance(activity: Activity, importance: ActivityImportance): Activity {
  return {
    ...activity,
    metadata: {
      ...activity.metadata,
      importance,
    },
  };
}

function countHistoryRows(rows: FeedImportanceRow[], row: FeedImportanceRow) {
  const windowStart = row.activity.timestamp - WINDOW_MS;
  let socialCount7d = 0;
  let walletCount7d = 0;

  for (const candidate of rows) {
    if (candidate.user.id !== row.user.id) continue;
    if (candidate.activity.timestamp < windowStart) continue;
    if (candidate.activity.timestamp >= row.activity.timestamp) continue;
    if (normalizeSource(candidate.activity.source) === 'social') socialCount7d += 1;
    if (normalizeSource(candidate.activity.source) === 'wallet') walletCount7d += 1;
  }

  return { socialCount7d, walletCount7d };
}

function scoreOne(row: FeedImportanceRow, socialCount7d: number, walletCount7d: number): FeedImportanceRow {
  const sourceKind = resolveActivityImportanceSourceKind(row.activity);
  const sourceCount7d = sourceKind === 'social' ? socialCount7d : walletCount7d;
  const importance = computeActivityImportance({
    sourceKind,
    sourceCount7d,
    socialCount7d,
    walletCount7d,
    totalCount7d: socialCount7d + walletCount7d,
    historicalMaxAssetUsd:
      typeof row.user.historicalMaxAssetUsd === 'number' && row.user.historicalMaxAssetUsd > 0
        ? row.user.historicalMaxAssetUsd
        : null,
  });

  return {
    ...row,
    activity: withImportance(row.activity, importance),
  };
}

export function scoreFeedRowsChronologically(rows: FeedImportanceRow[]) {
  const ordered = [...rows].sort((left, right) => {
    const timeDelta = left.activity.timestamp - right.activity.timestamp;
    if (timeDelta !== 0) return timeDelta;
    return (left.stableId || left.activity.id).localeCompare(right.stableId || right.activity.id);
  });

  const scored: FeedImportanceRow[] = [];
  for (const row of ordered) {
    const counts = countHistoryRows(scored, row);
    scored.push(scoreOne(row, counts.socialCount7d, counts.walletCount7d));
  }
  return scored;
}

export function scoreFeedRowsAgainstDatabase(rows: FeedImportanceRow[]) {
  const db = getDb();
  const socialCountStmt = db.prepare(
    `SELECT COUNT(1) AS count
     FROM events
     WHERE user_id = ?
       AND timestamp >= ?
       AND timestamp < ?
       AND source IN ('twitter', 'telegram')`
  );
  const walletCountStmt = db.prepare(
    `SELECT COUNT(1) AS count
     FROM events
     WHERE user_id = ?
       AND timestamp >= ?
       AND timestamp < ?
       AND source = 'blockchain'`
  );

  const ordered = [...rows].sort((left, right) => {
    const timeDelta = left.activity.timestamp - right.activity.timestamp;
    if (timeDelta !== 0) return timeDelta;
    return (left.stableId || left.activity.id).localeCompare(right.stableId || right.activity.id);
  });

  const priorScoredBatch: FeedImportanceRow[] = [];
  return ordered.map((row) => {
    const windowStart = row.activity.timestamp - WINDOW_MS;
    const databaseSocialCount = (
      socialCountStmt.get(row.user.id, windowStart, row.activity.timestamp) as { count: number }
    ).count;
    const databaseWalletCount = (
      walletCountStmt.get(row.user.id, windowStart, row.activity.timestamp) as { count: number }
    ).count;
    const batchCounts = countHistoryRows(priorScoredBatch, row);

    const scored = scoreOne(
      row,
      databaseSocialCount + batchCounts.socialCount7d,
      databaseWalletCount + batchCounts.walletCount7d
    );
    priorScoredBatch.push(scored);
    return scored;
  });
}
