import 'server-only';

import { getDb } from '@/lib/server/sqlite';
import {
  COMPLETENESS_SOURCES,
  COMPLETENESS_STATUSES,
  COMPLETENESS_TRIGGERS,
  type CompletenessGlobalState,
  type CompletenessPokeRow,
  type CompletenessSource,
  type CompletenessSourceState,
  type CompletenessStatus,
  type CompletenessTrigger,
} from '@/lib/server/completenessTypes';

const COMPLETENESS_SINGLETON_KEY = 'global';

function normalizePositiveInteger(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.floor(value);
}

function normalizeFailureCount(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.floor(value);
}

function normalizeStatus(value: unknown): CompletenessStatus {
  return COMPLETENESS_STATUSES.includes(value as CompletenessStatus)
    ? (value as CompletenessStatus)
    : 'idle';
}

function normalizeTrigger(value: unknown): CompletenessTrigger {
  return COMPLETENESS_TRIGGERS.includes(value as CompletenessTrigger)
    ? (value as CompletenessTrigger)
    : 'manual';
}

function normalizeSource(value: unknown): CompletenessSource | null {
  return COMPLETENESS_SOURCES.includes(value as CompletenessSource)
    ? (value as CompletenessSource)
    : null;
}

function normalizeOptionalString(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function createDefaultGlobalState(): CompletenessGlobalState {
  return {
    configuredStartMs: null,
    globalProvenStartMs: null,
    status: 'idle',
    activeRunId: null,
    lastSuccessAt: null,
    lastFailureAt: null,
  };
}

function readSummaryGlobalProvenStartMs(summary: Record<string, unknown>) {
  return normalizePositiveInteger(summary.globalProvenStartMs);
}

function mapGlobalStateRow(row: {
  configured_start_ms: number | null;
  global_proven_start_ms: number | null;
  status: string;
  active_run_id: number | null;
  last_success_at: number | null;
  last_failure_at: number | null;
}): CompletenessGlobalState {
  return {
    configuredStartMs: normalizePositiveInteger(row.configured_start_ms),
    globalProvenStartMs: normalizePositiveInteger(row.global_proven_start_ms),
    status: normalizeStatus(row.status),
    activeRunId: normalizePositiveInteger(row.active_run_id),
    lastSuccessAt: normalizePositiveInteger(row.last_success_at),
    lastFailureAt: normalizePositiveInteger(row.last_failure_at),
  };
}

function mapSourceStateRow(row: {
  source: string;
  requested_start_ms: number | null;
  proven_start_ms: number | null;
  proven_end_ms: number | null;
  status: string;
  failure_count: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  blocked_reason: string | null;
  checkpoint_json: string | null;
}): CompletenessSourceState | null {
  const source = normalizeSource(row.source);
  if (!source) {
    return null;
  }

  return {
    source,
    requestedStartMs: normalizePositiveInteger(row.requested_start_ms),
    provenStartMs: normalizePositiveInteger(row.proven_start_ms),
    provenEndMs: normalizePositiveInteger(row.proven_end_ms),
    status: normalizeStatus(row.status),
    failureCount: normalizeFailureCount(row.failure_count),
    lastSuccessAt: normalizePositiveInteger(row.last_success_at),
    lastFailureAt: normalizePositiveInteger(row.last_failure_at),
    blockedReason: normalizeOptionalString(row.blocked_reason),
    checkpointJson: normalizeOptionalString(row.checkpoint_json),
  };
}

function mapPokeRow(row: {
  id: number;
  trigger: string;
  source_hint: string | null;
  reason: string | null;
  created_at: number;
  claimed_at: number | null;
}): CompletenessPokeRow {
  return {
    id: row.id,
    trigger: normalizeTrigger(row.trigger),
    sourceHint: normalizeSource(row.source_hint),
    reason: normalizeOptionalString(row.reason),
    createdAt: normalizePositiveInteger(row.created_at) ?? 0,
    claimedAt: normalizePositiveInteger(row.claimed_at),
  };
}

export function readCompletenessGlobalState(): CompletenessGlobalState | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT configured_start_ms,
              global_proven_start_ms,
              status,
              active_run_id,
              last_success_at,
              last_failure_at
       FROM completeness_global_state
       WHERE singleton_key = ?
       LIMIT 1`
    )
    .get(COMPLETENESS_SINGLETON_KEY) as
    | {
        configured_start_ms: number | null;
        global_proven_start_ms: number | null;
        status: string;
        active_run_id: number | null;
        last_success_at: number | null;
        last_failure_at: number | null;
      }
    | undefined;

  return row ? mapGlobalStateRow(row) : null;
}

export function saveCompletenessGlobalState(input: CompletenessGlobalState): void {
  const db = getDb();
  const now = Date.now();

  db.prepare(
    `INSERT INTO completeness_global_state (
       singleton_key,
       configured_start_ms,
       global_proven_start_ms,
       status,
       active_run_id,
       last_success_at,
       last_failure_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(singleton_key) DO UPDATE SET
       configured_start_ms = excluded.configured_start_ms,
       global_proven_start_ms = excluded.global_proven_start_ms,
       status = excluded.status,
       active_run_id = excluded.active_run_id,
       last_success_at = excluded.last_success_at,
       last_failure_at = excluded.last_failure_at,
       updated_at = excluded.updated_at`
  ).run(
    COMPLETENESS_SINGLETON_KEY,
    normalizePositiveInteger(input.configuredStartMs),
    normalizePositiveInteger(input.globalProvenStartMs),
    normalizeStatus(input.status),
    normalizePositiveInteger(input.activeRunId),
    normalizePositiveInteger(input.lastSuccessAt),
    normalizePositiveInteger(input.lastFailureAt),
    now
  );
}

export function readCompletenessSourceStates(): CompletenessSourceState[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT source,
              requested_start_ms,
              proven_start_ms,
              proven_end_ms,
              status,
              failure_count,
              last_success_at,
              last_failure_at,
              blocked_reason,
              checkpoint_json
       FROM completeness_source_state
       ORDER BY source ASC`
    )
    .all() as Array<{
    source: string;
    requested_start_ms: number | null;
    proven_start_ms: number | null;
    proven_end_ms: number | null;
    status: string;
    failure_count: number;
    last_success_at: number | null;
    last_failure_at: number | null;
    blocked_reason: string | null;
    checkpoint_json: string | null;
  }>;

  return rows.map((row) => mapSourceStateRow(row)).filter((row): row is CompletenessSourceState => Boolean(row));
}

