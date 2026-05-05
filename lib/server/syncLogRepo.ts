import 'server-only';

import { getDb } from '@/lib/server/sqlite';

export type SyncLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type SyncRunKind = 'sync' | 'twitter' | 'completeness';

export interface SyncLogInput {
  runKind: SyncRunKind;
  runId?: number | null;
  level: SyncLogLevel;
  phase?: string | null;
  message: string;
  payload?: Record<string, unknown> | null;
}

export interface SyncLogQuery {
  runKind?: SyncRunKind | null;
  runId?: number | null;
  afterId?: number | null;
  limit?: number;
}

export interface SyncLogRow {
  id: number;
  runKind: SyncRunKind;
  runId: number | null;
  level: SyncLogLevel;
  phase: string | null;
  message: string;
  payload: Record<string, unknown> | null;
  createdAt: number;
}

function parsePayload(value: string | null | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore invalid payload
  }
  return null;
}

export function appendSyncLog(input: SyncLogInput) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO sync_logs (
      run_kind,
      run_id,
      level,
      phase,
      message,
      payload_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.runKind,
    typeof input.runId === 'number' && Number.isFinite(input.runId) ? Math.floor(input.runId) : null,
    input.level,
    input.phase || null,
    input.message,
    input.payload ? JSON.stringify(input.payload) : null,
    now
  );
}

export function readSyncLogs(query: SyncLogQuery = {}) {
  const db = getDb();
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (query.runKind) {
    where.push('run_kind = ?');
    params.push(query.runKind);
  }

  if (typeof query.runId === 'number' && Number.isFinite(query.runId)) {
    where.push('run_id = ?');
    params.push(Math.floor(query.runId));
  }

  if (typeof query.afterId === 'number' && Number.isFinite(query.afterId) && query.afterId > 0) {
    where.push('id > ?');
    params.push(Math.floor(query.afterId));
  }

  const limit = Math.max(1, Math.min(500, Math.floor(query.limit || 200)));
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `SELECT
         id,
         run_kind,
         run_id,
         level,
         phase,
         message,
         payload_json,
         created_at
       FROM sync_logs
       ${whereSql}
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(...params, limit) as Array<{
    id: number;
    run_kind: SyncRunKind;
    run_id: number | null;
    level: SyncLogLevel;
    phase: string | null;
    message: string;
    payload_json: string | null;
    created_at: number;
  }>;

  return rows
    .reverse()
    .map((row) => ({
      id: row.id,
      runKind: row.run_kind,
      runId: row.run_id,
      level: row.level,
      phase: row.phase,
      message: row.message,
      payload: parsePayload(row.payload_json),
      createdAt: row.created_at,
    })) as SyncLogRow[];
}

export function pruneSyncLogs(maxRows = 5000) {
  const db = getDb();
  const safeMaxRows = Math.max(1000, Math.min(20000, Math.floor(maxRows)));
  db.prepare(
    `DELETE FROM sync_logs
     WHERE id NOT IN (
       SELECT id
       FROM sync_logs
       ORDER BY id DESC
       LIMIT ?
     )`
  ).run(safeMaxRows);
}
