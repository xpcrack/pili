import 'server-only';

import { getDb, type DbHandle } from '@/lib/server/sqlite';

const HOLDER_SNAPSHOT_TRADE_CURSOR_KEY = 'holder_snapshot_trade_cursor_v1';
const HOLDER_SNAPSHOT_PERIODIC_CURSOR_KEY = 'holder_snapshot_periodic_cursor_v1';

export type HolderSnapshotTriggerType = 'trade' | 'periodic' | 'manual';
export type HolderSnapshotTriggerSource = 'telegram_monitor_tx_states' | 'current_holdings' | 'manual';
export type HolderSnapshotRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped';

interface HolderSnapshotRunRow {
  id: number;
  chain: string;
  token_address: string;
  token_address_lower: string;
  token_symbol: string | null;
  tracked_wallet_address: string;
  tracked_wallet_address_lower: string;
  user_id: string | null;
  trigger_type: string;
  trigger_source: string;
  trade_action: string | null;
  tx_hash: string | null;
  tx_hash_lower: string | null;
  trade_time_ms: number | null;
  holdings_refreshed_at: number | null;
  period_bucket_start_ms: number | null;
  dedupe_key: string;
  status: string;
  attempt_count: number;
  holder_count: number | null;
  error: string | null;
  meta_json: string;
  requested_at: number;
  started_at: number | null;
  completed_at: number | null;
  updated_at: number;
}

interface HolderSnapshotHolderRow {
  id: number;
  snapshot_run_id: number;
  holder_rank: number;
  address: string;
  account_address: string | null;
  addr_type: number | null;
  exchange: string | null;
  wallet_tag_v2: string | null;
  name: string | null;
  twitter_username: string | null;
  balance: number | null;
  amount_percentage: number | null;
  usd_value: number | null;
  cost: number | null;
  profit: number | null;
  avg_cost: number | null;
  realized_profit: number | null;
  unrealized_profit: number | null;
  buy_tx_count_cur: number | null;
  sell_tx_count_cur: number | null;
  is_new: number;
  is_suspicious: number;
  raw_json: string;
  created_at: number;
}

interface TradeTriggerRow {
  id: number;
  user_id: string;
  chain: string;
  tracked_wallet_address: string;
  tracked_wallet_address_lower: string;
  tx_hash: string;
  tx_hash_lower: string;
  token_address: string;
  token_address_lower: string;
  token_symbol: string | null;
  provisional_action: 'buy' | 'sell';
  event_time_ms: number | null;
}

interface PeriodicHoldingRow {
  tracked_address: string;
  tracked_address_lower: string;
  user_id: string | null;
  chain: string;
  token_address: string;
  token_address_lower: string;
  symbol: string | null;
  refreshed_at: number;
}

