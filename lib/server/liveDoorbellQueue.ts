/**
 * Cross-process live doorbell queue (SQLite).
 * Writers: telegram bridge (XXYY) / optional future sources.
 * Reader: live-monitor cycle in pili-web → GMGN scan → live-monitor feed.
 */
import 'server-only';

import { getDb } from '@/lib/server/sqlite';

const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_CLAIM_LIMIT = 40;

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
  address: string;
  userId: string;
  chains: string[];
  source: string;
  dueAtMs: number;
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

/** Trailing-debounce enqueue: same wallet coalesces; due_at slides to now+debounce. */
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
      due_at_ms = excluded.due_at_ms,
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

/** Claim due doorbells (delete + return). Safe across processes via SQLite tx. */
export function claimDueLiveDoorbells(params?: {
  nowMs?: number;
  limit?: number;
}): LiveDoorbellRow[] {
  const nowMs = params?.nowMs ?? Date.now();
  const limitRaw = params?.limit ?? DEFAULT_CLAIM_LIMIT;
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : DEFAULT_CLAIM_LIMIT;
  const db = getDb();

  const claim = db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT wallet_lower AS walletLower, address, user_id AS userId,
                chains_json AS chainsJson, source, due_at_ms AS dueAtMs
         FROM live_doorbell_queue
         WHERE due_at_ms <= ?
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

    const del = db.prepare(`DELETE FROM live_doorbell_queue WHERE wallet_lower = ?`);
    for (const row of rows) {
      del.run(row.walletLower);
    }

    return rows.map((row) => ({
      address: row.address,
      userId: row.userId,
      chains: parseChainsJson(row.chainsJson),
      source: row.source,
      dueAtMs: row.dueAtMs,
    }));
  });

  return claim();
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
