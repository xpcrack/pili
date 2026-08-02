/**
 * Cross-process live doorbell queue (SQLite).
 * Writers: telegram bridge (XXYY) / optional future sources.
 * Reader: live-monitor cycle in pili-background-worker → GMGN scan → live-monitor feed.
 *
 * Confirmed-consume semantics: claim stamps a lease (does NOT delete); the cycle
 * must ack (success → delete) or nack (failure → clear lease + reschedule) after
 * scanning. This prevents "consume-then-fail" losing doorbell signals for good
 * (e.g. during a GMGN ban window). Stale leases from a crashed cycle are
 * reclaimed automatically at the start of the next claim.
 */
import 'server-only';

import { randomUUID } from 'node:crypto';

import { getDb } from '@/lib/server/sqlite';

const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_CLAIM_LIMIT = 40;

/** How long a claim holds a row before a crashed/slow cycle's lease is reclaimable. */
const DEFAULT_LEASE_MS = 90_000;

export type EnqueueLiveDoorbellInput = {
  address: string;
  userId: string;
  /** Preferred chain(s) to scan first; empty → infer all for address. */
  chain?: string | null;
  source?: string;
  debounceMs?: number;
  nowMs?: number;
};

export type LiveDoorbellRow = {
  walletLower: string;
  address: string;
  userId: string;
  chains: string[];
  source: string;
  dueAtMs: number;
  /** Lease token returned by claim; required by ack/nack as a guard. */
  leaseToken: string;
};

export type DoorbellClaim = {
  walletLower: string;
  leaseToken: string;
};

function normalizeWallet(address: string) {
  return address.trim().toLowerCase();
}

function parseChainsJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function mergeChains(existing: string[], extra: string | null | undefined): string[] {
  const set = new Set(existing);
  const c = (extra || '').trim().toLowerCase();
  if (c) set.add(c);
  return [...set];
}

function readDebounceMs(override?: number) {
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) {
    return override;
  }
  const configured = Number.parseInt(process.env.PILI_LIVE_DOORBELL_DEBOUNCE_MS || '', 10);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  return DEFAULT_DEBOUNCE_MS;
}

/** Trailing-debounce enqueue: same wallet coalesces; due_at slides to now+debounce.
 *  A row currently under a claim (being scanned) keeps its existing due_at_ms so a
 *  fresh ring can't cut in front of an in-flight scan or erase a nack's retry time. */
export function enqueueLiveDoorbell(input: EnqueueLiveDoorbellInput): {
  enqueued: boolean;
  walletLower: string | null;
} {
  const address = (input.address || '').trim();
  const userId = (input.userId || '').trim();
  if (!address || !userId) {
    return { enqueued: false, walletLower: null };
  }

  const walletLower = normalizeWallet(address);
  const nowMs = input.nowMs ?? Date.now();
  const debounceMs = readDebounceMs(input.debounceMs);
  const dueAtMs = nowMs + debounceMs;
  const source = (input.source || 'xxyy').trim() || 'xxyy';
  const db = getDb();

  const existing = db
    .prepare(
      `SELECT chains_json AS chainsJson FROM live_doorbell_queue WHERE wallet_lower = ?`
    )
    .get(walletLower) as { chainsJson?: string } | undefined;

  const chains = mergeChains(parseChainsJson(existing?.chainsJson), input.chain);
  const chainsJson = JSON.stringify(chains);

  db.prepare(
    `INSERT INTO live_doorbell_queue (
      wallet_lower, address, user_id, chains_json, source, due_at_ms, updated_at_ms, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(wallet_lower) DO UPDATE SET
      address = excluded.address,
      user_id = excluded.user_id,
      chains_json = excluded.chains_json,
      source = excluded.source,
      due_at_ms = CASE WHEN live_doorbell_queue.lease_expires_at_ms IS NULL
                    THEN excluded.due_at_ms ELSE live_doorbell_queue.due_at_ms END,
      updated_at_ms = excluded.updated_at_ms`
  ).run(
    walletLower,
    address,
    userId,
    chainsJson,
    source,
    dueAtMs,
    nowMs,
    nowMs
  );

  return { enqueued: true, walletLower };
}

/** Reclaim rows whose claimant (a crashed/slow cycle) has let its lease lapse.
 *  Clears the lease and reschedules due_at_ms to now so the next claim can pick
 *  the wallet up again. Returns the number of rows reclaimed. */
