import 'server-only';

import type Database from 'better-sqlite3';

import { getDb } from '@/lib/server/sqlite';

export type ConflictDomain = 'onchain' | 'twitter';
export type ConflictWinner = 'api' | 'opencli';

export interface ConflictDiffItem {
  field: string;
  left: string | null;
  right: string | null;
}

export interface UpsertConflictRecordInput {
  conflictKey: string;
  domain: ConflictDomain;
  eventKey: string;
  winner: ConflictWinner;
  diffJson: ConflictDiffItem[];
}

export interface PendingConflictNotificationRow {
  id: number;
  conflictId: number;
  conflictKey: string;
  status: string;
  attemptCount: number;
  nextRetryAt: number | null;
  lastError: string | null;
  sentAt: number | null;
  createdAt: number;
  updatedAt: number;
  domain: ConflictDomain;
  eventKey: string;
  winner: ConflictWinner;
  diffJson: ConflictDiffItem[];
}

function parseDiffJson(value: string): ConflictDiffItem[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as ConflictDiffItem[]) : [];
  } catch {
    return [];
  }
}

function upsertConflictRecordWithDb(db: Database.Database, input: UpsertConflictRecordInput) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO feed_conflicts (
       conflict_key,
       domain,
       event_key,
       winner,
       diff_json,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conflict_key) DO UPDATE SET
       domain = excluded.domain,
       event_key = excluded.event_key,
       winner = excluded.winner,
       diff_json = excluded.diff_json,
       updated_at = excluded.updated_at`
  ).run(
    input.conflictKey,
    input.domain,
    input.eventKey,
    input.winner,
    JSON.stringify(input.diffJson),
    now,
    now
  );

  const row = db
    .prepare('SELECT id FROM feed_conflicts WHERE conflict_key = ? LIMIT 1')
    .get(input.conflictKey) as { id: number } | undefined;

  if (!row) {
    throw new Error(`failed to upsert feed conflict: ${input.conflictKey}`);
  }

  return row.id as number;
}

export function upsertConflictRecord(input: UpsertConflictRecordInput) {
  const db = getDb();
  return upsertConflictRecordWithDb(db, input);
}

function enqueueConflictNotificationWithDb(
  db: Database.Database,
  conflictId: number,
  conflictKey: string
) {
  const conflict = db
    .prepare('SELECT conflict_key FROM feed_conflicts WHERE id = ? LIMIT 1')
    .get(conflictId) as { conflict_key: string } | undefined;
  if (!conflict) {
    throw new Error(`conflict not found: ${conflictId}`);
  }
  if (conflict.conflict_key !== conflictKey) {
    throw new Error(
      `conflict key mismatch for id ${conflictId}: expected ${conflict.conflict_key}, got ${conflictKey}`
    );
  }

  const now = Date.now();
  db.prepare(
    `INSERT INTO feed_conflict_notifications (
       conflict_id,
       conflict_key,
       status,
       attempt_count,
       next_retry_at,
       created_at,
       updated_at
     ) VALUES (?, ?, 'pending', 0, ?, ?, ?)
     ON CONFLICT(conflict_key) DO NOTHING`
  ).run(conflictId, conflictKey, now, now, now);
}

export function enqueueConflictNotification(conflictId: number, conflictKey: string) {
  const db = getDb();
  enqueueConflictNotificationWithDb(db, conflictId, conflictKey);
}

export function upsertConflictAndEnqueue(input: UpsertConflictRecordInput) {
  const db = getDb();
  const tx = db.transaction(() => {
    const conflictId = upsertConflictRecordWithDb(db, input);
    enqueueConflictNotificationWithDb(db, conflictId, input.conflictKey);
    return conflictId;
  });
  return tx();
}

export function readPendingConflictNotifications(limit: number) {
  const db = getDb();
  const safeLimit = Math.max(1, Math.floor(limit));
  const tx = db.transaction(() => {
    const now = Date.now();
    const candidates = db
      .prepare(
        `SELECT id
         FROM feed_conflict_notifications
         WHERE status = 'pending'
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY id ASC
         LIMIT ?`
      )
      .all(now, safeLimit) as Array<{ id: number }>;

    if (candidates.length === 0) {
      return [] as PendingConflictNotificationRow[];
    }

    const claimStmt = db.prepare(
      `UPDATE feed_conflict_notifications
       SET status = 'sending',
           updated_at = ?
       WHERE id = ?
         AND status = 'pending'
         AND (next_retry_at IS NULL OR next_retry_at <= ?)`
    );

    const claimedIds: number[] = [];
    for (const candidate of candidates) {
      const result = claimStmt.run(now, candidate.id, now);
      if (result.changes === 1) {
        claimedIds.push(candidate.id);
      }
    }

    if (claimedIds.length === 0) {
      return [] as PendingConflictNotificationRow[];
    }

    const placeholders = claimedIds.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT n.id,
                n.conflict_id,
                n.conflict_key,
                n.status,
                n.attempt_count,
                n.next_retry_at,
                n.last_error,
                n.sent_at,
                n.created_at,
                n.updated_at,
                c.domain,
                c.event_key,
                c.winner,
                c.diff_json
         FROM feed_conflict_notifications n
         INNER JOIN feed_conflicts c ON c.id = n.conflict_id
         WHERE n.id IN (${placeholders})
         ORDER BY n.id ASC`
      )
      .all(...claimedIds) as Array<{
      id: number;
      conflict_id: number;
      conflict_key: string;
      status: string;
      attempt_count: number;
      next_retry_at: number | null;
      last_error: string | null;
      sent_at: number | null;
      created_at: number;
      updated_at: number;
      domain: ConflictDomain;
      event_key: string;
      winner: ConflictWinner;
      diff_json: string;
    }>;

    return rows.map((row) => {
      return {
        id: row.id,
        conflictId: row.conflict_id,
        conflictKey: row.conflict_key,
        status: row.status,
        attemptCount: row.attempt_count,
        nextRetryAt: row.next_retry_at,
        lastError: row.last_error,
        sentAt: row.sent_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        domain: row.domain,
        eventKey: row.event_key,
        winner: row.winner,
        diffJson: parseDiffJson(row.diff_json),
      } satisfies PendingConflictNotificationRow;
    });
  });

  return tx();
}

function normalizeAttemptCount(attemptCount: number) {
  if (!Number.isFinite(attemptCount)) {
    return 1;
  }
  return Math.max(1, Math.floor(attemptCount));
}

function truncateErrorMessage(error: string) {
  const normalized = (error || '').trim();
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, 1000);
}

export function markConflictNotificationSent(notificationId: number) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `UPDATE feed_conflict_notifications
     SET status = 'sent',
         sent_at = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(now, now, notificationId);
}

export function markConflictNotificationRetry(
  notificationId: number,
  error: string,
  attemptCount: number
) {
  const db = getDb();
  const now = Date.now();
  const safeAttemptCount = normalizeAttemptCount(attemptCount);
  const retryDelayMs = Math.min(5 * 60 * 1000, 2 ** safeAttemptCount * 1000);
  const nextRetryAt = now + retryDelayMs;
  const lastError = truncateErrorMessage(error);

  db.prepare(
    `UPDATE feed_conflict_notifications
     SET status = 'pending',
         attempt_count = ?,
         next_retry_at = ?,
         last_error = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(safeAttemptCount, nextRetryAt, lastError, now, notificationId);
}
