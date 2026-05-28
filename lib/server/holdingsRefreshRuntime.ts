import 'server-only';

import { fetchOkxAddressAssetDetails, isSupportedOkxChain } from '@/lib/okx';
import { getDb, type DbHandle } from '@/lib/server/sqlite';

const MIN_HOLDING_USD = 5;
const DEFAULT_HOLDINGS_REFRESH_INTERVAL_MS = 30 * 60_000;
const SUPPORTED_CHAINS = ['bsc', 'ethereum', 'base', 'solana'] as const;

type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

interface TrackedAddressRow {
  user_id: string;
  address: string;
  address_lower: string;
  chain: SupportedChain;
}

interface CurrentHoldingRecord {
  tracked_address: string;
  tracked_address_lower: string;
  user_id: string;
  chain: SupportedChain;
  token_address: string;
  token_address_lower: string;
  symbol: string;
  name: string | null;
  balance: number;
  price_usd: number;
  value_usd: number;
  refreshed_at: number;
}

export interface CurrentHoldingsStats {
  totalRecords: number;
  uniqueTokens: number;
  uniqueWallets: number;
  uniqueUsers: number;
  refreshedAtMs: number | null;
  chainDistribution: Array<{
    chain: string;
    tokenCount: number;
  }>;
  topTokens: Array<{
    tokenAddressLower: string;
    chain: string;
    symbol: string | null;
    holders: number;
    totalValue: number;
  }>;
}

export interface HoldingsRefreshSummary {
  trackedAddressCount: number;
  uniqueTrackedAddressCount: number;
  refreshedWalletCount: number;
  failedWalletCount: number;
  holdingsRowCount: number;
  filteredOutHoldingCount: number;
  refreshedAtMs: number;
}

export interface HoldingsRefreshRunResult {
  status: 'idle' | 'partial' | 'error' | 'missing-credentials';
  summary: HoldingsRefreshSummary;
  lastError: string | null;
}

interface RunHoldingsRefreshOptions {
  db?: DbHandle;
  dryRun?: boolean;
  signal?: AbortSignal;
  now?: () => number;
  fetchAddressAssetDetails?: typeof fetchOkxAddressAssetDetails;
}

function getDbOrDefault(db?: DbHandle) {
  return db ?? getDb();
}

function ensureNotAborted(signal?: AbortSignal) {
  if (!signal?.aborted) {
    return;
  }

  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : 'holdings refresh aborted');
}

function hasOkxCredentials() {
  return Boolean(
    process.env.OKX_API_KEY?.trim() &&
      process.env.OKX_SECRET_KEY?.trim() &&
      process.env.OKX_API_PASSPHRASE?.trim()
  );
}

export function getHoldingsRefreshIntervalMs() {
  const configured = Number.parseInt(process.env.HOLDINGS_REFRESH_INTERVAL_MS || '', 10);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_HOLDINGS_REFRESH_INTERVAL_MS;
  }

  return Math.max(60_000, configured);
}

export function ensureCurrentHoldingsTable(db?: DbHandle) {
  getDbOrDefault(db).exec(`
    CREATE TABLE IF NOT EXISTS current_holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracked_address TEXT NOT NULL,
      tracked_address_lower TEXT NOT NULL,
      user_id TEXT,
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      token_address_lower TEXT NOT NULL,
      symbol TEXT,
      name TEXT,
      balance REAL,
      price_usd REAL,
      value_usd REAL,
      refreshed_at INTEGER NOT NULL,
      UNIQUE(tracked_address_lower, chain, token_address_lower)
    );
    CREATE INDEX IF NOT EXISTS idx_holdings_token
      ON current_holdings(chain, token_address_lower);
    CREATE INDEX IF NOT EXISTS idx_holdings_user
      ON current_holdings(user_id);
    CREATE INDEX IF NOT EXISTS idx_holdings_value
      ON current_holdings(value_usd);
  `);
}

function listTrackedAddresses(db: DbHandle) {
  return db
    .prepare(`
      SELECT user_id, address, address_lower, chain
      FROM tracked_addresses
      WHERE chain IN (${SUPPORTED_CHAINS.map((chain) => `'${chain}'`).join(',')})
    `)
    .all() as TrackedAddressRow[];
}

function dedupeTrackedAddresses(rows: TrackedAddressRow[]) {
  const seen = new Set<string>();
  const uniqueRows: TrackedAddressRow[] = [];

  for (const row of rows) {
    const key = `${row.address_lower}:${row.chain}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueRows.push(row);
  }

  return uniqueRows;
}

function replaceCurrentHoldings(db: DbHandle, holdings: CurrentHoldingRecord[]) {
  const write = db.transaction(() => {
    db.prepare('DELETE FROM current_holdings').run();

    const insert = db.prepare(`
      INSERT OR REPLACE INTO current_holdings
      (tracked_address, tracked_address_lower, user_id, chain,
       token_address, token_address_lower, symbol, name,
       balance, price_usd, value_usd, refreshed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const holding of holdings) {
      insert.run(
        holding.tracked_address,
        holding.tracked_address_lower,
        holding.user_id,
        holding.chain,
        holding.token_address,
        holding.token_address_lower,
        holding.symbol,
        holding.name,
        holding.balance,
        holding.price_usd,
        holding.value_usd,
        holding.refreshed_at
      );
    }
  });

  write();
}

