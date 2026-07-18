import 'server-only';

import { spawn } from 'node:child_process';

import { fetchOkxAddressAssetDetails, isSupportedOkxChain } from '@/lib/okx';
import { getDb, type DbHandle } from '@/lib/server/sqlite';
import { batchFetchFromDexScreener } from '@/lib/server/dexscreener';
import {
  validateAndPersistPeakAssetSnapshots,
} from '@/lib/server/assetPeakValidation';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import type { AddressAssetSnapshot, UserAssetSnapshot } from '@/lib/activityFeed';

const MIN_HOLDING_USD = 5;
const MIN_LIQUIDITY_USD = 5_000;
const DEFAULT_HOLDINGS_REFRESH_INTERVAL_MS = 30 * 60_000;
const SUPPORTED_CHAINS = ['bsc', 'ethereum', 'base', 'solana'] as const;
const EVM_CHAINS = new Set(['bsc', 'ethereum', 'base']);
const ROBINHOOD_CHAIN = 'robinhood' as const;
const GMGN_CLI_PATH = process.env.GMGN_CLI_PATH?.trim() || 'gmgn-cli';

type SupportedChain = (typeof SUPPORTED_CHAINS)[number];
type HoldingsChain = SupportedChain | typeof ROBINHOOD_CHAIN;

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
  chain: HoldingsChain;
  token_address: string;
  token_address_lower: string;
  symbol: string;
  name: string | null;
  balance: number;
  price_usd: number;
  value_usd: number;
  liquidity_usd: number | null;
  refreshed_at: number;
}

interface CurrentHoldingWalletStatusRecord {
  tracked_address: string;
  tracked_address_lower: string;
  user_id: string;
  chain: HoldingsChain;
  status: 'success' | 'failed';
  refreshed_at: number;
}

export interface RobinhoodHoldingAsset {
  tokenAddress: string;
  symbol: string;
  name: string | null;
  balance: number;
  priceUsd: number;
  valueUsd: number;
  liquidityUsd: number | null;
}

