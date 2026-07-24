/**
 * Per-wallet GMGN activity timeline completeness (rolling ≥14d).
 * Separate from tracked_addresses.last_synced_at (OKX asset/sync path).
 */
import 'server-only';

import { getDb } from '@/lib/server/sqlite';
import { DEFAULT_TIMELINE_DAYS } from '@/lib/server/walletActivityBackfill';

export type WalletTimelineStateRow = {
  addressLower: string;
  lastBackfillAt: number | null;
  lastOkAt: number | null;
  windowStartMs: number | null;
  lastError: string | null;
  updatedAt: number;
};

function addressKey(address: string) {
  const a = (address || '').trim();
  if (!a) return '';
  return a.startsWith('0x') || a.startsWith('0X') ? a.toLowerCase() : a;
}

export function readWalletTimelineState(address: string): WalletTimelineStateRow | null {
  const key = addressKey(address);
  if (!key) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT address_lower, last_backfill_at, last_ok_at, window_start_ms, last_error, updated_at
       FROM wallet_timeline_state
       WHERE address_lower = ?`
    )
    .get(key) as
    | {
        address_lower: string;
        last_backfill_at: number | null;
        last_ok_at: number | null;
        window_start_ms: number | null;
        last_error: string | null;
        updated_at: number;
      }
    | undefined;
  if (!row) return null;
  return {
    addressLower: row.address_lower,
    lastBackfillAt: row.last_backfill_at,
    lastOkAt: row.last_ok_at,
    windowStartMs: row.window_start_ms,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

export function markWalletTimelineOk(input: {
  address: string;
  windowDays?: number;
  at?: number;
}) {
  const key = addressKey(input.address);
  if (!key) return;
  const at = input.at ?? Date.now();
  const days = input.windowDays ?? DEFAULT_TIMELINE_DAYS;
  const windowStartMs = at - days * 24 * 60 * 60 * 1000;
  const db = getDb();
  db.prepare(
    `INSERT INTO wallet_timeline_state (
       address_lower, last_backfill_at, last_ok_at, window_start_ms, last_error, updated_at
     ) VALUES (?, ?, ?, ?, NULL, ?)
     ON CONFLICT(address_lower) DO UPDATE SET
       last_backfill_at = excluded.last_backfill_at,
       last_ok_at = excluded.last_ok_at,
       window_start_ms = excluded.window_start_ms,
       last_error = NULL,
       updated_at = excluded.updated_at`
  ).run(key, at, at, windowStartMs, at);
}

export function markWalletTimelineFail(input: {
  address: string;
  error: string;
  at?: number;
}) {
  const key = addressKey(input.address);
  if (!key) return;
  const at = input.at ?? Date.now();
  const err = (input.error || 'unknown').slice(0, 500);
  const db = getDb();
  db.prepare(
    `INSERT INTO wallet_timeline_state (
       address_lower, last_backfill_at, last_ok_at, window_start_ms, last_error, updated_at
     ) VALUES (?, ?, NULL, NULL, ?, ?)
     ON CONFLICT(address_lower) DO UPDATE SET
       last_backfill_at = excluded.last_backfill_at,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`
  ).run(key, at, err, at);
}

export type MonitoredWalletForTimeline = {
  address: string;
  addressLower: string;
};

/** Distinct monitored wallets (prefer original casing from tracked_addresses.address). */
export function listMonitoredWalletsForTimeline(): MonitoredWalletForTimeline[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT address, address_lower
       FROM tracked_addresses
       WHERE COALESCE(monitoring_enabled, 1) = 1
         AND address_lower IS NOT NULL
         AND TRIM(address_lower) != ''
       ORDER BY address_lower ASC`
    )
    .all() as Array<{ address: string; address_lower: string }>;

  const byLower = new Map<string, MonitoredWalletForTimeline>();
  for (const row of rows) {
    const lower = addressKey(row.address_lower || row.address);
    if (!lower || byLower.has(lower)) continue;
    const display = (row.address || row.address_lower || '').trim() || lower;
    byLower.set(lower, { address: display, addressLower: lower });
  }
  return [...byLower.values()];
}

export function isWalletTimelineStale(input: {
  state: WalletTimelineStateRow | null;
  nowMs: number;
  windowDays: number;
  staleAfterMs: number;
}): boolean {
  const { state, nowMs, windowDays, staleAfterMs } = input;
  if (!state || state.lastOkAt == null) return true;
  if (nowMs - state.lastOkAt >= staleAfterMs) return true;
  const needStart = nowMs - windowDays * 24 * 60 * 60 * 1000;
  if (state.windowStartMs == null || state.windowStartMs > needStart) return true;
  return false;
}

/**
 * Monitored addresses whose 14d timeline coverage is missing or expired.
 * Skips addresses already pending in the backfill queue (caller may pass pending set).
 */
export function listStaleMonitoredWallets(input?: {
  nowMs?: number;
  windowDays?: number;
  staleAfterMs?: number;
  limit?: number;
  excludeAddressLowers?: Set<string>;
}): MonitoredWalletForTimeline[] {
  const nowMs = input?.nowMs ?? Date.now();
  const windowDays = input?.windowDays ?? DEFAULT_TIMELINE_DAYS;
  const staleAfterMs =
    input?.staleAfterMs ??
    (Number(process.env.PILI_WALLET_TIMELINE_STALE_MS) > 0
      ? Number(process.env.PILI_WALLET_TIMELINE_STALE_MS)
      : 6 * 60 * 60 * 1000);
  const limit = Math.max(1, input?.limit ?? 20);
  const exclude = input?.excludeAddressLowers ?? new Set<string>();

  const wallets = listMonitoredWalletsForTimeline();
  const db = getDb();
  const stateRows = db
    .prepare(
      `SELECT address_lower, last_backfill_at, last_ok_at, window_start_ms, last_error, updated_at
       FROM wallet_timeline_state`
    )
    .all() as Array<{
    address_lower: string;
    last_backfill_at: number | null;
    last_ok_at: number | null;
    window_start_ms: number | null;
    last_error: string | null;
    updated_at: number;
  }>;
  const stateByLower = new Map(
    stateRows.map((r) => [
      r.address_lower,
      {
        addressLower: r.address_lower,
        lastBackfillAt: r.last_backfill_at,
        lastOkAt: r.last_ok_at,
        windowStartMs: r.window_start_ms,
        lastError: r.last_error,
        updatedAt: r.updated_at,
      } satisfies WalletTimelineStateRow,
    ])
  );

  const stale: MonitoredWalletForTimeline[] = [];
  for (const w of wallets) {
    if (exclude.has(w.addressLower)) continue;
    const state = stateByLower.get(w.addressLower) ?? null;
    if (
      isWalletTimelineStale({
        state,
        nowMs,
        windowDays,
        staleAfterMs,
      })
    ) {
      stale.push(w);
      if (stale.length >= limit) break;
    }
  }
  return stale;
}
