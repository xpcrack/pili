import 'server-only';

import { getDb } from '@/lib/server/sqlite';

export interface TwitterIdentityCacheRow {
  handle: string;
  provider: string;
  userId: string | null;
  username: string | null;
  resolvedAtMs: number;
  expiresAtMs: number | null;
  lastError: string | null;
  updatedAtMs: number;
}

export interface TwitterProviderBudgetSnapshot {
  provider: string;
  credentialId: string;
  dateKey: string;
  successUnitsUsed: number;
  dailyLimit: number;
  remainingUnits: number;
  cooldownUntilMs: number | null;
  lastSuccessAtMs: number | null;
  lastFailureAtMs: number | null;
  lastError: string | null;
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

export function getTwitterDateKey(nowMs: number) {
  const utc8Date = new Date(nowMs + 8 * 60 * 60 * 1000);
  return `${utc8Date.getUTCFullYear()}-${pad(utc8Date.getUTCMonth() + 1)}-${pad(utc8Date.getUTCDate())}`;
}

export function readTwitterIdentityCache(handle: string): TwitterIdentityCacheRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         handle,
         provider,
         user_id,
         username,
         resolved_at_ms,
         expires_at_ms,
         last_error,
         updated_at_ms
       FROM twitter_identity_cache
       WHERE handle = ?
       LIMIT 1`
    )
    .get(normalize(handle)) as
    | {
        handle: string;
        provider: string;
        user_id: string | null;
        username: string | null;
        resolved_at_ms: number;
        expires_at_ms: number | null;
        last_error: string | null;
        updated_at_ms: number;
      }
    | undefined;

  if (!row) {
    return null;
  }

  if (typeof row.expires_at_ms === 'number' && row.expires_at_ms <= Date.now()) {
    return null;
  }

  return {
    handle: row.handle,
    provider: row.provider,
    userId: row.user_id,
    username: row.username,
    resolvedAtMs: row.resolved_at_ms,
    expiresAtMs: row.expires_at_ms,
    lastError: row.last_error,
    updatedAtMs: row.updated_at_ms,
  };
}

export function upsertTwitterIdentityCache(input: {
  handle: string;
  provider: string;
  userId: string | null;
  username: string | null;
  expiresAtMs: number | null;
  lastError: string | null;
}) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO twitter_identity_cache (
       handle,
       provider,
       user_id,
       username,
       resolved_at_ms,
       expires_at_ms,
       last_error,
       updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(handle) DO UPDATE SET
       provider = excluded.provider,
       user_id = excluded.user_id,
       username = excluded.username,
       resolved_at_ms = excluded.resolved_at_ms,
       expires_at_ms = excluded.expires_at_ms,
       last_error = excluded.last_error,
       updated_at_ms = excluded.updated_at_ms`
  ).run(
    normalize(input.handle),
    input.provider,
    input.userId,
    input.username,
    now,
    input.expiresAtMs,
    input.lastError,
    now
  );
}

export function readTwitterProviderBudgetSnapshot(input: {
  provider: string;
  credentialId: string;
  nowMs: number;
  dailyLimit: number;
}): TwitterProviderBudgetSnapshot {
  const db = getDb();
  const dateKey = getTwitterDateKey(input.nowMs);
  const row = db
    .prepare(
      `SELECT
         provider,
         credential_id,
         date_key,
         success_units_used,
         daily_limit,
         cooldown_until_ms,
         last_success_at_ms,
         last_failure_at_ms,
         last_error
       FROM twitter_provider_budget
       WHERE provider = ?
         AND credential_id = ?
         AND date_key = ?
       LIMIT 1`
    )
    .get(input.provider, input.credentialId, dateKey) as
    | {
        provider: string;
        credential_id: string;
        date_key: string;
        success_units_used: number;
        daily_limit: number;
        cooldown_until_ms: number | null;
        last_success_at_ms: number | null;
        last_failure_at_ms: number | null;
        last_error: string | null;
      }
    | undefined;

  const successUnitsUsed = row?.success_units_used || 0;
  const dailyLimit = row?.daily_limit || input.dailyLimit;
  return {
    provider: input.provider,
    credentialId: input.credentialId,
    dateKey,
    successUnitsUsed,
    dailyLimit,
    remainingUnits: Math.max(0, dailyLimit - successUnitsUsed),
    cooldownUntilMs: row?.cooldown_until_ms || null,
    lastSuccessAtMs: row?.last_success_at_ms || null,
    lastFailureAtMs: row?.last_failure_at_ms || null,
    lastError: row?.last_error || null,
  };
}

export function markTwitterProviderSuccess(input: {
  provider: string;
  credentialId: string;
  nowMs: number;
  dailyLimit: number;
  successUnits?: number;
}) {
  const db = getDb();
  const dateKey = getTwitterDateKey(input.nowMs);
  const successUnits = Math.max(1, Math.floor(input.successUnits || 1));
  db.prepare(
    `INSERT INTO twitter_provider_budget (
       provider,
       credential_id,
       date_key,
       success_units_used,
       daily_limit,
       cooldown_until_ms,
       last_success_at_ms,
       last_failure_at_ms,
       last_error,
       updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?)
     ON CONFLICT(provider, credential_id, date_key) DO UPDATE SET
       success_units_used = twitter_provider_budget.success_units_used + excluded.success_units_used,
       daily_limit = excluded.daily_limit,
       cooldown_until_ms = NULL,
       last_success_at_ms = excluded.last_success_at_ms,
       updated_at_ms = excluded.updated_at_ms`
  ).run(
    input.provider,
    input.credentialId,
    dateKey,
    successUnits,
    input.dailyLimit,
    input.nowMs,
    input.nowMs
  );
}

export function markTwitterProviderFailure(input: {
  provider: string;
  credentialId: string;
  nowMs: number;
  error: string;
  cooldownMs: number;
  dailyLimit: number;
}) {
  const db = getDb();
  const dateKey = getTwitterDateKey(input.nowMs);
  const cooldownUntilMs = input.nowMs + Math.max(0, input.cooldownMs);
  db.prepare(
    `INSERT INTO twitter_provider_budget (
       provider,
       credential_id,
       date_key,
       success_units_used,
       daily_limit,
       cooldown_until_ms,
       last_success_at_ms,
       last_failure_at_ms,
       last_error,
       updated_at_ms
     ) VALUES (?, ?, ?, 0, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT(provider, credential_id, date_key) DO UPDATE SET
       daily_limit = excluded.daily_limit,
       cooldown_until_ms = excluded.cooldown_until_ms,
       last_failure_at_ms = excluded.last_failure_at_ms,
       last_error = excluded.last_error,
       updated_at_ms = excluded.updated_at_ms`
  ).run(
    input.provider,
    input.credentialId,
    dateKey,
    input.dailyLimit,
    cooldownUntilMs,
    input.nowMs,
    input.error,
    input.nowMs
  );
}

export function clearTwitterProviderStateForTests() {
  const db = getDb();
  db.prepare('DELETE FROM twitter_identity_cache').run();
  db.prepare('DELETE FROM twitter_provider_budget').run();
}