export function saveCompletenessSourceState(input: CompletenessSourceState): void {
  const db = getDb();
  const now = Date.now();

  db.prepare(
    `INSERT INTO completeness_source_state (
       source,
       requested_start_ms,
       proven_start_ms,
       proven_end_ms,
       status,
       failure_count,
       last_success_at,
       last_failure_at,
       blocked_reason,
       checkpoint_json,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET
       requested_start_ms = excluded.requested_start_ms,
       proven_start_ms = excluded.proven_start_ms,
       proven_end_ms = excluded.proven_end_ms,
       status = excluded.status,
       failure_count = excluded.failure_count,
       last_success_at = excluded.last_success_at,
       last_failure_at = excluded.last_failure_at,
       blocked_reason = excluded.blocked_reason,
       checkpoint_json = excluded.checkpoint_json,
       updated_at = excluded.updated_at`
  ).run(
    input.source,
    normalizePositiveInteger(input.requestedStartMs),
    normalizePositiveInteger(input.provenStartMs),
    normalizePositiveInteger(input.provenEndMs),
    normalizeStatus(input.status),
    normalizeFailureCount(input.failureCount),
    normalizePositiveInteger(input.lastSuccessAt),
    normalizePositiveInteger(input.lastFailureAt),
    normalizeOptionalString(input.blockedReason),
    normalizeOptionalString(input.checkpointJson),
    now
  );
}

export function createCompletenessRun(input: {
  reason: string | null;
  trigger: CompletenessTrigger;
  configuredStartMs: number | null;
}) {
  const db = getDb();
  const now = Date.now();
  const reason = normalizeOptionalString(input.reason);

  const result = db
    .prepare(
      `INSERT INTO completeness_runs (
         reason,
         trigger,
         configured_start_ms,
         status,
         started_at,
         finished_at,
         global_proven_start_ms,
         summary_json,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, 'running', ?, NULL, NULL, NULL, ?, ?)`
    )
    .run(reason, normalizeTrigger(input.trigger), normalizePositiveInteger(input.configuredStartMs), now, now, now);

  const id = Number(result.lastInsertRowid);
  const globalState = readCompletenessGlobalState() ?? createDefaultGlobalState();
  saveCompletenessGlobalState({
    ...globalState,
    configuredStartMs: normalizePositiveInteger(input.configuredStartMs),
    status: 'running',
    activeRunId: id,
  });

  return { id };
}

