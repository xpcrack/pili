/**
 * Debounced in-memory queue for trade-triggered per-wallet holdings refresh.
 * Same wallet×chain coalesces into one OKX/GMGN pull after debounce.
 */
import 'server-only';

import { randomUUID } from 'node:crypto';

import {
  refreshWalletHoldings,
  type RefreshWalletHoldingsParams,
  type RefreshWalletHoldingsResult,
} from '@/lib/server/holdingsRefreshRuntime';
import { countPendingLiveDoorbells } from '@/lib/server/liveDoorbellQueue';
import {
  gmgnConfiguredAccountBucketKeys,
  gmgnCooldownRemainingMs,
  gmgnEgressCooldownRemainingMs,
} from '@/lib/server/gmgnRateLimit';
import { getDb, type DbHandle } from '@/lib/server/sqlite';

const DEFAULT_DEBOUNCE_MS = 10_000;
const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 1_000;
const MAX_TRANSIENT_RETRIES = 1;
const DEFAULT_MIN_REFRESH_AGE_MS = 120_000;

/**
 * Per-wallet×chain minimum re-sync interval. Trade-triggered refreshes are
 * hard-capped at once per this window so a high-frequency wallet cannot turn
 * its trade burst into an unbounded stream of OKX/GMGN balance pulls.
 * Override with HOLDINGS_MIN_REFRESH_AGE_MS (0 disables the cap).
 */
function getMinRefreshAgeMs() {
  const configured = Number.parseInt(process.env.HOLDINGS_MIN_REFRESH_AGE_MS || '', 10);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  return DEFAULT_MIN_REFRESH_AGE_MS;
}

const DEFAULT_QUIET_INTERVAL_MS = 4 * 60 * 60_000;
const DEFAULT_ROBINHOOD_QUIET_INTERVAL_MS = 12 * 60 * 60_000;
const DEFAULT_ACTIVE_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Quiet wallets (no on-chain activity within the active window) re-sync on
 * this slower cadence instead of HOLDINGS_REFRESH_INTERVAL_MS. Their balance
 * cannot have moved without a trade, so only price is stale — display re-pricing
 * covers that. Override with HOLDINGS_QUIET_INTERVAL_MS.
 */
function getQuietIntervalMs() {
  const configured = Number.parseInt(process.env.HOLDINGS_QUIET_INTERVAL_MS || '', 10);
  if (Number.isFinite(configured) && configured > 0) return Math.max(60_000, configured);
  return DEFAULT_QUIET_INTERVAL_MS;
}

/** A wallet with no on-chain trade within this window is treated as quiet. */
function getActiveWindowMs() {
  const configured = Number.parseInt(process.env.HOLDINGS_ACTIVE_WINDOW_MS || '', 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_ACTIVE_WINDOW_MS;
}

export type EnqueueHoldingsRefreshInput = {
  address: string;
  chain: string;
  userId: string;
};

type QueueJob = EnqueueHoldingsRefreshInput & {
  key: string;
  timer: ReturnType<typeof setTimeout> | null;
};

export type HoldingsRefreshQueueDeps = {
  refreshWallet?: (params: RefreshWalletHoldingsParams) => Promise<RefreshWalletHoldingsResult>;
  debounceMs?: number;
  retryDelayMs?: number;
  maxConcurrent?: number;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  log?: (message: string) => void;
};

function getDebounceMs(envDebounce?: number) {
  if (typeof envDebounce === 'number' && Number.isFinite(envDebounce) && envDebounce >= 0) {
    return envDebounce;
  }
  const configured = Number.parseInt(process.env.HOLDINGS_TRADE_REFRESH_DEBOUNCE_MS || '', 10);
  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }
  return DEFAULT_DEBOUNCE_MS;
}

function normalizeQueueChain(chain: string) {
  const normalized = chain.trim().toLowerCase();
  if (normalized === 'sol') return 'solana';
  if (normalized === 'eth') return 'ethereum';
  return normalized;
}

function jobKey(address: string, chain: string) {
  return `${normalizeQueueChain(chain)}:${address.trim().toLowerCase()}`;
}

function isRobinhoodChain(chain: string) {
  return chain.trim().toLowerCase() === 'robinhood';
}

