import 'server-only';

import { getDb } from '@/lib/server/sqlite';

const INGEST_ALERT_STATE_KEY = 'ingest_alert_rate_limit_v1';

interface IngestAlertRateState {
  [rateKey: string]: number;
}

function parseJSON<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function readState() {
  const db = getDb();
  const row = db
    .prepare('SELECT value_json FROM app_state WHERE key = ? LIMIT 1')
    .get(INGEST_ALERT_STATE_KEY) as { value_json: string } | undefined;

  if (!row?.value_json) {
    return {} as IngestAlertRateState;
  }

  const parsed = parseJSON<Record<string, unknown>>(row.value_json, {});
  const normalized: IngestAlertRateState = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      normalized[key] = Math.floor(value);
    }
  }
  return normalized;
}

function writeState(state: IngestAlertRateState, nowMs: number) {
  const db = getDb();
  db.prepare(
    `INSERT INTO app_state (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(INGEST_ALERT_STATE_KEY, JSON.stringify(state), nowMs);
}

export function consumeIngestAlertQuota(rateKey: string, windowMs: number) {
  const key = rateKey.trim();
  if (!key) {
    return true;
  }

  const safeWindowMs = Math.max(1_000, Math.floor(windowMs));
  const nowMs = Date.now();
  const state = readState();

  const nextState: IngestAlertRateState = {};
  const cutoff = nowMs - safeWindowMs;
  for (const [entryKey, ts] of Object.entries(state)) {
    if (ts >= cutoff) {
      nextState[entryKey] = ts;
    }
  }

  const lastAt = nextState[key] || 0;
  if (lastAt >= cutoff) {
    if (Object.keys(nextState).length !== Object.keys(state).length) {
      writeState(nextState, nowMs);
    }
    return false;
  }

  nextState[key] = nowMs;
  writeState(nextState, nowMs);
  return true;
}
