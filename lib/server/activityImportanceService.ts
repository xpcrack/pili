import 'server-only';

import { createHash } from 'node:crypto';

import {
  computeActivityImportance,
  resolveActivityImportanceSourceKind,
  type ActivityImportance,
} from '@/lib/activityImportance';
import { getBlockchainActivityIdentity } from '@/lib/activityIdentity';
import { getDb } from '@/lib/server/sqlite';
import type { Activity, User } from '@/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;
const WINDOW_MS = 7 * DAY_MS;

export interface FeedImportanceRow {
  user: User;
  activity: Activity;
  stableId?: string;
}

function normalizeSource(source: Activity['source']) {
  return source === 'blockchain' ? 'wallet' : 'social';
}

function buildBlockchainEventId(activity: Activity) {
  const monitorAggregateKey = (activity.metadata.monitorTxAggregateKey || '').trim();
  if (monitorAggregateKey) {
    return monitorAggregateKey;
  }

  const identity = getBlockchainActivityIdentity(activity);
  if (!identity) {
    return null;
  }

  if (!identity.signatureSeed) {
    return identity.scopedBaseKey;
  }

  const signature = createHash('sha1')
    .update(identity.signatureSeed)
    .digest('hex')
    .slice(0, 12);

  return `${identity.scopedBaseKey}:${signature}`;
}

function buildEventId(user: User, activity: Activity) {
  const tweetId = (activity.metadata.tweetId || '').trim();
  if (tweetId) {
    return `twitter:${tweetId}`;
  }

  const blockchainEventId = buildBlockchainEventId(activity);
  if (blockchainEventId) {
    return blockchainEventId;
  }

  return `${user.id}:${activity.id}`;
}

function readExistingEventIds(eventIds: string[]) {
  const uniqueEventIds = [...new Set(eventIds)];
  if (uniqueEventIds.length === 0) {
    return new Set<string>();
  }

  const db = getDb();
  const existing = new Set<string>();
  const chunkSize = 400;
  for (let i = 0; i < uniqueEventIds.length; i += chunkSize) {
    const chunk = uniqueEventIds.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const stmt = db.prepare(`SELECT event_id FROM events WHERE event_id IN (${placeholders})`);
    const rows = stmt.all(...chunk) as Array<{ event_id: string }>;
    for (const row of rows) {
      existing.add(row.event_id);
    }
  }

  return existing;
}

function sortRowsChronologically(rows: FeedImportanceRow[]) {
  return [...rows].sort((left, right) => {
    const timeDelta = left.activity.timestamp - right.activity.timestamp;
    if (timeDelta !== 0) return timeDelta;
    return (left.stableId || left.activity.id).localeCompare(right.stableId || right.activity.id);
  });
}

function getUtc8DayStart(timestamp: number) {
  const shiftedTimestamp = timestamp + UTC8_OFFSET_MS;
  return Math.floor(shiftedTimestamp / DAY_MS) * DAY_MS - UTC8_OFFSET_MS;
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
  const dayStart = getUtc8DayStart(row.activity.timestamp);
  const windowStart = dayStart - WINDOW_MS;
  let socialCount7d = 0;
  let walletCount7d = 0;

  for (const candidate of rows) {
    if (candidate.user.id !== row.user.id) continue;
    if (candidate.activity.timestamp < windowStart) continue;
    if (candidate.activity.timestamp >= dayStart) continue;
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
    tradeAmountUsdAtTx:
      typeof row.activity.metadata.tradeAmountUsdAtTx === 'number' &&
      Number.isFinite(row.activity.metadata.tradeAmountUsdAtTx) &&
      row.activity.metadata.tradeAmountUsdAtTx > 0
        ? row.activity.metadata.tradeAmountUsdAtTx
        : null,
    contentLength: row.activity.content.trim().length,
  });

  return {
    ...row,
    activity: withImportance(row.activity, importance),
  };
}

/**
 * Score a batch strictly in chronological order (oldest -> newest).
 * Equal timestamps are deterministically ordered by `stableId` (or `activity.id` fallback).
 */
export function scoreFeedRowsChronologically(rows: FeedImportanceRow[]) {
  const ordered = sortRowsChronologically(rows);

  const scored: FeedImportanceRow[] = [];
  for (const row of ordered) {
    const counts = countHistoryRows(scored, row);
    scored.push(scoreOne(row, counts.socialCount7d, counts.walletCount7d));
  }
  return scored;
}

/**
 * Score rows in chronological order (oldest -> newest) using 7d DB history + in-memory batch history.
 * Prior in-memory rows are counted only when they are not already persisted in `events`.
 */
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

  const ordered = sortRowsChronologically(rows);
  const orderedWithEventIds = ordered.map((row) => ({
    row,
    eventId: buildEventId(row.user, row.activity),
  }));
  const existingEventIds = readExistingEventIds(orderedWithEventIds.map(({ eventId }) => eventId));

  const priorUnpersistedBatch: FeedImportanceRow[] = [];
  return orderedWithEventIds.map(({ row, eventId }) => {
    const dayStart = getUtc8DayStart(row.activity.timestamp);
    const windowStart = dayStart - WINDOW_MS;
    const databaseSocialCount = (
      socialCountStmt.get(row.user.id, windowStart, dayStart) as { count: number }
    ).count;
    const databaseWalletCount = (
      walletCountStmt.get(row.user.id, windowStart, dayStart) as { count: number }
    ).count;
    const batchCounts = countHistoryRows(priorUnpersistedBatch, row);

    const scored = scoreOne(
      row,
      databaseSocialCount + batchCounts.socialCount7d,
      databaseWalletCount + batchCounts.walletCount7d
    );
    if (!existingEventIds.has(eventId)) {
      priorUnpersistedBatch.push(scored);
    }
    return scored;
  });
}
