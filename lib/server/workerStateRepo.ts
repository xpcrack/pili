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