export interface RobinhoodHoldingsResult {
  ok: boolean;
  assets: RobinhoodHoldingAsset[];
  error: string | null;
  rateLimited?: boolean;
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
  robinhoodWalletCount: number;
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
  fetchRobinhoodHoldings?: (address: string, signal?: AbortSignal) => Promise<RobinhoodHoldingsResult>;
  persistAssetSnapshots?: typeof validateAndPersistPeakAssetSnapshots;
  fetchTokenLiquidity?: Parameters<typeof validateAndPersistPeakAssetSnapshots>[0]['fetchTokenLiquidity'];
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
      liquidity_usd REAL,
      refreshed_at INTEGER NOT NULL,
      UNIQUE(tracked_address_lower, chain, token_address_lower)
    );
    CREATE INDEX IF NOT EXISTS idx_holdings_token
      ON current_holdings(chain, token_address_lower);
    CREATE INDEX IF NOT EXISTS idx_holdings_user
      ON current_holdings(user_id);
    CREATE INDEX IF NOT EXISTS idx_holdings_value
      ON current_holdings(value_usd);
    CREATE TABLE IF NOT EXISTS current_holdings_wallet_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracked_address TEXT NOT NULL,
      tracked_address_lower TEXT NOT NULL,
      user_id TEXT,
      chain TEXT NOT NULL,
      status TEXT NOT NULL,
      refreshed_at INTEGER NOT NULL,
      UNIQUE(tracked_address_lower, chain)
    );
    CREATE INDEX IF NOT EXISTS idx_holdings_wallet_status_user
      ON current_holdings_wallet_status(user_id);
  `);
  // Add liquidity_usd column if it doesn't exist (migration for existing tables)
  try {
    getDbOrDefault(db).exec('ALTER TABLE current_holdings ADD COLUMN liquidity_usd REAL');
  } catch {
    // Column already exists — ignore
  }
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

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isRateLimitError(message: string) {
  return /429|rate.?limit|RATE_LIMIT/i.test(message);
}

function listRobinhoodCandidateWallets(db: DbHandle, trackedAddresses: TrackedAddressRow[]) {
  const trackedByLower = new Map<string, TrackedAddressRow>();
  for (const row of trackedAddresses) {
    if (!EVM_CHAINS.has(row.chain)) continue;
    if (!trackedByLower.has(row.address_lower)) {
      trackedByLower.set(row.address_lower, row);
    }
  }
  if (trackedByLower.size === 0) return [];

  let eventWallets: Array<{ tracked_wallet_address_lower: string | null }> = [];
  try {
    eventWallets = db
      .prepare(
        `SELECT DISTINCT tracked_wallet_address_lower
         FROM telegram_monitor_events
         WHERE chain = 'robinhood'
           AND tracked_wallet_address_lower IS NOT NULL
           AND tracked_wallet_address_lower != ''`
      )
      .all() as Array<{ tracked_wallet_address_lower: string | null }>;
  } catch {
    // Table may not exist in tests / fresh DBs.
    return [];
  }

  const candidates: TrackedAddressRow[] = [];
  for (const event of eventWallets) {
    const lower = event.tracked_wallet_address_lower?.toLowerCase();
    if (!lower) continue;
    const tracked = trackedByLower.get(lower);
    if (tracked) candidates.push(tracked);
  }
  return candidates;
}

function mapGmgnHolding(raw: Record<string, unknown>): RobinhoodHoldingAsset | null {
  const token = raw.token && typeof raw.token === 'object' && !Array.isArray(raw.token)
    ? (raw.token as Record<string, unknown>)
    : null;
  const tokenAddress =
    (typeof token?.token_address === 'string' && token.token_address.trim()) ||
    (typeof token?.address === 'string' && token.address.trim()) ||
    '';
  if (!tokenAddress) return null;

  const valueUsd = toNumber(raw.usd_value) ?? 0;
  const balance = toNumber(raw.balance) ?? 0;
  const priceUsd = toNumber(token?.price) ?? (balance > 0 ? valueUsd / balance : 0);
  const liquidityUsd = toNumber(token?.liquidity);

  return {
    tokenAddress,
    symbol: typeof token?.symbol === 'string' && token.symbol.trim() ? token.symbol.trim() : tokenAddress.slice(0, 8),
    name: typeof token?.name === 'string' && token.name.trim() ? token.name.trim() : null,
    balance,
    priceUsd,
    valueUsd,
    liquidityUsd,
  };
}

function parseGmgnHoldingsList(stdout: string): { assets: RobinhoodHoldingAsset[]; next: string } {
  const payload = JSON.parse(stdout) as {
    list?: unknown;
    holdings?: unknown;
    next?: unknown;
    data?: { list?: unknown; holdings?: unknown; next?: unknown };
  };
  const rows = payload.list ?? payload.holdings ?? payload.data?.list ?? payload.data?.holdings ?? [];
  if (!Array.isArray(rows)) {
    throw new Error('gmgn-cli portfolio holdings payload is not a list');
  }

  const assets = rows
    .map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      return mapGmgnHolding(row as Record<string, unknown>);
    })
    .filter((row): row is RobinhoodHoldingAsset => Boolean(row));

  const nextRaw = payload.next ?? payload.data?.next ?? '';
  const next = typeof nextRaw === 'string' ? nextRaw.trim() : '';
  return { assets, next };
}

async function runGmgnCli(args: string[], signal?: AbortSignal): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(GMGN_CLI_PATH, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const abort = () => {
      if (!settled) child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      settled = true;
      signal?.removeEventListener('abort', abort);
      reject(error);
    });

    child.on('exit', (code, exitSignal) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);

      if (signal?.aborted) {
        reject(new Error('gmgn-cli aborted'));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `gmgn-cli exited with code ${code ?? 'null'}${exitSignal ? ` signal ${exitSignal}` : ''}: ${stderr.trim().slice(0, 500)}`
          )
        );
        return;
      }
      resolve(stdout);
    });
  });
}

export async function fetchRobinhoodHoldingsWithCli(
  address: string,
  signal?: AbortSignal
): Promise<RobinhoodHoldingsResult> {
  try {
    const assets: RobinhoodHoldingAsset[] = [];
    let cursor = '';

    // ponytail: sequential page fetch; parallel pages if GMGN rate budget ever allows it
    for (;;) {
      ensureNotAborted(signal);
      const args = [
        'portfolio',
        'holdings',
        '--chain',
        'robinhood',
        '--wallet',
        address,
        '--order-by',
        'usd_value',
        '--direction',
        'desc',
        '--limit',
        '50',
        '--hide-abnormal',
        'true',
        '--raw',
      ];
      if (cursor) {
        args.push('--cursor', cursor);
      }

      const stdout = await runGmgnCli(args, signal);
      const page = parseGmgnHoldingsList(stdout);
      assets.push(...page.assets);
      if (!page.next || page.next === cursor) break;
      cursor = page.next;
    }

    return { ok: true, assets, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      assets: [],
      error: message,
      rateLimited: isRateLimitError(message),
    };
  }
}

function readPreviousRobinhoodHoldings(db: DbHandle, addressLower: string): CurrentHoldingRecord[] {
  try {
    return db
      .prepare(
        `SELECT tracked_address, tracked_address_lower, user_id, chain, token_address, token_address_lower,
                symbol, name, balance, price_usd, value_usd, liquidity_usd, refreshed_at
         FROM current_holdings
         WHERE chain = ? AND tracked_address_lower = ?`
      )
      .all(ROBINHOOD_CHAIN, addressLower) as CurrentHoldingRecord[];
  } catch {
    return [];
  }
}

function replaceCurrentHoldings(
  db: DbHandle,
  holdings: CurrentHoldingRecord[],
  walletStatuses: CurrentHoldingWalletStatusRecord[]
) {
  const write = db.transaction(() => {
    db.prepare('DELETE FROM current_holdings').run();
    db.prepare('DELETE FROM current_holdings_wallet_status').run();

    const insert = db.prepare(`
      INSERT OR REPLACE INTO current_holdings
      (tracked_address, tracked_address_lower, user_id, chain,
       token_address, token_address_lower, symbol, name,
        balance, price_usd, value_usd, liquidity_usd, refreshed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertStatus = db.prepare(`
      INSERT OR REPLACE INTO current_holdings_wallet_status
      (tracked_address, tracked_address_lower, user_id, chain, status, refreshed_at)
      VALUES (?, ?, ?, ?, ?, ?)
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
        holding.liquidity_usd,
        holding.refreshed_at
      );
    }

    for (const status of walletStatuses) {
      insertStatus.run(
        status.tracked_address,
        status.tracked_address_lower,
        status.user_id,
        status.chain,
        status.status,
        status.refreshed_at
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
  const fetchRobinhoodHoldings = options.fetchRobinhoodHoldings ?? fetchRobinhoodHoldingsWithCli;
  const nowMs = options.now ? options.now() : Date.now();

  ensureCurrentHoldingsTable(db);

  const trackedAddresses = listTrackedAddresses(db);
  const uniqueTrackedAddresses = dedupeTrackedAddresses(trackedAddresses);
  const robinhoodCandidates = listRobinhoodCandidateWallets(db, uniqueTrackedAddresses);
  const summary: HoldingsRefreshSummary = {
    trackedAddressCount: trackedAddresses.length,
    uniqueTrackedAddressCount: uniqueTrackedAddresses.length,
    refreshedWalletCount: 0,
    failedWalletCount: 0,
    holdingsRowCount: 0,
    filteredOutHoldingCount: 0,
    robinhoodWalletCount: robinhoodCandidates.length,
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
  const walletStatuses: CurrentHoldingWalletStatusRecord[] = [];
  const addressAssets: AddressAssetSnapshot[] = [];
  const failedUserIds = new Set<string>();
  const completeUserIds = new Set<string>();
  let lastError: string | null = null;
  let credentialFailure = false;

  for (const row of uniqueTrackedAddresses) {
    ensureNotAborted(options.signal);

    if (!isSupportedOkxChain(row.chain)) {
      walletStatuses.push({
        tracked_address: row.address,
        tracked_address_lower: row.address_lower,
        user_id: row.user_id,
        chain: row.chain,
        status: 'failed',
        refreshed_at: nowMs,
      });
      summary.failedWalletCount += 1;
      failedUserIds.add(row.user_id);
      lastError = lastError ?? `Unsupported chain: ${row.chain}`;
      continue;
    }

    const result = await fetchAddressAssetDetails(row.address, row.chain);
    if (!result.ok) {
      walletStatuses.push({
        tracked_address: row.address,
        tracked_address_lower: row.address_lower,
        user_id: row.user_id,
        chain: row.chain,
        status: 'failed',
        refreshed_at: nowMs,
      });
      summary.failedWalletCount += 1;
      failedUserIds.add(row.user_id);
      lastError = lastError ?? result.error;
      credentialFailure ||= !result.configured;
      continue;
    }

    addressAssets.push({
      userId: row.user_id,
      address: row.address,
      chain: row.chain,
      totalAssetUsd: result.assets.reduce((sum, asset) => sum + asset.valueUsd, 0),
      updatedAt: nowMs,
    });

    walletStatuses.push({
      tracked_address: row.address,
      tracked_address_lower: row.address_lower,
      user_id: row.user_id,
      chain: row.chain,
      status: 'success',
      refreshed_at: nowMs,
    });
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
        liquidity_usd: null,
        refreshed_at: nowMs,
      });
    }
  }

  // Robinhood: only XXYY-active EVM wallets, sequential GMGN portfolio fetch
  let stopRobinhood = false;
  for (const row of robinhoodCandidates) {
    ensureNotAborted(options.signal);
    if (stopRobinhood) {
      walletStatuses.push({
        tracked_address: row.address,
        tracked_address_lower: row.address_lower,
        user_id: row.user_id,
        chain: ROBINHOOD_CHAIN,
        status: 'failed',
        refreshed_at: nowMs,
      });
      summary.failedWalletCount += 1;
      holdings.push(...readPreviousRobinhoodHoldings(db, row.address_lower));
      continue;
    }

    const result = await fetchRobinhoodHoldings(row.address, options.signal);
    if (!result.ok) {
      walletStatuses.push({
        tracked_address: row.address,
        tracked_address_lower: row.address_lower,
        user_id: row.user_id,
        chain: ROBINHOOD_CHAIN,
        status: 'failed',
        refreshed_at: nowMs,
      });
      summary.failedWalletCount += 1;
      lastError = lastError ?? result.error;
      holdings.push(...readPreviousRobinhoodHoldings(db, row.address_lower));
      if (result.rateLimited) {
        stopRobinhood = true;
      }
      continue;
    }

    walletStatuses.push({
      tracked_address: row.address,
      tracked_address_lower: row.address_lower,
      user_id: row.user_id,
      chain: ROBINHOOD_CHAIN,
      status: 'success',
      refreshed_at: nowMs,
    });
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
        chain: ROBINHOOD_CHAIN,
        token_address: asset.tokenAddress,
        token_address_lower: asset.tokenAddress.toLowerCase(),
        symbol: asset.symbol,
        name: asset.name,
        balance: asset.balance,
        price_usd: asset.priceUsd,
        value_usd: asset.valueUsd,
        liquidity_usd: asset.liquidityUsd,
        refreshed_at: nowMs,
      });
    }
  }

  // Batch fetch liquidity from DexScreener for non-Robinhood tokens only
  const uniqueTokens = new Map<string, { contractAddress: string; chain: string }>();
  for (const h of holdings) {
    if (h.chain === ROBINHOOD_CHAIN) continue;
    const key = `${h.chain}:${h.token_address_lower}`;
    if (!uniqueTokens.has(key)) {
      uniqueTokens.set(key, { contractAddress: h.token_address, chain: h.chain });
    }
  }

  try {
    const liquidityData = await batchFetchFromDexScreener(Array.from(uniqueTokens.values()));
    for (const h of holdings) {
      if (h.chain === ROBINHOOD_CHAIN) continue;
      const liquidityKey = h.chain === 'solana' ? h.token_address : h.token_address_lower;
      const data = liquidityData.get(liquidityKey);
      if (data) {
        h.liquidity_usd = data.liquidity;
      }
    }
  } catch (err) {
    console.error('[holdingsRefresh] DexScreener liquidity fetch failed:', err);
  }

  // Filter out dead coins with insufficient liquidity
  const filteredHoldings = holdings.filter((h) => {
    if (h.liquidity_usd !== null && h.liquidity_usd < MIN_LIQUIDITY_USD) {
      summary.filteredOutHoldingCount += 1;
      return false;
    }
    return true;
  });

  summary.holdingsRowCount = filteredHoldings.length;

  if (!options.dryRun) {
    replaceCurrentHoldings(db, filteredHoldings, walletStatuses);

    const users = listTrackedUsers();
    for (const user of users) {
      if (!failedUserIds.has(user.id)) {
        completeUserIds.add(user.id);
      }
    }
    const completeAddressAssets = addressAssets.filter(
      (snapshot) => snapshot.userId && completeUserIds.has(snapshot.userId)
    );
    const userTotals = new Map<string, number>();
    for (const snapshot of completeAddressAssets) {
      userTotals.set(snapshot.userId!, (userTotals.get(snapshot.userId!) ?? 0) + snapshot.totalAssetUsd);
    }
    const userAssets: UserAssetSnapshot[] = Array.from(userTotals, ([userId, totalAssetUsd]) => ({
      userId,
      totalValueUsd: totalAssetUsd,
      totalAssetUsd,
      updatedAt: nowMs,
    }));

    await (options.persistAssetSnapshots ?? validateAndPersistPeakAssetSnapshots)({
      users,
      addressAssets: completeAddressAssets,
      userAssets,
      fetchAddressAssetDetails,
      fetchTokenLiquidity: options.fetchTokenLiquidity,
    });
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