export interface HolderSnapshotRun {
  id: number;
  chain: string;
  tokenAddress: string;
  tokenAddressLower: string;
  tokenSymbol: string | null;
  trackedWalletAddress: string;
  trackedWalletAddressLower: string;
  userId: string | null;
  triggerType: HolderSnapshotTriggerType;
  triggerSource: HolderSnapshotTriggerSource;
  tradeAction: 'buy' | 'sell' | null;
  txHash: string | null;
  txHashLower: string | null;
  tradeTimeMs: number | null;
  holdingsRefreshedAt: number | null;
  periodBucketStartMs: number | null;
  dedupeKey: string;
  status: HolderSnapshotRunStatus;
  attemptCount: number;
  holderCount: number | null;
  error: string | null;
  meta: Record<string, unknown>;
  requestedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

export interface HolderSnapshotHolder {
  id: number;
  snapshotRunId: number;
  holderRank: number;
  address: string;
  accountAddress: string | null;
  addrType: number | null;
  exchange: string | null;
  walletTagV2: string | null;
  name: string | null;
  twitterUsername: string | null;
  balance: number | null;
  amountPercentage: number | null;
  usdValue: number | null;
  cost: number | null;
  profit: number | null;
  avgCost: number | null;
  realizedProfit: number | null;
  unrealizedProfit: number | null;
  buyTxCountCur: number | null;
  sellTxCountCur: number | null;
  isNew: boolean;
  isSuspicious: boolean;
  raw: Record<string, unknown>;
  createdAt: number;
}

export interface HolderSnapshotCollectedHolder {
  holderRank?: number | null;
  address: string;
  accountAddress?: string | null;
  addrType?: number | null;
  exchange?: string | null;
  walletTagV2?: string | null;
  name?: string | null;
  twitterUsername?: string | null;
  balance?: number | null;
  amountPercentage?: number | null;
  usdValue?: number | null;
  cost?: number | null;
  profit?: number | null;
  avgCost?: number | null;
  realizedProfit?: number | null;
  unrealizedProfit?: number | null;
  buyTxCountCur?: number | null;
  sellTxCountCur?: number | null;
  isNew?: boolean;
  isSuspicious?: boolean;
  raw: Record<string, unknown>;
}

export interface QueueTradeTriggeredHolderSnapshotsResult {
  scannedCount: number;
  queuedCount: number;
  lastSeenId: number | null;
}

export interface QueuePeriodicHolderSnapshotsResult {
  queuedCount: number;
  bucketStartMs: number;
  tokenCount: number;
}

function getDbOrDefault(db?: DbHandle) {
  return db ?? getDb();
}

function normalizeLower(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

function normalizeChain(value: string | null | undefined) {
  return normalizeLower(value);
}

function normalizeTokenAddress(value: string | null | undefined, chain: string) {
  const trimmed = (value || '').trim();
  if (!trimmed) {
    return '';
  }
  return normalizeChain(chain) === 'solana' ? trimmed : trimmed.toLowerCase();
}

function parseJsonObject(value: string | null | undefined) {
  if (!value) {
    return {} as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {} as Record<string, unknown>;
  }
}

function readAppStateJson<T>(db: DbHandle, key: string, fallback: T): T {
  const row = db.prepare('SELECT value_json FROM app_state WHERE key = ? LIMIT 1').get(key) as
    | { value_json: string }
    | undefined;
  if (!row) {
    return fallback;
  }
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}

function writeAppStateJson(db: DbHandle, key: string, value: unknown, updatedAt: number) {
  db.prepare(
    `INSERT INTO app_state (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), updatedAt);
}

function truncateError(error: string) {
  return error.trim().slice(0, 2000);
}

function mapRunRow(row: HolderSnapshotRunRow | undefined | null): HolderSnapshotRun | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    chain: row.chain,
    tokenAddress: row.token_address,
    tokenAddressLower: row.token_address_lower,
    tokenSymbol: row.token_symbol,
    trackedWalletAddress: row.tracked_wallet_address,
    trackedWalletAddressLower: row.tracked_wallet_address_lower,
    userId: row.user_id,
    triggerType:
      row.trigger_type === 'trade' || row.trigger_type === 'periodic' || row.trigger_type === 'manual'
        ? row.trigger_type
        : 'manual',
    triggerSource:
      row.trigger_source === 'telegram_monitor_tx_states' ||
      row.trigger_source === 'current_holdings' ||
      row.trigger_source === 'manual'
        ? row.trigger_source
        : 'manual',
    tradeAction: row.trade_action === 'buy' || row.trade_action === 'sell' ? row.trade_action : null,
    txHash: row.tx_hash,
    txHashLower: row.tx_hash_lower,
    tradeTimeMs: row.trade_time_ms,
    holdingsRefreshedAt: row.holdings_refreshed_at,
    periodBucketStartMs: row.period_bucket_start_ms,
    dedupeKey: row.dedupe_key,
    status:
      row.status === 'queued' ||
      row.status === 'running' ||
      row.status === 'completed' ||
      row.status === 'failed' ||
      row.status === 'skipped'
        ? row.status
        : 'failed',
    attemptCount: row.attempt_count,
    holderCount: row.holder_count,
    error: row.error,
    meta: parseJsonObject(row.meta_json),
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function mapHolderRow(row: HolderSnapshotHolderRow): HolderSnapshotHolder {
  return {
    id: row.id,
    snapshotRunId: row.snapshot_run_id,
    holderRank: row.holder_rank,
    address: row.address,
    accountAddress: row.account_address,
    addrType: row.addr_type,
    exchange: row.exchange,
    walletTagV2: row.wallet_tag_v2,
    name: row.name,
    twitterUsername: row.twitter_username,
    balance: row.balance,
    amountPercentage: row.amount_percentage,
    usdValue: row.usd_value,
    cost: row.cost,
    profit: row.profit,
    avgCost: row.avg_cost,
    realizedProfit: row.realized_profit,
    unrealizedProfit: row.unrealized_profit,
    buyTxCountCur: row.buy_tx_count_cur,
    sellTxCountCur: row.sell_tx_count_cur,
    isNew: row.is_new === 1,
    isSuspicious: row.is_suspicious === 1,
    raw: parseJsonObject(row.raw_json),
    createdAt: row.created_at,
  };
}

function buildTradeDedupeKey(params: {
  chain: string;
  trackedWalletAddressLower: string;
  txHashLower: string;
  tokenAddressLower: string;
}) {
  return `trade|${normalizeChain(params.chain)}|${params.trackedWalletAddressLower}|${params.txHashLower}|${params.tokenAddressLower}`;
}

function buildPeriodicDedupeKey(params: {
  chain: string;
  trackedWalletAddressLower: string;
  tokenAddressLower: string;
  bucketStartMs: number;
}) {
  return `periodic|${normalizeChain(params.chain)}|${params.trackedWalletAddressLower}|${params.tokenAddressLower}|${params.bucketStartMs}`;
}

function insertQueuedRun(
  db: DbHandle,
  input: {
    chain: string;
    tokenAddress: string;
    tokenAddressLower: string;
    tokenSymbol?: string | null;
    trackedWalletAddress: string;
    trackedWalletAddressLower: string;
    userId?: string | null;
    triggerType: HolderSnapshotTriggerType;
    triggerSource: HolderSnapshotTriggerSource;
    tradeAction?: 'buy' | 'sell' | null;
    txHash?: string | null;
    txHashLower?: string | null;
    tradeTimeMs?: number | null;
    holdingsRefreshedAt?: number | null;
    periodBucketStartMs?: number | null;
    dedupeKey: string;
    requestedAt: number;
  }
) {
  const result = db.prepare(
    `INSERT INTO holder_snapshot_runs (
       chain,
       token_address,
       token_address_lower,
       token_symbol,
       tracked_wallet_address,
       tracked_wallet_address_lower,
       user_id,
       trigger_type,
       trigger_source,
       trade_action,
       tx_hash,
       tx_hash_lower,
       trade_time_ms,
       holdings_refreshed_at,
       period_bucket_start_ms,
       dedupe_key,
       status,
       attempt_count,
       holder_count,
       error,
       meta_json,
       requested_at,
       started_at,
       completed_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, '{}', ?, NULL, NULL, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`
  ).run(
    normalizeChain(input.chain),
    input.tokenAddress,
    input.tokenAddressLower,
    input.tokenSymbol || null,
    input.trackedWalletAddress,
    input.trackedWalletAddressLower,
    input.userId || null,
    input.triggerType,
    input.triggerSource,
    input.tradeAction || null,
    input.txHash || null,
    input.txHashLower || null,
    input.tradeTimeMs ?? null,
    input.holdingsRefreshedAt ?? null,
    input.periodBucketStartMs ?? null,
    input.dedupeKey,
    input.requestedAt,
    input.requestedAt
  );

  return result.changes > 0;
}

export function ensureHolderSnapshotTables(db?: DbHandle) {
  getDbOrDefault(db).exec(`
    CREATE TABLE IF NOT EXISTS holder_snapshot_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      token_address_lower TEXT NOT NULL,
      token_symbol TEXT,
      tracked_wallet_address TEXT NOT NULL,
      tracked_wallet_address_lower TEXT NOT NULL,
      user_id TEXT,
      trigger_type TEXT NOT NULL,
      trigger_source TEXT NOT NULL,
      trade_action TEXT,
      tx_hash TEXT,
      tx_hash_lower TEXT,
      trade_time_ms INTEGER,
      holdings_refreshed_at INTEGER,
      period_bucket_start_ms INTEGER,
      dedupe_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      holder_count INTEGER,
      error TEXT,
      meta_json TEXT NOT NULL DEFAULT '{}',
      requested_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES tracked_users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_holder_snapshot_runs_status_requested
    ON holder_snapshot_runs(status, requested_at);

    CREATE INDEX IF NOT EXISTS idx_holder_snapshot_runs_wallet_time
    ON holder_snapshot_runs(tracked_wallet_address_lower, requested_at DESC);

    CREATE INDEX IF NOT EXISTS idx_holder_snapshot_runs_token_time
    ON holder_snapshot_runs(chain, token_address_lower, requested_at DESC);

    CREATE INDEX IF NOT EXISTS idx_holder_snapshot_runs_trade_tx
    ON holder_snapshot_runs(chain, tracked_wallet_address_lower, tx_hash_lower);

    CREATE TABLE IF NOT EXISTS holder_snapshot_holders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_run_id INTEGER NOT NULL,
      holder_rank INTEGER NOT NULL,
      address TEXT NOT NULL,
      account_address TEXT,
      addr_type INTEGER,
      exchange TEXT,
      wallet_tag_v2 TEXT,
      name TEXT,
      twitter_username TEXT,
      balance REAL,
      amount_percentage REAL,
      usd_value REAL,
      cost REAL,
      profit REAL,
      avg_cost REAL,
      realized_profit REAL,
      unrealized_profit REAL,
      buy_tx_count_cur INTEGER,
      sell_tx_count_cur INTEGER,
      is_new INTEGER NOT NULL DEFAULT 0,
      is_suspicious INTEGER NOT NULL DEFAULT 0,
      raw_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(snapshot_run_id, holder_rank),
      FOREIGN KEY (snapshot_run_id) REFERENCES holder_snapshot_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_holder_snapshot_holders_snapshot
    ON holder_snapshot_holders(snapshot_run_id, holder_rank);

    CREATE INDEX IF NOT EXISTS idx_holder_snapshot_holders_address
    ON holder_snapshot_holders(address);

    CREATE INDEX IF NOT EXISTS idx_holder_snapshot_holders_twitter
    ON holder_snapshot_holders(twitter_username);
  `);
}

export function readHolderSnapshotTradeCursor(db?: DbHandle) {
  const value = readAppStateJson<{ lastId?: number }>(
    getDbOrDefault(db),
    HOLDER_SNAPSHOT_TRADE_CURSOR_KEY,
    {}
  );
  return typeof value.lastId === 'number' && Number.isFinite(value.lastId) ? Math.floor(value.lastId) : 0;
}

export function saveHolderSnapshotTradeCursor(lastId: number, db?: DbHandle) {
  const handle = getDbOrDefault(db);
  writeAppStateJson(handle, HOLDER_SNAPSHOT_TRADE_CURSOR_KEY, { lastId: Math.max(0, Math.floor(lastId)) }, Date.now());
}

export function readHolderSnapshotPeriodicCursor(db?: DbHandle) {
  const value = readAppStateJson<{ bucketStartMs?: number }>(
    getDbOrDefault(db),
    HOLDER_SNAPSHOT_PERIODIC_CURSOR_KEY,
    {}
  );
  return typeof value.bucketStartMs === 'number' && Number.isFinite(value.bucketStartMs)
    ? Math.floor(value.bucketStartMs)
    : null;
}

export function saveHolderSnapshotPeriodicCursor(bucketStartMs: number, db?: DbHandle) {
  const handle = getDbOrDefault(db);
  writeAppStateJson(
    handle,
    HOLDER_SNAPSHOT_PERIODIC_CURSOR_KEY,
    { bucketStartMs: Math.max(0, Math.floor(bucketStartMs)) },
    Date.now()
  );
}

export function queueTradeTriggeredHolderSnapshots(input: {
  walletAddress: string;
  chain?: string;
  limit?: number;
  db?: DbHandle;
}): QueueTradeTriggeredHolderSnapshotsResult {
  const db = getDbOrDefault(input.db);
  ensureHolderSnapshotTables(db);

  const chain = normalizeChain(input.chain || 'solana');
  const walletLower = normalizeLower(input.walletAddress);
  const safeLimit = Math.max(1, Math.min(5000, Math.floor(input.limit ?? 500)));
  const lastId = readHolderSnapshotTradeCursor(db);
  const rows = db.prepare(
    `SELECT
       id,
       user_id,
       chain,
       tracked_wallet_address,
       tracked_wallet_address_lower,
       tx_hash,
       tx_hash_lower,
       token_address,
       token_address_lower,
       token_symbol,
       provisional_action,
       event_time_ms
     FROM telegram_monitor_tx_states
     WHERE chain = ?
       AND tracked_wallet_address_lower = ?
       AND provisional_action IN ('buy', 'sell')
       AND reconciliation_status = 'reconciled'
       AND canonical_activity_json IS NOT NULL
       AND token_address IS NOT NULL
       AND token_address_lower IS NOT NULL
       AND id > ?
     ORDER BY id ASC
     LIMIT ?`
  ).all(chain, walletLower, lastId, safeLimit) as TradeTriggerRow[];

  if (rows.length === 0) {
    return {
      scannedCount: 0,
      queuedCount: 0,
      lastSeenId: null,
    };
  }

  const queuedCount = db.transaction(() => {
    let inserted = 0;
    for (const row of rows) {
      const tokenAddress = (row.token_address || '').trim();
      const tokenAddressLower = normalizeTokenAddress(row.token_address_lower || row.token_address, row.chain);
      if (!tokenAddress || !tokenAddressLower) {
        continue;
      }
      const didInsert = insertQueuedRun(db, {
        chain: row.chain,
        tokenAddress,
        tokenAddressLower,
        tokenSymbol: row.token_symbol,
        trackedWalletAddress: row.tracked_wallet_address,
        trackedWalletAddressLower: row.tracked_wallet_address_lower,
        userId: row.user_id,
        triggerType: 'trade',
        triggerSource: 'telegram_monitor_tx_states',
        tradeAction: row.provisional_action,
        txHash: row.tx_hash,
        txHashLower: row.tx_hash_lower,
        tradeTimeMs: row.event_time_ms,
        dedupeKey: buildTradeDedupeKey({
          chain: row.chain,
          trackedWalletAddressLower: row.tracked_wallet_address_lower,
          txHashLower: row.tx_hash_lower,
          tokenAddressLower,
        }),
        requestedAt: Date.now(),
      });
      if (didInsert) {
        inserted += 1;
      }
    }

    const lastSeenId = rows[rows.length - 1]?.id;
    if (typeof lastSeenId === 'number' && Number.isFinite(lastSeenId)) {
      saveHolderSnapshotTradeCursor(lastSeenId, db);
    }
    return inserted;
  })();

  return {
    scannedCount: rows.length,
    queuedCount,
    lastSeenId: rows[rows.length - 1]?.id ?? null,
  };
}

export function queuePeriodicHolderSnapshots(input: {
  walletAddress: string;
  bucketStartMs: number;
  chain?: string;
  db?: DbHandle;
}): QueuePeriodicHolderSnapshotsResult {
  const db = getDbOrDefault(input.db);
  ensureHolderSnapshotTables(db);

  const chain = normalizeChain(input.chain || 'solana');
  const walletLower = normalizeLower(input.walletAddress);
  const bucketStartMs = Math.max(0, Math.floor(input.bucketStartMs));
  const rows = db.prepare(
    `SELECT
       tracked_address,
       tracked_address_lower,
       user_id,
       chain,
       token_address,
       token_address_lower,
       symbol,
       refreshed_at
     FROM current_holdings
     WHERE chain = ?
       AND tracked_address_lower = ?
     ORDER BY refreshed_at DESC, token_address_lower ASC`
  ).all(chain, walletLower) as PeriodicHoldingRow[];

  const dedupedRows = new Map<string, PeriodicHoldingRow>();
  for (const row of rows) {
    const tokenAddressLower = normalizeTokenAddress(row.token_address_lower || row.token_address, row.chain);
    if (!tokenAddressLower) {
      continue;
    }
    if (!dedupedRows.has(tokenAddressLower)) {
      dedupedRows.set(tokenAddressLower, row);
    }
  }

  const queuedCount = db.transaction(() => {
    let inserted = 0;
    for (const row of dedupedRows.values()) {
      const tokenAddress = (row.token_address || '').trim();
      const tokenAddressLower = normalizeTokenAddress(row.token_address_lower || row.token_address, row.chain);
      if (!tokenAddress || !tokenAddressLower) {
        continue;
      }
      const didInsert = insertQueuedRun(db, {
        chain: row.chain,
        tokenAddress,
        tokenAddressLower,
        tokenSymbol: row.symbol,
        trackedWalletAddress: row.tracked_address,
        trackedWalletAddressLower: row.tracked_address_lower,
        userId: row.user_id,
        triggerType: 'periodic',
        triggerSource: 'current_holdings',
        holdingsRefreshedAt: row.refreshed_at,
        periodBucketStartMs: bucketStartMs,
        dedupeKey: buildPeriodicDedupeKey({
          chain: row.chain,
          trackedWalletAddressLower: row.tracked_address_lower,
          tokenAddressLower,
          bucketStartMs,
        }),
        requestedAt: Date.now(),
      });
      if (didInsert) {
        inserted += 1;
      }
    }
    saveHolderSnapshotPeriodicCursor(bucketStartMs, db);
    return inserted;
  })();

  return {
    queuedCount,
    bucketStartMs,
    tokenCount: dedupedRows.size,
  };
}

export function queueManualHolderSnapshot(input: {
  walletAddress: string;
  chain?: string;
  tokenAddress: string;
  tokenSymbol?: string | null;
  userId?: string | null;
  requestedAt?: number;
  dedupeKey?: string;
  db?: DbHandle;
}) {
  const db = getDbOrDefault(input.db);
  ensureHolderSnapshotTables(db);

  const chain = normalizeChain(input.chain || 'solana');
  const tokenAddress = (input.tokenAddress || '').trim();
  const tokenAddressLower = normalizeTokenAddress(tokenAddress, chain);
  const trackedWalletAddress = (input.walletAddress || '').trim();
  const trackedWalletAddressLower = normalizeLower(trackedWalletAddress);
  const requestedAt = Math.max(0, Math.floor(input.requestedAt ?? Date.now()));
  if (!tokenAddress || !tokenAddressLower || !trackedWalletAddress || !trackedWalletAddressLower) {
    throw new Error('manual holder snapshot requires wallet and token address');
  }

  const dedupeKey =
    input.dedupeKey || `manual|${chain}|${trackedWalletAddressLower}|${tokenAddressLower}|${requestedAt}`;

  insertQueuedRun(db, {
    chain,
    tokenAddress,
    tokenAddressLower,
    tokenSymbol: input.tokenSymbol,
    trackedWalletAddress,
    trackedWalletAddressLower,
    userId: input.userId,
    triggerType: 'manual',
    triggerSource: 'manual',
    dedupeKey,
    requestedAt,
  });

  return db.prepare('SELECT * FROM holder_snapshot_runs WHERE dedupe_key = ? LIMIT 1').get(dedupeKey) as
    | HolderSnapshotRunRow
    | undefined;
}

export function claimNextQueuedHolderSnapshotRun(db?: DbHandle) {
  const handle = getDbOrDefault(db);
  ensureHolderSnapshotTables(handle);

  const claim = handle.transaction(() => {
    const row = handle.prepare(
      `SELECT *
       FROM holder_snapshot_runs
       WHERE status = 'queued'
       ORDER BY requested_at ASC, id ASC
       LIMIT 1`
    ).get() as HolderSnapshotRunRow | undefined;
    if (!row) {
      return null;
    }

    const now = Date.now();
    const result = handle.prepare(
      `UPDATE holder_snapshot_runs
       SET status = 'running',
           attempt_count = attempt_count + 1,
           started_at = COALESCE(started_at, ?),
           updated_at = ?
       WHERE id = ?
         AND status = 'queued'`
    ).run(now, now, row.id);
    if (result.changes === 0) {
      return null;
    }

    return mapRunRow(
      handle.prepare('SELECT * FROM holder_snapshot_runs WHERE id = ? LIMIT 1').get(row.id) as
        | HolderSnapshotRunRow
        | undefined
    );
  });

  return claim();
}

export function completeHolderSnapshotRun(input: {
  runId: number;
  holders: HolderSnapshotCollectedHolder[];
  meta?: Record<string, unknown>;
  db?: DbHandle;
}) {
  const db = getDbOrDefault(input.db);
  ensureHolderSnapshotTables(db);
  const now = Date.now();

  const complete = db.transaction(() => {
    db.prepare('DELETE FROM holder_snapshot_holders WHERE snapshot_run_id = ?').run(input.runId);

    const insertHolder = db.prepare(
      `INSERT INTO holder_snapshot_holders (
         snapshot_run_id,
         holder_rank,
         address,
         account_address,
         addr_type,
         exchange,
         wallet_tag_v2,
         name,
         twitter_username,
         balance,
         amount_percentage,
         usd_value,
         cost,
         profit,
         avg_cost,
         realized_profit,
         unrealized_profit,
         buy_tx_count_cur,
         sell_tx_count_cur,
         is_new,
         is_suspicious,
         raw_json,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    let insertedCount = 0;
    input.holders.forEach((holder, index) => {
      const address = (holder.address || '').trim();
      if (!address) {
        return;
      }
      const holderRank =
        typeof holder.holderRank === 'number' && Number.isFinite(holder.holderRank)
          ? Math.max(1, Math.floor(holder.holderRank))
          : index + 1;
      insertHolder.run(
        input.runId,
        holderRank,
        address,
        holder.accountAddress || null,
        holder.addrType ?? null,
        holder.exchange || null,
        holder.walletTagV2 || null,
        holder.name || null,
        holder.twitterUsername || null,
        holder.balance ?? null,
        holder.amountPercentage ?? null,
        holder.usdValue ?? null,
        holder.cost ?? null,
        holder.profit ?? null,
        holder.avgCost ?? null,
        holder.realizedProfit ?? null,
        holder.unrealizedProfit ?? null,
        holder.buyTxCountCur ?? null,
        holder.sellTxCountCur ?? null,
        holder.isNew ? 1 : 0,
        holder.isSuspicious ? 1 : 0,
        JSON.stringify(holder.raw),
        now
      );
      insertedCount += 1;
    });

    db.prepare(
      `UPDATE holder_snapshot_runs
       SET status = 'completed',
           holder_count = ?,
           error = NULL,
           meta_json = ?,
           completed_at = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(insertedCount, JSON.stringify(input.meta || {}), now, now, input.runId);
  });

  complete();
  // keep disk bounded: drop old completed/failed runs (keep latest N globally)
  try {
    pruneHolderSnapshotHistory({ keepLatest: 40, db });
  } catch {
    /* non-fatal */
  }
  return getHolderSnapshotRunById(input.runId, db);
}

export function failHolderSnapshotRun(input: {
  runId: number;
  error: string;
  meta?: Record<string, unknown>;
  db?: DbHandle;
}) {
  const db = getDbOrDefault(input.db);
  ensureHolderSnapshotTables(db);
  const now = Date.now();
  db.prepare(
    `UPDATE holder_snapshot_runs
     SET status = 'failed',
         error = ?,
         meta_json = ?,
         completed_at = NULL,
         updated_at = ?
     WHERE id = ?`
  ).run(truncateError(input.error), JSON.stringify(input.meta || {}), now, input.runId);
  return getHolderSnapshotRunById(input.runId, db);
}

export function countQueuedHolderSnapshotRuns(db?: DbHandle) {
  const dbHandle = getDbOrDefault(db);
  ensureHolderSnapshotTables(dbHandle);
  const row = dbHandle.prepare(`SELECT COUNT(*) as count FROM holder_snapshot_runs WHERE status = 'queued'`).get() as {
    count: number;
  };
  return row.count;
}

/**
 * Keep the latest `keepLatest` finished runs (completed/failed/skipped).
 * Never delete queued/running. Cascades holders by run id.
 */
export function pruneHolderSnapshotHistory(opts?: {
  keepLatest?: number;
  db?: DbHandle;
}) {
  const db = getDbOrDefault(opts?.db);
  ensureHolderSnapshotTables(db);
  const keep = Math.max(10, Math.min(500, Math.floor(opts?.keepLatest ?? 40)));

  const oldIds = db
    .prepare(
      `SELECT id FROM holder_snapshot_runs
       WHERE status IN ('completed', 'failed', 'skipped')
         AND id NOT IN (
           SELECT id FROM holder_snapshot_runs
           WHERE status IN ('completed', 'failed', 'skipped')
           ORDER BY COALESCE(completed_at, updated_at, requested_at) DESC, id DESC
           LIMIT ?
         )`,
    )
    .all(keep) as Array<{ id: number }>;

  if (!oldIds.length) return { deleted_runs: 0, deleted_holders: 0 };

  const delHolders = db.prepare(
    `DELETE FROM holder_snapshot_holders WHERE snapshot_run_id = ?`,
  );
  const delRun = db.prepare(`DELETE FROM holder_snapshot_runs WHERE id = ?`);
  let deletedHolders = 0;
  const tx = db.transaction(() => {
    for (const r of oldIds) {
      const h = delHolders.run(r.id);
      deletedHolders += Number(h.changes || 0);
      delRun.run(r.id);
    }
  });
  tx();
  return { deleted_runs: oldIds.length, deleted_holders: deletedHolders };
}

export function getHolderSnapshotRunById(runId: number, db?: DbHandle) {
  const row = getDbOrDefault(db)
    .prepare('SELECT * FROM holder_snapshot_runs WHERE id = ? LIMIT 1')
    .get(runId) as HolderSnapshotRunRow | undefined;
  return mapRunRow(row);
}

export function listHolderSnapshotRuns(db?: DbHandle) {
  const rows = getDbOrDefault(db).prepare(
    `SELECT *
     FROM holder_snapshot_runs
     ORDER BY requested_at ASC, id ASC`
  ).all() as HolderSnapshotRunRow[];
  return rows.map((row) => mapRunRow(row)).filter((row): row is HolderSnapshotRun => Boolean(row));
}

export function listHolderSnapshotHolders(runId: number, db?: DbHandle) {
  const rows = getDbOrDefault(db).prepare(
    `SELECT *
     FROM holder_snapshot_holders
     WHERE snapshot_run_id = ?
     ORDER BY holder_rank ASC, id ASC`
  ).all(runId) as HolderSnapshotHolderRow[];
  return rows.map((row) => mapHolderRow(row));
}