export function finishCompletenessRun(
  runId: number,
  status: CompletenessStatus,
  summary: Record<string, unknown>
): void {
  const db = getDb();
  const now = Date.now();
  const normalizedRunId = normalizePositiveInteger(runId);
  if (!normalizedRunId) {
    throw new Error('completeness run id is required');
  }

  const summaryJson = summary === undefined ? null : JSON.stringify(summary);
  const globalProvenStartMs = readSummaryGlobalProvenStartMs(summary);

  const result = db.prepare(
    `UPDATE completeness_runs
     SET status = ?,
         finished_at = ?,
         global_proven_start_ms = ?,
         summary_json = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(normalizeStatus(status), now, globalProvenStartMs, summaryJson, now, normalizedRunId);
  if (result.changes !== 1) {
    throw new Error(`completeness run not found: ${normalizedRunId}`);
  }

  const globalState = readCompletenessGlobalState() ?? createDefaultGlobalState();
  saveCompletenessGlobalState({
    configuredStartMs: globalState.configuredStartMs,
    globalProvenStartMs: globalProvenStartMs ?? globalState.globalProvenStartMs,
    status: normalizeStatus(status),
    activeRunId: null,
    lastSuccessAt: status === 'complete' ? now : globalState.lastSuccessAt,
    lastFailureAt:
      status === 'partial' || status === 'retrying' || status === 'blocked' ? now : globalState.lastFailureAt,
  });
}

export function appendCompletenessRunSource(input: {
  runId: number;
  source: CompletenessSource;
  requestedStartMs: number | null;
  provenStartMs: number | null;
  provenEndMs: number | null;
  status: CompletenessStatus;
  fetchedCount: number;
  storedCount: number;
  projectedCount: number;
  blockedReason: string | null;
  checkpointJson: string | null;
}): void {
  const db = getDb();
  const now = Date.now();

  db.prepare(
    `INSERT INTO completeness_run_sources (
       run_id,
       source,
       requested_start_ms,
       proven_start_ms,
       proven_end_ms,
       status,
       fetched_count,
       stored_count,
       projected_count,
       blocked_reason,
       checkpoint_json,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, source) DO UPDATE SET
       requested_start_ms = excluded.requested_start_ms,
       proven_start_ms = excluded.proven_start_ms,
       proven_end_ms = excluded.proven_end_ms,
       status = excluded.status,
       fetched_count = excluded.fetched_count,
       stored_count = excluded.stored_count,
       projected_count = excluded.projected_count,
       blocked_reason = excluded.blocked_reason,
       checkpoint_json = excluded.checkpoint_json,
       updated_at = excluded.updated_at`
  ).run(
    normalizePositiveInteger(input.runId),
    input.source,
    normalizePositiveInteger(input.requestedStartMs),
    normalizePositiveInteger(input.provenStartMs),
    normalizePositiveInteger(input.provenEndMs),
    normalizeStatus(input.status),
    normalizeFailureCount(input.fetchedCount),
    normalizeFailureCount(input.storedCount),
    normalizeFailureCount(input.projectedCount),
    normalizeOptionalString(input.blockedReason),
    normalizeOptionalString(input.checkpointJson),
    now,
    now
  );
}

export function queueCompletenessPoke(input: {
  trigger: CompletenessTrigger;
  sourceHint: CompletenessSource | null;
  reason: string | null;
}) {
  const db = getDb();
  const now = Date.now();
  const reason = normalizeOptionalString(input.reason);

  const result = db
    .prepare(
      `INSERT INTO completeness_pokes (
         trigger,
         source_hint,
         reason,
         claimed_at,
         created_at
       ) VALUES (?, ?, ?, NULL, ?)`
    )
    .run(normalizeTrigger(input.trigger), normalizeSource(input.sourceHint), reason, now);

  return Number(result.lastInsertRowid);
}

export function readPendingCompletenessPokes(limit: number): CompletenessPokeRow[] {
  const db = getDb();
  const safeLimit = Math.max(1, Math.floor(limit));
  const rows = db
    .prepare(
      `SELECT id, trigger, source_hint, reason, created_at, claimed_at
       FROM completeness_pokes
       WHERE claimed_at IS NULL
       ORDER BY created_at ASC, id ASC
       LIMIT ?`
    )
    .all(safeLimit) as Array<{
    id: number;
    trigger: string;
    source_hint: string | null;
    reason: string | null;
    created_at: number;
    claimed_at: number | null;
  }>;

  return rows.map((row) => mapPokeRow(row));
}

export function claimCompletenessPokes(ids: number[], claimedAt: number): void {
  if (ids.length === 0) {
    return;
  }

  const normalizedIds = ids
    .map((id) => normalizePositiveInteger(id))
    .filter((id): id is number => typeof id === 'number');
  if (normalizedIds.length === 0) {
    return;
  }

  const normalizedClaimedAt = normalizePositiveInteger(claimedAt);
  if (!normalizedClaimedAt) {
    throw new Error('completeness poke claimedAt is required');
  }

  const db = getDb();
  const placeholders = normalizedIds.map(() => '?').join(', ');
  db.prepare(
    `UPDATE completeness_pokes
     SET claimed_at = ?
     WHERE claimed_at IS NULL
       AND id IN (${placeholders})`
  ).run(normalizedClaimedAt, ...normalizedIds);
}

export function releaseClaimedCompletenessPokes(ids: number[]): void {
  if (ids.length === 0) {
    return;
  }

  const normalizedIds = ids
    .map((id) => normalizePositiveInteger(id))
    .filter((id): id is number => typeof id === 'number');
  if (normalizedIds.length === 0) {
    return;
  }

  const db = getDb();
  const placeholders = normalizedIds.map(() => '?').join(', ');
  db.prepare(
    `UPDATE completeness_pokes
     SET claimed_at = NULL
     WHERE claimed_at IS NOT NULL
       AND id IN (${placeholders})`
  ).run(...normalizedIds);
}

export function deleteClaimedCompletenessPokes(ids: number[]): void {
  if (ids.length === 0) {
    return;
  }

  const normalizedIds = ids
    .map((id) => normalizePositiveInteger(id))
    .filter((id): id is number => typeof id === 'number');
  if (normalizedIds.length === 0) {
    return;
  }

  const db = getDb();
  const placeholders = normalizedIds.map(() => '?').join(', ');
  db.prepare(
    `DELETE FROM completeness_pokes
     WHERE claimed_at IS NOT NULL
       AND id IN (${placeholders})`
  ).run(...normalizedIds);
}

export function readRecentCompletenessRuns(limit = 20) {
  const db = getDb();
  const safeLimit = Math.max(1, Math.floor(limit));
  return db
    .prepare(
      `SELECT id,
              reason,
              trigger,
              configured_start_ms,
              status,
              started_at,
              finished_at,
              global_proven_start_ms,
              summary_json
       FROM completeness_runs
       ORDER BY started_at DESC, id DESC
       LIMIT ?`
    )
    .all(safeLimit) as Array<{
    id: number;
    reason: string | null;
    trigger: string;
    configured_start_ms: number | null;
    status: string;
    started_at: number;
    finished_at: number | null;
    global_proven_start_ms: number | null;
    summary_json: string | null;
  }>;
}

export function readCompletenessRunSources(runId: number) {
  const normalizedRunId = normalizePositiveInteger(runId);
  if (!normalizedRunId) {
    return [];
  }

  const db = getDb();
  return db
    .prepare(
      `SELECT run_id,
              source,
              requested_start_ms,
              proven_start_ms,
              proven_end_ms,
              status,
              fetched_count,
              stored_count,
              projected_count,
              blocked_reason,
              checkpoint_json
       FROM completeness_run_sources
       WHERE run_id = ?
       ORDER BY source ASC`
    )
    .all(normalizedRunId) as Array<{
    run_id: number;
    source: string;
    requested_start_ms: number | null;
    proven_start_ms: number | null;
    proven_end_ms: number | null;
    status: string;
    fetched_count: number;
    stored_count: number;
    projected_count: number;
    blocked_reason: string | null;
    checkpoint_json: string | null;
  }>;
}