function isTransientRefreshFailure(result: RefreshWalletHoldingsResult) {
  return (
    result.status === 'error' &&
    /OKX 网络错误|fetch failed|ECONNRESET|ETIMEDOUT|请求超时/i.test(result.lastError || '')
  );
}

export function createHoldingsRefreshQueue(deps: HoldingsRefreshQueueDeps = {}) {
  const pending = new Map<string, QueueJob>();
  const inFlight = new Set<string>();
  let active = 0;
  const waitQueue: string[] = [];

  const refreshWallet = deps.refreshWallet ?? refreshWalletHoldings;
  const debounceMs = getDebounceMs(deps.debounceMs);
  const retryDelayMs =
    typeof deps.retryDelayMs === 'number' && Number.isFinite(deps.retryDelayMs) && deps.retryDelayMs >= 0
      ? deps.retryDelayMs
      : DEFAULT_TRANSIENT_RETRY_DELAY_MS;
  const maxConcurrent = Math.max(1, deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const log =
    deps.log ??
    ((message: string) => {
      console.log(`[holdings-refresh-queue] ${message}`);
    });

  async function runJob(key: string) {
    const job = pending.get(key);
    if (!job) return;
    pending.delete(key);
    if (job.timer) {
      clearTimer(job.timer);
      job.timer = null;
    }
    if (inFlight.has(key)) {
      // Already running; re-enqueue so a trailing trade still refreshes after.
      enqueue(job);
      return;
    }

    if (isRobinhoodChain(job.chain) && countPendingLiveDoorbells() > 0) {
      // Robinhood holdings also use GMGN. Let live activity enrichment finish
      // first, but do not block OKX-backed EVM/Solana balance refreshes.
      enqueue(job);
      return;
    }

    inFlight.add(key);
    active += 1;
    try {
      let result: RefreshWalletHoldingsResult | null = null;
      for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt += 1) {
        result = await refreshWallet({
          address: job.address,
          chain: job.chain,
          userId: job.userId,
          fetchTokenLiquidity: false,
        });
        if (!isTransientRefreshFailure(result) || attempt === MAX_TRANSIENT_RETRIES) break;
        if (retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
      if (!result) {
        throw new Error('holdings refresh produced no result');
      }
      if (result.status === 'idle') {
        log(
          `ok ${key} rows=${result.holdingsRowCount} total=${result.totalAssetUsd ?? '-'}`
        );
      } else {
        log(`fail ${key} status=${result.status} err=${result.lastError ?? '-'}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`error ${key}: ${message}`);
    } finally {
      inFlight.delete(key);
      active -= 1;
      pump();
    }
  }

  function pump() {
    while (active < maxConcurrent && waitQueue.length > 0) {
      const key = waitQueue.shift();
      if (!key) break;
      if (pending.has(key)) {
        void runJob(key);
      }
    }
  }

  function scheduleRun(key: string) {
    if (!waitQueue.includes(key)) {
      waitQueue.push(key);
    }
    pump();
  }

  function enqueue(input: EnqueueHoldingsRefreshInput) {
    const address = (input.address || '').trim();
    const chain = (input.chain || '').trim();
    const userId = (input.userId || '').trim();
    if (!address || !chain || !userId) {
      return { enqueued: false, key: null as string | null };
    }

    const key = jobKey(address, chain);
    const existing = pending.get(key);
    if (existing?.timer) {
      clearTimer(existing.timer);
    }

    const job: QueueJob = {
      key,
      address,
      chain,
      userId,
      timer: null,
    };

    job.timer = setTimer(() => {
      job.timer = null;
      scheduleRun(key);
    }, debounceMs);

    pending.set(key, job);
    return { enqueued: true, key };
  }

  function pendingCount() {
    return pending.size;
  }

  function resetForTests() {
    for (const job of pending.values()) {
      if (job.timer) clearTimer(job.timer);
    }
    pending.clear();
    waitQueue.length = 0;
    inFlight.clear();
    active = 0;
  }

  return {
    enqueue,
    pendingCount,
    resetForTests,
    /** Exposed for tests / runtime wiring. */
    debounceMs,
  };
}

const PERSISTENT_QUEUE_POLL_MS = 1_000;
const PERSISTENT_QUEUE_LEASE_MS = 5 * 60_000;
const ROSTER_SEED_INTERVAL_MS = 5 * 60_000;
const EVENT_PRIORITY = 100;
const SCHEDULE_PRIORITY = 0;
let lastRosterSeedAtMs = 0;
const initializedQueueDbs = new WeakSet<object>();

type PersistentQueueRow = {
  wallet_chain: string;
  address: string;
  chain: string;
  user_id: string;
  attempts: number;
};

function ensurePersistentQueue(db: DbHandle) {
  if (initializedQueueDbs.has(db as object)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS holdings_refresh_jobs (
      wallet_chain TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      chain TEXT NOT NULL,
      user_id TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      due_at_ms INTEGER NOT NULL,
      lease_token TEXT,
      lease_until_ms INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      rerun_requested INTEGER NOT NULL DEFAULT 0,
      last_success_at_ms INTEGER,
      last_error TEXT,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_holdings_refresh_jobs_due
      ON holdings_refresh_jobs(priority DESC, due_at_ms ASC);
  `);
  try {
    db.exec(`ALTER TABLE holdings_refresh_jobs ADD COLUMN rerun_requested INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Existing/current schema already has it.
  }
  for (const [alias, canonical] of [['sol', 'solana'], ['eth', 'ethereum']] as const) {
    db.exec(`
      INSERT INTO holdings_refresh_jobs (
        wallet_chain, address, chain, user_id, priority, due_at_ms, lease_token,
        lease_until_ms, attempts, rerun_requested, last_success_at_ms, last_error, updated_at_ms
      )
      SELECT '${canonical}:' || substr(wallet_chain, instr(wallet_chain, ':') + 1),
             address, '${canonical}', user_id, priority, due_at_ms, NULL, NULL,
             attempts, rerun_requested, last_success_at_ms, last_error, updated_at_ms
      FROM holdings_refresh_jobs WHERE chain = '${alias}'
      ON CONFLICT(wallet_chain) DO UPDATE SET
        priority = MAX(holdings_refresh_jobs.priority, excluded.priority),
        due_at_ms = MIN(holdings_refresh_jobs.due_at_ms, excluded.due_at_ms),
        last_success_at_ms = MAX(holdings_refresh_jobs.last_success_at_ms, excluded.last_success_at_ms),
        updated_at_ms = MAX(holdings_refresh_jobs.updated_at_ms, excluded.updated_at_ms);
      DELETE FROM holdings_refresh_jobs WHERE chain = '${alias}';
    `);
  }
  initializedQueueDbs.add(db as object);
}

function upsertPersistentJob(
  db: DbHandle,
  input: EnqueueHoldingsRefreshInput,
  priority: number,
  dueAtMs: number,
  nowMs: number
) {
  const address = input.address.trim();
  const chain = normalizeQueueChain(input.chain);
  const userId = input.userId.trim();
  if (!address || !chain || !userId) return { enqueued: false, key: null as string | null };
  const key = jobKey(address, chain);
  ensurePersistentQueue(db);
  db.prepare(
    `INSERT INTO holdings_refresh_jobs (
       wallet_chain, address, chain, user_id, priority, due_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(wallet_chain) DO UPDATE SET
       address = excluded.address,
       user_id = excluded.user_id,
       priority = MAX(holdings_refresh_jobs.priority, excluded.priority),
       due_at_ms = CASE
         WHEN MAX(holdings_refresh_jobs.priority, excluded.priority) > 0
           THEN MIN(holdings_refresh_jobs.due_at_ms, excluded.due_at_ms)
         ELSE excluded.due_at_ms
       END,
       rerun_requested = CASE
         WHEN excluded.priority > 0 AND holdings_refresh_jobs.lease_until_ms > excluded.updated_at_ms
         THEN 1 ELSE holdings_refresh_jobs.rerun_requested END,
       updated_at_ms = excluded.updated_at_ms`
  ).run(key, address, chain, userId, priority, dueAtMs, nowMs);
  return { enqueued: true, key };
}

/** Durable event enqueue: survives worker restarts and coalesces wallet×chain. */
export function enqueueHoldingsRefresh(input: EnqueueHoldingsRefreshInput) {
  const nowMs = Date.now();
  return upsertPersistentJob(getDb(), input, EVENT_PRIORITY, nowMs + getDebounceMs(), nowMs);
}

function seedPersistentQueue(db: DbHandle, nowMs: number) {
  ensurePersistentQueue(db);
  if (lastRosterSeedAtMs > 0 && lastRosterSeedAtMs <= nowMs && nowMs - lastRosterSeedAtMs < ROSTER_SEED_INTERVAL_MS) {
    return 0;
  }
  lastRosterSeedAtMs = nowMs;
  const intervalMs = Number.parseInt(process.env.HOLDINGS_REFRESH_INTERVAL_MS || '', 10);
  const refreshIntervalMs = Number.isFinite(intervalMs) && intervalMs > 0
    ? Math.max(60_000, intervalMs)
    : 30 * 60_000;
  const rows = db.prepare(
    `SELECT ta.address, ta.address_lower, ta.chain, ta.user_id,
            MAX(CASE WHEN ws.status = 'success' THEN ws.refreshed_at END) AS last_success_at,
            NULL AS last_trade_at
     FROM tracked_addresses ta
     LEFT JOIN current_holdings_wallet_status ws
       ON ws.tracked_address_lower = ta.address_lower AND ws.chain = ta.chain
     WHERE COALESCE(ta.monitoring_enabled, 1) = 1
       AND ta.chain IN ('solana', 'ethereum', 'bsc', 'base')
     GROUP BY ta.address_lower, ta.chain
     UNION ALL
     SELECT ta.address, ta.address_lower, 'robinhood' AS chain, ta.user_id,
            MAX(CASE WHEN ws.status = 'success' THEN ws.refreshed_at END) AS last_success_at,
            MAX(e.event_time_ms) AS last_trade_at
     FROM tracked_addresses ta
     JOIN telegram_monitor_events e
       ON e.tracked_wallet_address_lower = ta.address_lower AND e.chain = 'robinhood'
     LEFT JOIN current_holdings_wallet_status ws
       ON ws.tracked_address_lower = ta.address_lower AND ws.chain = 'robinhood'
     WHERE COALESCE(ta.monitoring_enabled, 1) = 1
       AND ta.chain IN ('ethereum', 'bsc', 'base')
     GROUP BY ta.address_lower`
  ).all() as Array<{
    address: string;
    address_lower: string;
    chain: string;
    user_id: string;
    last_success_at: number | null;
    last_trade_at: number | null;
  }>;

  // Native chains read the last on-chain trade from the canonical events table
  // (indexed lookup); robinhood carries MAX(event_time_ms) from the feed above.
  const latestTradeStmt = db.prepare(
    `SELECT MAX(timestamp) AS latest_ts
     FROM events
     WHERE source = 'blockchain'
       AND chain = ?
       AND TRIM(COALESCE(address, '')) <> ''
       AND LOWER(address) = ?`
  );

  const quietIntervalMs = getQuietIntervalMs();
  const activeWindowMs = getActiveWindowMs();

  for (const row of rows) {
    const isRobinhood = row.chain === 'robinhood';
    const lastTradeAt = isRobinhood
      ? row.last_trade_at
      : (latestTradeStmt.get(row.chain, row.address_lower) as { latest_ts: number | null } | undefined)?.latest_ts ?? null;
    const active = lastTradeAt != null && lastTradeAt >= nowMs - activeWindowMs;
    const intervalMs = isRobinhood
      ? (active ? refreshIntervalMs : DEFAULT_ROBINHOOD_QUIET_INTERVAL_MS)
      : (active ? refreshIntervalMs : quietIntervalMs);
    // Preserve real age in due_at so an old wallet cannot remain at a fixed
    // roster position behind newer wallets every cycle.
    const dueAtMs = row.last_success_at == null
      ? 0
      : Number(row.last_success_at) + intervalMs;
    upsertPersistentJob(db, {
      address: row.address,
      chain: row.chain,
      userId: row.user_id,
    }, SCHEDULE_PRIORITY, dueAtMs, nowMs);
  }
  return rows.length;
}

type HoldingsRefreshProvider = 'native' | 'gmgn';

function claimPersistentJob(
  db: DbHandle,
  nowMs: number,
  provider?: HoldingsRefreshProvider
): (PersistentQueueRow & { leaseToken: string }) | null {
  ensurePersistentQueue(db);
  const leaseToken = randomUUID();
  const minAgeMs = getMinRefreshAgeMs();
  const providerClause = provider === 'gmgn'
    ? `AND chain = 'robinhood'`
    : provider === 'native'
      ? `AND chain <> 'robinhood'`
      : '';
  const claim = db.transaction(() => {
    const row = db.prepare(
      `SELECT wallet_chain, address, chain, user_id, attempts
       FROM holdings_refresh_jobs
       WHERE due_at_ms <= ?
         AND (lease_until_ms IS NULL OR lease_until_ms <= ?)
         AND (last_success_at_ms IS NULL OR last_success_at_ms + ? <= ?)
         ${providerClause}
       ORDER BY priority DESC, COALESCE(last_success_at_ms, 0) ASC, due_at_ms ASC
       LIMIT 1`
    ).get(nowMs, nowMs, minAgeMs, nowMs) as PersistentQueueRow | undefined;
    if (!row) return null;
    const result = db.prepare(
      `UPDATE holdings_refresh_jobs
       SET lease_token = ?, lease_until_ms = ?, updated_at_ms = ?
       WHERE wallet_chain = ? AND (lease_until_ms IS NULL OR lease_until_ms <= ?)`
    ).run(leaseToken, nowMs + PERSISTENT_QUEUE_LEASE_MS, nowMs, row.wallet_chain, nowMs);
    return result.changes === 1 ? { ...row, leaseToken } : null;
  });
  return claim();
}

function gmgnQueueCooldownRemainingMs(nowMs: number) {
  return Math.max(
    gmgnCooldownRemainingMs(nowMs),
    ...gmgnConfiguredAccountBucketKeys().map((scope) =>
      gmgnEgressCooldownRemainingMs(scope, nowMs)
    )
  );
}

function queueStats(db: DbHandle, nowMs: number) {
  ensurePersistentQueue(db);
  return db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN due_at_ms <= ? THEN 1 ELSE 0 END) AS due,
            MIN(CASE WHEN due_at_ms <= ? THEN due_at_ms END) AS oldest_due_at
     FROM holdings_refresh_jobs`
  ).get(nowMs, nowMs) as { total: number; due: number | null; oldest_due_at: number | null };
}

/** One durable queue cycle. Periodic roster scans only seed jobs; they never block on a full sweep. */
export async function runHoldingsRefreshQueueCycle(options: {
  db?: DbHandle;
  now?: () => number;
  provider?: HoldingsRefreshProvider;
  refreshWallet?: (params: RefreshWalletHoldingsParams) => Promise<RefreshWalletHoldingsResult>;
  cooldownRemainingMs?: (nowMs: number) => number;
  pendingLiveDoorbells?: () => number;
} = {}) {
  const db = options.db ?? getDb();
  const now = options.now ?? Date.now;
  const nowMs = now();
  const seeded = seedPersistentQueue(db, nowMs);
  let job: (PersistentQueueRow & { leaseToken: string }) | null;
  try {
    job = claimPersistentJob(db, nowMs, options.provider);
  } catch (error) {
    if (/database is locked|SQLITE_BUSY/i.test(error instanceof Error ? error.message : String(error))) {
      return {
        sleepMs: PERSISTENT_QUEUE_POLL_MS,
        status: 'idle' as const,
        summary: { seeded, processed: 0, queueTotal: 0, queueDue: 0 },
        lastError: 'sqlite busy while claiming holdings refresh job',
      };
    }
    throw error;
  }
  if (!job) {
    const stats = queueStats(db, nowMs);
    return {
      sleepMs: PERSISTENT_QUEUE_POLL_MS,
      status: 'idle' as const,
      summary: { seeded, processed: 0, queueTotal: stats.total, queueDue: stats.due ?? 0 },
      lastError: null,
    };
  }

  if (isRobinhoodChain(job.chain)) {
    const cooldownMs = (options.cooldownRemainingMs ?? gmgnQueueCooldownRemainingMs)(nowMs);
    const pendingDoorbells = (options.pendingLiveDoorbells ?? countPendingLiveDoorbells)();
    if (cooldownMs > 0 || pendingDoorbells > 0) {
      const retryAt = nowMs + Math.max(PERSISTENT_QUEUE_POLL_MS, cooldownMs || 30_000);
      db.prepare(
        `UPDATE holdings_refresh_jobs
         SET due_at_ms = ?, lease_token = NULL, lease_until_ms = NULL, updated_at_ms = ?
         WHERE wallet_chain = ? AND lease_token = ?`
      ).run(retryAt, nowMs, job.wallet_chain, job.leaseToken);
      const stats = queueStats(db, nowMs);
      return {
        sleepMs: PERSISTENT_QUEUE_POLL_MS,
        status: 'idle' as const,
        summary: {
          seeded,
          processed: 0,
          deferredWalletChain: job.wallet_chain,
          queueTotal: stats.total,
          queueDue: stats.due ?? 0,
        },
        lastError: cooldownMs > 0 ? `GMGN cooldown ${cooldownMs}ms` : 'live doorbells pending',
      };
    }
  }

  const refreshWallet = options.refreshWallet ?? refreshWalletHoldings;
  let result: RefreshWalletHoldingsResult;
  try {
    result = await refreshWallet({
      address: job.address,
      chain: job.chain,
      userId: job.user_id,
      db,
      fetchTokenLiquidity: false,
    });
  } catch (error) {
    result = {
      status: 'error',
      chain: null,
      holdingsRowCount: 0,
      filteredOutHoldingCount: 0,
      totalAssetUsd: null,
      lastError: error instanceof Error ? error.message : String(error),
    };
  }

  const finishedAt = now();
  if (result.status === 'idle') {
    const intervalMs = Math.max(60_000, Number.parseInt(process.env.HOLDINGS_REFRESH_INTERVAL_MS || '', 10) || 30 * 60_000);
    db.prepare(
      `UPDATE holdings_refresh_jobs
       SET priority = CASE WHEN rerun_requested = 1 THEN priority ELSE 0 END,
           due_at_ms = CASE WHEN rerun_requested = 1 THEN due_at_ms ELSE ? END,
           lease_token = NULL, lease_until_ms = NULL, attempts = 0,
           rerun_requested = 0, last_success_at_ms = ?, last_error = NULL, updated_at_ms = ?
       WHERE wallet_chain = ? AND lease_token = ?`
    ).run(finishedAt + intervalMs, finishedAt, finishedAt, job.wallet_chain, job.leaseToken);
  } else {
    const attempts = job.attempts + 1;
    const retryMs = Math.min(30 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 5));
    db.prepare(
      `UPDATE holdings_refresh_jobs
       SET due_at_ms = CASE WHEN rerun_requested = 1 THEN MIN(due_at_ms, ?) ELSE ? END,
           lease_token = NULL, lease_until_ms = NULL, attempts = ?, rerun_requested = 0,
           last_error = ?, updated_at_ms = ?
       WHERE wallet_chain = ? AND lease_token = ?`
    ).run(
      finishedAt + retryMs,
      finishedAt + retryMs,
      attempts,
      result.lastError,
      finishedAt,
      job.wallet_chain,
      job.leaseToken
    );
  }
  const stats = queueStats(db, finishedAt);
  return {
    sleepMs: PERSISTENT_QUEUE_POLL_MS,
    status: result.status,
    summary: {
      seeded,
      processed: 1,
      walletChain: job.wallet_chain,
      holdingsRowCount: result.holdingsRowCount,
      queueTotal: stats.total,
      queueDue: stats.due ?? 0,
      oldestDueAt: stats.oldest_due_at,
    },
    lastError: result.lastError,
  };
}

/** Independent consumers keep GMGN latency/cooldown from occupying the native balance loop. */
export function runNativeHoldingsRefreshQueueCycle() {
  return runHoldingsRefreshQueueCycle({ provider: 'native' });
}

export function runGmgnHoldingsRefreshQueueCycle() {
  if (process.env.PILI_GMGN_RECOVERY_PAUSED === '1') {
    return Promise.resolve({
      sleepMs: 30_000,
      status: 'idle' as const,
      summary: { seeded: 0, processed: 0, queueTotal: 0, queueDue: 0 },
      lastError: 'paused for self-holdings recovery',
    });
  }
  return runHoldingsRefreshQueueCycle({ provider: 'gmgn' });
}

/** Compatibility export; production enqueue is durable rather than process-local. */
export const holdingsRefreshQueue = {
  enqueue: enqueueHoldingsRefresh,
  pendingCount: () => queueStats(getDb(), Date.now()).due ?? 0,
};