export function readCurrentHoldingsStats(db?: DbHandle): CurrentHoldingsStats {
  const handle = getDbOrDefault(db);
  ensureCurrentHoldingsTable(handle);

  const totalRecords = (handle.prepare('SELECT COUNT(*) as c FROM current_holdings').get() as { c: number }).c;
  const uniqueTokens = (
    handle.prepare('SELECT COUNT(DISTINCT token_address_lower) as c FROM current_holdings').get() as { c: number }
  ).c;
  const uniqueWallets = (
    handle.prepare('SELECT COUNT(DISTINCT tracked_address_lower) as c FROM current_holdings').get() as { c: number }
  ).c;
  const uniqueUsers = (
    handle.prepare('SELECT COUNT(DISTINCT user_id) as c FROM current_holdings').get() as { c: number }
  ).c;
  const refreshedAtMs = (
    handle.prepare('SELECT MAX(refreshed_at) as ts FROM current_holdings').get() as { ts: number | null }
  ).ts;

  const chainDistribution = handle.prepare(
    'SELECT chain, COUNT(DISTINCT token_address_lower) as c FROM current_holdings GROUP BY chain ORDER BY chain ASC'
  ).all() as Array<{ chain: string; c: number }>;

  const topTokens = handle.prepare(`
    SELECT token_address_lower, chain, symbol,
           COUNT(DISTINCT tracked_address_lower) as holders,
           SUM(value_usd) as total_value
    FROM current_holdings
    GROUP BY token_address_lower, chain, symbol
    ORDER BY holders DESC, total_value DESC
    LIMIT 10
  `).all() as Array<{
    token_address_lower: string;
    chain: string;
    symbol: string | null;
    holders: number;
    total_value: number | null;
  }>;

  return {
    totalRecords,
    uniqueTokens,
    uniqueWallets,
    uniqueUsers,
    refreshedAtMs,
    chainDistribution: chainDistribution.map((row) => ({
      chain: row.chain,
      tokenCount: row.c,
    })),
    topTokens: topTokens.map((row) => ({
      tokenAddressLower: row.token_address_lower,
      chain: row.chain,
      symbol: row.symbol,
      holders: row.holders,
      totalValue: row.total_value ?? 0,
    })),
  };
}

export async function refreshCurrentHoldings(
  options: RunHoldingsRefreshOptions = {}
): Promise<HoldingsRefreshRunResult> {
  const db = getDbOrDefault(options.db);
  const fetchAddressAssetDetails = options.fetchAddressAssetDetails ?? fetchOkxAddressAssetDetails;
  const nowMs = options.now ? options.now() : Date.now();

  ensureCurrentHoldingsTable(db);

  const trackedAddresses = listTrackedAddresses(db);
  const uniqueTrackedAddresses = dedupeTrackedAddresses(trackedAddresses);
  const summary: HoldingsRefreshSummary = {
    trackedAddressCount: trackedAddresses.length,
    uniqueTrackedAddressCount: uniqueTrackedAddresses.length,
    refreshedWalletCount: 0,
    failedWalletCount: 0,
    holdingsRowCount: 0,
    filteredOutHoldingCount: 0,
    refreshedAtMs: nowMs,
  };

  if (!hasOkxCredentials()) {
    return {
      status: 'missing-credentials',
      summary,
      lastError: 'Missing OKX API credentials',
    };
  }

  const holdings: CurrentHoldingRecord[] = [];
  let lastError: string | null = null;
  let credentialFailure = false;

  for (const row of uniqueTrackedAddresses) {
    ensureNotAborted(options.signal);

    if (!isSupportedOkxChain(row.chain)) {
      summary.failedWalletCount += 1;
      lastError = lastError ?? `Unsupported chain: ${row.chain}`;
      continue;
    }

    const result = await fetchAddressAssetDetails(row.address, row.chain);
    if (!result.ok) {
      summary.failedWalletCount += 1;
      lastError = lastError ?? result.error;
      credentialFailure ||= !result.configured;
      continue;
    }

    summary.refreshedWalletCount += 1;

    for (const asset of result.assets) {
      if (asset.valueUsd < MIN_HOLDING_USD) {
        summary.filteredOutHoldingCount += 1;
        continue;
      }

      holdings.push({
        tracked_address: row.address,
        tracked_address_lower: row.address_lower,
        user_id: row.user_id,
        chain: row.chain,
        token_address: asset.tokenAddress,
        token_address_lower: row.chain === 'solana' ? asset.tokenAddress : asset.tokenAddress.toLowerCase(),
        symbol: asset.symbol,
        name: asset.name,
        balance: asset.balance,
        price_usd: asset.priceUsd,
        value_usd: asset.valueUsd,
        refreshed_at: nowMs,
      });
    }
  }

  summary.holdingsRowCount = holdings.length;

  if (!options.dryRun) {
    replaceCurrentHoldings(db, holdings);
  }

  if (credentialFailure && summary.refreshedWalletCount === 0) {
    return {
      status: 'missing-credentials',
      summary,
      lastError: lastError ?? 'Missing OKX API credentials',
    };
  }

  if (summary.failedWalletCount > 0 && summary.refreshedWalletCount === 0) {
    return {
      status: 'error',
      summary,
      lastError: lastError ?? 'Failed to refresh all tracked holdings',
    };
  }

  if (summary.failedWalletCount > 0) {
    return {
      status: 'partial',
      summary,
      lastError,
    };
  }

  return {
    status: 'idle',
    summary,
    lastError: null,
  };
}

export async function runHoldingsRefreshCycle(options: RunHoldingsRefreshOptions = {}) {
  const result = await refreshCurrentHoldings(options);
  return {
    sleepMs: getHoldingsRefreshIntervalMs(),
    status: result.status,
    summary: result.summary,
    lastError: result.lastError,
  };
}