export function reclaimStaleLiveDoorbells(nowMs?: number): number {
  const t = nowMs ?? Date.now();
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE live_doorbell_queue
       SET claim_lease_token = NULL,
           claimed_at_ms = NULL,
           lease_expires_at_ms = NULL,
           due_at_ms = ?,
           updated_at_ms = ?
       WHERE lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms < ?`
    )
    .run(t, t, t);
  return Number(result.changes || 0);
}

/** Claim due doorbells: stamps a lease (does NOT delete). Caller must ack (success)
 *  or nack (failure) using the returned leaseToken. Stale leases are reclaimed first. */
export function claimDueLiveDoorbells(params?: {
  nowMs?: number;
  limit?: number;
  leaseMs?: number;
}): LiveDoorbellRow[] {
  const nowMs = params?.nowMs ?? Date.now();
  const limitRaw = params?.limit ?? DEFAULT_CLAIM_LIMIT;
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : DEFAULT_CLAIM_LIMIT;
  const leaseMsRaw = params?.leaseMs ?? Number(process.env.PILI_LIVE_DOORBELL_LEASE_MS || DEFAULT_LEASE_MS);
  const leaseMs = Number.isFinite(leaseMsRaw) && leaseMsRaw > 0 ? leaseMsRaw : DEFAULT_LEASE_MS;
  const leaseExpiresAtMs = nowMs + leaseMs;
  const db = getDb();

  const claim = db.transaction(() => {
    // Self-heal: drop leases from any previous cycle that died mid-scan.
    reclaimStaleLiveDoorbells(nowMs);

    const rows = db
      .prepare(
        `SELECT wallet_lower AS walletLower, address, user_id AS userId,
                chains_json AS chainsJson, source, due_at_ms AS dueAtMs
         FROM live_doorbell_queue
         WHERE due_at_ms <= ? AND lease_expires_at_ms IS NULL
         ORDER BY due_at_ms ASC
         LIMIT ?`
      )
      .all(nowMs, limit) as Array<{
      walletLower: string;
      address: string;
      userId: string;
      chainsJson: string;
      source: string;
      dueAtMs: number;
    }>;

    if (rows.length === 0) return [] as LiveDoorbellRow[];

    const stamp = db.prepare(
      `UPDATE live_doorbell_queue
       SET claim_lease_token = ?,
           claimed_at_ms = ?,
           lease_expires_at_ms = ?
       WHERE wallet_lower = ? AND lease_expires_at_ms IS NULL`
    );
    const claimed: LiveDoorbellRow[] = [];
    for (const row of rows) {
      const leaseToken = randomUUID();
      const res = stamp.run(leaseToken, nowMs, leaseExpiresAtMs, row.walletLower);
      // Lost a race (another process claimed it between SELECT and UPDATE): skip.
      if (Number(res.changes) !== 1) continue;
      claimed.push({
        walletLower: row.walletLower,
        address: row.address,
        userId: row.userId,
        chains: parseChainsJson(row.chainsJson),
        source: row.source,
        dueAtMs: row.dueAtMs,
        leaseToken,
      });
    }

    return claimed;
  });

  return claim();
}

/** Ack (success): delete claimed rows. Token guards against deleting a row that was
 *  reclaimed and re-claimed by another cycle after this one's lease lapsed. */
export function ackLiveDoorbells(claims: DoorbellClaim[]): number {
  if (claims.length === 0) return 0;
  const db = getDb();
  const del = db.prepare(
    `DELETE FROM live_doorbell_queue WHERE wallet_lower = ? AND claim_lease_token = ?`
  );
  let removed = 0;
  for (const claim of claims) {
    removed += Number(del.run(claim.walletLower, claim.leaseToken).changes || 0);
  }
  return removed;
}

/** Nack (scan failure): clear lease + reschedule due_at_ms = now + retryAfterMs.
 *  Token guard makes a stale/re-claimed row's late nack a no-op. */
export function nackLiveDoorbells(
  claims: DoorbellClaim[],
  opts: { retryAfterMs: number; nowMs?: number }
): number {
  if (claims.length === 0) return 0;
  const nowMs = opts.nowMs ?? Date.now();
  const retryAfterMs = Number.isFinite(opts.retryAfterMs) && opts.retryAfterMs > 0 ? opts.retryAfterMs : 0;
  const db = getDb();
  const upd = db.prepare(
    `UPDATE live_doorbell_queue
     SET claim_lease_token = NULL,
         claimed_at_ms = NULL,
         lease_expires_at_ms = NULL,
         due_at_ms = ?,
         updated_at_ms = ?
     WHERE wallet_lower = ? AND claim_lease_token = ?`
  );
  let updated = 0;
  for (const claim of claims) {
    updated += Number(upd.run(nowMs + retryAfterMs, nowMs, claim.walletLower, claim.leaseToken).changes || 0);
  }
  return updated;
}

export function countPendingLiveDoorbells(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(1) AS n FROM live_doorbell_queue`)
    .get() as { n?: number } | undefined;
  return Number(row?.n || 0);
}

/** Test helper. */
export function resetLiveDoorbellQueueForTests() {
  getDb().prepare(`DELETE FROM live_doorbell_queue`).run();
}
