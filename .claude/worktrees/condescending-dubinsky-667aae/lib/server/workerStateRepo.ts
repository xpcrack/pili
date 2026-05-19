import 'server-only';

import { getDb } from '@/lib/server/sqlite';

export function readTelegramIngestCursor(workerKey: string) {
  const db = getDb();
  return db
    .prepare(
      `SELECT worker_key, last_update_id, updated_at_ms
       FROM telegram_ingest_cursors
       WHERE worker_key = ?
       LIMIT 1`
    )
    .get(workerKey) as
    | {
        worker_key: string;
        last_update_id: number;
        updated_at_ms: number;
      }
    | undefined;
}

export function saveTelegramIngestCursor(workerKey: string, lastUpdateId: number) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO telegram_ingest_cursors (worker_key, last_update_id, updated_at_ms)
     VALUES (?, ?, ?)
     ON CONFLICT(worker_key) DO UPDATE SET
       last_update_id = excluded.last_update_id,
       updated_at_ms = excluded.updated_at_ms`
  ).run(workerKey, Math.max(0, Math.floor(lastUpdateId)), now);
}

export function upsertWorkerStatus(input: {
  workerKey: string;
  workerType: string;
  status: string;
  lastUpdateId?: number | null;
  lastError?: string | null;
}) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO worker_status (
       worker_key,
       worker_type,
       status,
       last_heartbeat_at_ms,
       last_update_id,
       last_error,
       updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(worker_key) DO UPDATE SET
       worker_type = excluded.worker_type,
       status = excluded.status,
       last_heartbeat_at_ms = excluded.last_heartbeat_at_ms,
       last_update_id = excluded.last_update_id,
       last_error = excluded.last_error,
       updated_at_ms = excluded.updated_at_ms`
  ).run(
    input.workerKey,
    input.workerType,
    input.status,
    now,
    typeof input.lastUpdateId === 'number' && Number.isFinite(input.lastUpdateId) ? Math.floor(input.lastUpdateId) : null,
    input.lastError ? input.lastError.slice(0, 1000) : null,
    now
  );
}

export function touchWorkerHeartbeat(workerKey: string) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `UPDATE worker_status
     SET last_heartbeat_at_ms = ?,
         updated_at_ms = ?
     WHERE worker_key = ?`
  ).run(now, now, workerKey);
}

export function acquireWorkerLease(input: {
  workerKey: string;
  ownerId: string;
  leaseMs: number;
  nowMs?: number;
}) {
  const db = getDb();
  const nowMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs) ? Math.floor(input.nowMs) : Date.now();
  const leaseMs = Math.max(1_000, Math.floor(input.leaseMs));
  const leaseExpiresAtMs = nowMs + leaseMs;
  const result = db
    .prepare(
      `INSERT INTO worker_leases (worker_key, owner_id, lease_expires_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(worker_key) DO UPDATE SET
         owner_id = excluded.owner_id,
         lease_expires_at_ms = excluded.lease_expires_at_ms,
         updated_at_ms = excluded.updated_at_ms
       WHERE worker_leases.owner_id = excluded.owner_id
          OR worker_leases.lease_expires_at_ms <= excluded.updated_at_ms`
    )
    .run(input.workerKey, input.ownerId, leaseExpiresAtMs, nowMs);

  return result.changes > 0;
}

export function markWorkerUpdateProcessed(input: { workerKey: string; updateId: number; nowMs?: number }) {
  const db = getDb();
  const nowMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs) ? Math.floor(input.nowMs) : Date.now();
  const updateId = Math.floor(input.updateId);
  if (!Number.isFinite(updateId) || updateId <= 0) {
    return true;
  }
  const result = db
    .prepare(
      `INSERT INTO worker_processed_updates (worker_key, update_id, processed_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(worker_key, update_id) DO NOTHING`
    )
    .run(input.workerKey, updateId, nowMs);
  return result.changes > 0;
}
