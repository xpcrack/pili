import 'server-only';

import {
  fetchOkxAddressAssetDetails,
  fetchOkxAddressAssetDetailsMulti,
  isSupportedOkxChain,
  type OkxAddressAssetDetail,
} from '@/lib/okx';
import { getDb, type DbHandle } from '@/lib/server/sqlite';
import { batchFetchFromDexScreener } from '@/lib/server/dexscreener';
import {
  validateAndPersistPeakAssetSnapshots,
} from '@/lib/server/assetPeakValidation';
import {
  listMonitoredUsers,
  updateAssetSnapshots,
} from '@/lib/server/trackedUsersRepo';
import type { AddressAssetSnapshot, UserAssetSnapshot } from '@/lib/activityFeed';
import { runGmgnCliAsync } from '@/lib/server/gmgnCli';
import { getGmgnOpenApiClient } from '@/lib/server/gmgnOpenApiClient';
import {
  acquireGmgnHeavyJob,
  isGmgnBanMessage,
  isGmgnRateLimitMessage,
  readGmgnHeavyJobLock,
  releaseGmgnHeavyJob,
} from '@/lib/server/gmgnRateLimit';

const MIN_HOLDING_USD = 5;
const MIN_LIQUIDITY_USD = 5_000;
const DEFAULT_HOLDINGS_REFRESH_INTERVAL_MS = 30 * 60_000;
const SUPPORTED_CHAINS = ['bsc', 'ethereum', 'base', 'solana'] as const;
const EVM_CHAINS = new Set(['bsc', 'ethereum', 'base']);
const ROBINHOOD_CHAIN = 'robinhood' as const;

type SupportedChain = (typeof SUPPORTED_CHAINS)[number];
type HoldingsChain = SupportedChain | typeof ROBINHOOD_CHAIN;
type HoldingsRefreshTarget = HoldingsChain | 'evm';

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
  source?: 'authoritative' | 'xxyy_provisional';
  provisional_updated_at?: number | null;
  authoritative_refreshed_at?: number | null;
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
  provisionalRecords: number;
  pendingVerificationWallets: number;
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

export function shouldDeferHoldingsRefreshForLiveFeed(pendingLiveDoorbells: number) {
  // Full scans merge per-wallet by refreshed_at, so pending live doorbells
  // must not starve OKX-backed holdings forever when GMGN is degraded.
  void pendingLiveDoorbells;
  return false;
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
  /** Inject DexScreener batch (tests / offline). Default: real batchFetchFromDexScreener. */
  batchFetchLiquidity?: typeof batchFetchFromDexScreener;
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
      source TEXT NOT NULL DEFAULT 'authoritative',
      provisional_updated_at INTEGER,
      authoritative_refreshed_at INTEGER,
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
  for (const statement of [
    `ALTER TABLE current_holdings ADD COLUMN source TEXT NOT NULL DEFAULT 'authoritative'`,
    `ALTER TABLE current_holdings ADD COLUMN provisional_updated_at INTEGER`,
    `ALTER TABLE current_holdings ADD COLUMN authoritative_refreshed_at INTEGER`,
  ]) {
    try {
      getDbOrDefault(db).exec(statement);
    } catch {
      // Existing/current schema already has it.
    }
  }
  getDbOrDefault(db).exec(
    `UPDATE current_holdings
     SET authoritative_refreshed_at = refreshed_at
     WHERE authoritative_refreshed_at IS NULL AND source <> 'xxyy_provisional'`
  );
}

function listTrackedAddresses(db: DbHandle) {
  // Only Feishu-enabled addresses (default 1 until first enablement sync).
  return db
    .prepare(`
      SELECT user_id, address, address_lower, chain
      FROM tracked_addresses
      WHERE chain IN (${SUPPORTED_CHAINS.map((chain) => `'${chain}'`).join(',')})
        AND COALESCE(monitoring_enabled, 1) = 1
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
  return /429|rate.?limit|RATE_LIMIT|GMGN_COOLDOWN|GMGN_EGRESS_BANNED|temporarily banned/i.test(message);
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
  try {
    // portfolio holdings = signed 路由，3 倍加权扣令牌防打爆单 IP
    return await runGmgnCliAsync({ args, signal, cost: 3 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/aborted/i.test(msg)) throw new Error('gmgn-cli aborted');
    throw error instanceof Error ? error : new Error(msg);
  }
}

function preferOpenApiHoldings(): boolean {
  const v = (process.env.PILI_GMGN_HOLDINGS_VIA || 'openapi').trim().toLowerCase();
  return v !== 'cli' && v !== 'gmgn-cli';
}

function mapOpenApiHoldingsPayload(raw: unknown): { assets: RobinhoodHoldingAsset[]; next: string } {
  const root = raw as {
    list?: unknown;
    holdings?: unknown;
    next?: unknown;
    data?: { list?: unknown; holdings?: unknown; next?: unknown };
  } | null;
  const rows =
    (root && Array.isArray(root.list) && root.list) ||
    (root && Array.isArray(root.holdings) && root.holdings) ||
    (root && root.data && Array.isArray(root.data.list) && root.data.list) ||
    (root && root.data && Array.isArray(root.data.holdings) && root.data.holdings) ||
    (Array.isArray(raw) ? raw : []);
  if (!Array.isArray(rows)) {
    throw new Error('gmgn openapi wallet_holdings payload is not a list');
  }
  const assets = rows
    .map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      return mapGmgnHolding(row as Record<string, unknown>);
    })
    .filter((row): row is RobinhoodHoldingAsset => Boolean(row));
  const nextRaw = (root && (root.next ?? root.data?.next)) ?? '';
  const next = typeof nextRaw === 'string' ? nextRaw.trim() : '';
  return { assets, next };
}

async function fetchRobinhoodHoldingsWithOpenApi(
  address: string,
  signal?: AbortSignal
): Promise<RobinhoodHoldingsResult> {
  try {
    const client = getGmgnOpenApiClient();
    const assets: RobinhoodHoldingAsset[] = [];
    let cursor: string | undefined;
    // sequential pages; primary key signed, keep concurrency low
    for (;;) {
      ensureNotAborted(signal);
      const raw = await client.walletHoldings({
        chain: 'robinhood',
        wallet: address,
        limit: 50,
        cursor,
        order_by: 'usd_value',
        direction: 'desc',
        hide_closed: true,
        hide_airdrop: false,
      });
      const page = mapOpenApiHoldingsPayload(raw);
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
      rateLimited:
        isRateLimitError(message) ||
        isGmgnBanMessage(message) ||
        isGmgnRateLimitMessage(message) ||
        /RATE_LIMIT|BANNED|429/i.test(message),
    };
  }
}

async function fetchRobinhoodHoldingsWithCliOnly(
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

/**
 * Robinhood holdings: default openapi signed (primary key).
 * Fallback to gmgn-cli on non-ban hard errors. Force cli with PILI_GMGN_HOLDINGS_VIA=cli.
 */
export async function fetchRobinhoodHoldingsWithCli(
  address: string,
  signal?: AbortSignal
): Promise<RobinhoodHoldingsResult> {
  if (!preferOpenApiHoldings()) {
    return fetchRobinhoodHoldingsWithCliOnly(address, signal);
  }
  const openapi = await fetchRobinhoodHoldingsWithOpenApi(address, signal);
  if (openapi.ok) return openapi;
  // ban / rate limit: do not fall back to cli (same quota)
  if (openapi.rateLimited) return openapi;
  console.warn(
    `[holdingsRefresh] openapi holdings failed, fallback cli: ${openapi.error}`
  );
  return fetchRobinhoodHoldingsWithCliOnly(address, signal);
}

/** Last-good bags for one wallet×chain. Used when refresh fails so absence≠sold. */
function readPreviousHoldings(
  db: DbHandle,
  addressLower: string,
  chain: HoldingsChain
): CurrentHoldingRecord[] {
  try {
    return db
      .prepare(
        `SELECT tracked_address, tracked_address_lower, user_id, chain, token_address, token_address_lower,
                symbol, name, balance, price_usd, value_usd, liquidity_usd, source,
                provisional_updated_at, authoritative_refreshed_at, refreshed_at
         FROM current_holdings
         WHERE chain = ? AND tracked_address_lower = ?`
      )
      .all(chain, addressLower) as CurrentHoldingRecord[];
  } catch {
    return [];
  }
}

function insertHoldingsRows(db: DbHandle, holdings: CurrentHoldingRecord[]) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO current_holdings
    (tracked_address, tracked_address_lower, user_id, chain,
     token_address, token_address_lower, symbol, name,
      balance, price_usd, value_usd, liquidity_usd, source,
      provisional_updated_at, authoritative_refreshed_at, refreshed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      holding.source ?? 'authoritative',
      holding.provisional_updated_at ?? null,
      holding.authoritative_refreshed_at ?? holding.refreshed_at,
      holding.refreshed_at
    );
  }
}

function insertWalletStatusRows(db: DbHandle, walletStatuses: CurrentHoldingWalletStatusRecord[]) {
  const insertStatus = db.prepare(`
    INSERT OR REPLACE INTO current_holdings_wallet_status
    (tracked_address, tracked_address_lower, user_id, chain, status, refreshed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
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
}

function replaceCurrentHoldings(
  db: DbHandle,
  holdings: CurrentHoldingRecord[],
  walletStatuses: CurrentHoldingWalletStatusRecord[]
) {
  const holdingsByWallet = new Map<string, CurrentHoldingRecord[]>();
  for (const holding of holdings) {
    const key = `${holding.tracked_address_lower}:${holding.chain}`;
    const rows = holdingsByWallet.get(key);
    if (rows) rows.push(holding);
    else holdingsByWallet.set(key, [holding]);
  }

  const currentSnapshotAt = db.prepare(
    `SELECT MAX(refreshed_at) AS refreshed_at
     FROM (
       SELECT refreshed_at FROM current_holdings
       WHERE tracked_address_lower = ? AND chain = ?
       UNION ALL
       SELECT refreshed_at FROM current_holdings_wallet_status
       WHERE tracked_address_lower = ? AND chain = ?
     )`
  );

  const write = db.transaction(() => {
    for (const status of walletStatuses) {
      const existing = currentSnapshotAt.get(
        status.tracked_address_lower,
        status.chain,
        status.tracked_address_lower,
        status.chain
      ) as { refreshed_at?: number | null } | undefined;
      const existingRefreshedAt = existing?.refreshed_at;

      // Preserve an event snapshot completed after this full-scan wallet. Equal
      // timestamps are this scan's immediate write and may receive liquidity now.
      if (
        typeof existingRefreshedAt === 'number' &&
        existingRefreshedAt > status.refreshed_at
      ) {
        continue;
      }

      const key = `${status.tracked_address_lower}:${status.chain}`;
      db.prepare(
        `DELETE FROM current_holdings
         WHERE tracked_address_lower = ? AND chain = ?`
      ).run(status.tracked_address_lower, status.chain);
      db.prepare(
        `DELETE FROM current_holdings_wallet_status
         WHERE tracked_address_lower = ? AND chain = ?`
      ).run(status.tracked_address_lower, status.chain);
      insertHoldingsRows(db, holdingsByWallet.get(key) ?? []);
      insertWalletStatusRows(db, [status]);
    }
  });

  write();
}

/** Partial write: only replace bags for one wallet×chain. Never touches other wallets. */
function replaceWalletHoldings(
  db: DbHandle,
  addressLower: string,
  chain: HoldingsChain,
  holdings: CurrentHoldingRecord[],
  walletStatus: CurrentHoldingWalletStatusRecord
): boolean {
  const existing = db.prepare(
    `SELECT MAX(refreshed_at) AS refreshed_at
     FROM (
       SELECT refreshed_at FROM current_holdings
       WHERE tracked_address_lower = ? AND chain = ?
       UNION ALL
       SELECT refreshed_at FROM current_holdings_wallet_status
       WHERE tracked_address_lower = ? AND chain = ?
     )`
  ).get(addressLower, chain, addressLower, chain) as { refreshed_at?: number | null } | undefined;
  if (typeof existing?.refreshed_at === 'number' && existing.refreshed_at > walletStatus.refreshed_at) {
    return false;
  }

  const write = db.transaction(() => {
    db.prepare(
      `DELETE FROM current_holdings WHERE tracked_address_lower = ? AND chain = ?`
    ).run(addressLower, chain);
    insertHoldingsRows(db, holdings);
    insertWalletStatusRows(db, [walletStatus]);
  });

  write();
  return true;
}

function normalizeHoldingsChain(chain: string): HoldingsChain | null {
  const normalized = chain.trim().toLowerCase();
  if (normalized === 'sol' || normalized === 'solana') return 'solana';
  if (normalized === 'eth' || normalized === 'ethereum') return 'ethereum';
  if (normalized === 'bsc') return 'bsc';
  if (normalized === 'base') return 'base';
  if (normalized === 'robinhood') return ROBINHOOD_CHAIN;
  return null;
}

function authoritativeHolding(
  address: string,
  addressLower: string,
  userId: string,
  chain: SupportedChain,
  asset: OkxAddressAssetDetail,
  refreshedAt: number,
): CurrentHoldingRecord {
  return {
    tracked_address: address,
    tracked_address_lower: addressLower,
    user_id: userId,
    chain,
    token_address: asset.tokenAddress,
    token_address_lower: chain === 'solana' ? asset.tokenAddress : asset.tokenAddress.toLowerCase(),
    symbol: asset.symbol,
    name: asset.name,
    balance: asset.balance,
    price_usd: asset.priceUsd,
    value_usd: asset.valueUsd,
    liquidity_usd: null,
    source: 'authoritative',
    provisional_updated_at: null,
    authoritative_refreshed_at: refreshedAt,
    refreshed_at: refreshedAt,
  };
}

export interface RefreshWalletHoldingsParams {
  address: string;
  chain: string;
  userId: string;
  db?: DbHandle;
  signal?: AbortSignal;
  now?: () => number;
  fetchAddressAssetDetails?: typeof fetchOkxAddressAssetDetails;
  fetchAddressAssetDetailsMulti?: typeof fetchOkxAddressAssetDetailsMulti;
  fetchRobinhoodHoldings?: (address: string, signal?: AbortSignal) => Promise<RobinhoodHoldingsResult>;
  /** When false, skip tracked_addresses / tracked_users total updates. Default true. */
  updateTotals?: boolean;
  /** When false, skip DexScreener liquidity enrichment. Default true. */
  fetchTokenLiquidity?: boolean;
  batchFetchLiquidity?: typeof batchFetchFromDexScreener;
}

export interface RefreshWalletHoldingsResult {
  status: 'idle' | 'error' | 'missing-credentials' | 'unsupported-chain';
  chain: HoldingsRefreshTarget | null;
  holdingsRowCount: number;
  filteredOutHoldingCount: number;
  totalAssetUsd: number | null;
  lastError: string | null;
  provider?: 'okx' | 'gmgn';
  requestedChainCount?: number;
  upstreamRequestCount?: number;
}

/**
 * Trade-triggered single wallet×chain holdings refresh.
 * Writes only that wallet's rows; preserves last-good bags on fetch failure.
 */
export async function refreshWalletHoldings(
  params: RefreshWalletHoldingsParams
): Promise<RefreshWalletHoldingsResult> {
  const db = getDbOrDefault(params.db);
  const fetchAddressAssetDetails = params.fetchAddressAssetDetails ?? fetchOkxAddressAssetDetails;
  const fetchAddressAssetDetailsMulti =
    params.fetchAddressAssetDetailsMulti ?? fetchOkxAddressAssetDetailsMulti;
  const fetchRobinhoodHoldings = params.fetchRobinhoodHoldings ?? fetchRobinhoodHoldingsWithCli;
  const nowMs = params.now ? params.now() : Date.now();
  const updateTotals = params.updateTotals !== false;
  const shouldFetchLiquidity = params.fetchTokenLiquidity !== false;

  const address = params.address.trim();
  const addressLower = address.toLowerCase();
  const requestedChain = params.chain.trim().toLowerCase();
  const chain: HoldingsRefreshTarget | null =
    requestedChain === 'evm' ? 'evm' : normalizeHoldingsChain(requestedChain);
  const userId = params.userId;

  if (!address || !chain) {
    return {
      status: 'unsupported-chain',
      chain: null,
      holdingsRowCount: 0,
      filteredOutHoldingCount: 0,
      totalAssetUsd: null,
      lastError: `Unsupported chain: ${params.chain}`,
    };
  }

  ensureCurrentHoldingsTable(db);
  ensureNotAborted(params.signal);

  let filteredOutHoldingCount = 0;
  let holdings: CurrentHoldingRecord[] = [];
  let totalAssetUsd: number | null = null;
  let lastError: string | null = null;
  let success = false;

  if (chain === 'evm') {
    if (!hasOkxCredentials() && !params.fetchAddressAssetDetailsMulti) {
      return {
        status: 'missing-credentials',
        chain,
        holdingsRowCount: 0,
        filteredOutHoldingCount: 0,
        totalAssetUsd: null,
        lastError: 'Missing OKX API credentials',
      };
    }
    const evmChains: SupportedChain[] = ['ethereum', 'bsc', 'base'];
    const result = await fetchAddressAssetDetailsMulti(address, evmChains);
    if (!result.ok) {
      for (const targetChain of evmChains) {
        insertWalletStatusRows(db, [{
          tracked_address: address,
          tracked_address_lower: addressLower,
          user_id: userId,
          chain: targetChain,
          status: 'failed',
          refreshed_at: nowMs,
        }]);
      }
      return {
        status: result.configured === false ? 'missing-credentials' : 'error',
        chain,
        holdingsRowCount: 0,
        filteredOutHoldingCount: 0,
        totalAssetUsd: null,
        lastError: result.error,
      };
    }

    let totalRows = 0;
    let totalUsd = 0;
    for (const targetChain of evmChains) {
      const assets = result.assetsByChain[targetChain] ?? [];
      const chainHoldings: CurrentHoldingRecord[] = [];
      for (const asset of assets) {
        totalUsd += asset.valueUsd;
        if (asset.valueUsd < MIN_HOLDING_USD) {
          filteredOutHoldingCount += 1;
          continue;
        }
        chainHoldings.push(authoritativeHolding(address, addressLower, userId, targetChain, asset, nowMs));
      }
      const status: CurrentHoldingWalletStatusRecord = {
        tracked_address: address,
        tracked_address_lower: addressLower,
        user_id: userId,
        chain: targetChain,
        status: 'success',
        refreshed_at: nowMs,
      };
      replaceWalletHoldings(db, addressLower, targetChain, chainHoldings, status);
      totalRows += chainHoldings.length;
      if (updateTotals) {
        const chainTotal = assets.reduce((sum, asset) => sum + asset.valueUsd, 0);
        updateAssetSnapshots(
          [{ userId, address, chain: targetChain, totalAssetUsd: chainTotal, updatedAt: nowMs }],
          [],
        );
      }
    }
    return {
      status: 'idle',
      chain,
      holdingsRowCount: totalRows,
      filteredOutHoldingCount,
      totalAssetUsd: totalUsd,
      lastError: null,
      provider: 'okx',
      requestedChainCount: evmChains.length,
      upstreamRequestCount: 1,
    };
  }

  if (chain === ROBINHOOD_CHAIN) {
    const result = await fetchRobinhoodHoldings(address, params.signal);
    if (!result.ok) {
      lastError = result.error;
      // Preserve last-good bags: only mark status failed.
      const failedStatus: CurrentHoldingWalletStatusRecord = {
        tracked_address: address,
        tracked_address_lower: addressLower,
        user_id: userId,
        chain,
        status: 'failed',
        refreshed_at: nowMs,
      };
      insertWalletStatusRows(db, [failedStatus]);
      return {
        status: 'error',
        chain,
        holdingsRowCount: 0,
        filteredOutHoldingCount: 0,
        totalAssetUsd: null,
        lastError,
      };
    }

    success = true;
    totalAssetUsd = result.assets.reduce((sum, asset) => sum + asset.valueUsd, 0);
    for (const asset of result.assets) {
      if (asset.valueUsd < MIN_HOLDING_USD) {
        filteredOutHoldingCount += 1;
        continue;
      }
      holdings.push({
        tracked_address: address,
        tracked_address_lower: addressLower,
        user_id: userId,
        chain,
        token_address: asset.tokenAddress,
        token_address_lower: asset.tokenAddress.toLowerCase(),
        symbol: asset.symbol,
        name: asset.name,
        balance: asset.balance,
        price_usd: asset.priceUsd,
        value_usd: asset.valueUsd,
        liquidity_usd: asset.liquidityUsd,
        source: 'authoritative',
        provisional_updated_at: null,
        authoritative_refreshed_at: nowMs,
        refreshed_at: nowMs,
      });
    }
  } else {
    if (!isSupportedOkxChain(chain)) {
      return {
        status: 'unsupported-chain',
        chain,
        holdingsRowCount: 0,
        filteredOutHoldingCount: 0,
        totalAssetUsd: null,
        lastError: `Unsupported OKX chain: ${chain}`,
      };
    }
    if (!hasOkxCredentials() && !params.fetchAddressAssetDetails) {
      return {
        status: 'missing-credentials',
        chain,
        holdingsRowCount: 0,
        filteredOutHoldingCount: 0,
        totalAssetUsd: null,
        lastError: 'Missing OKX API credentials',
      };
    }

    const result = await fetchAddressAssetDetails(address, chain);
    if (!result.ok) {
      lastError = result.error;
      const failedStatus: CurrentHoldingWalletStatusRecord = {
        tracked_address: address,
        tracked_address_lower: addressLower,
        user_id: userId,
        chain,
        status: 'failed',
        refreshed_at: nowMs,
      };
      insertWalletStatusRows(db, [failedStatus]);
      return {
        status: result.configured === false ? 'missing-credentials' : 'error',
        chain,
        holdingsRowCount: 0,
        filteredOutHoldingCount: 0,
        totalAssetUsd: null,
        lastError,
      };
    }

    success = true;
    totalAssetUsd = result.assets.reduce((sum, asset) => sum + asset.valueUsd, 0);
    for (const asset of result.assets) {
      if (asset.valueUsd < MIN_HOLDING_USD) {
        filteredOutHoldingCount += 1;
        continue;
      }
      holdings.push({
        tracked_address: address,
        tracked_address_lower: addressLower,
        user_id: userId,
        chain,
        token_address: asset.tokenAddress,
        token_address_lower: chain === 'solana' ? asset.tokenAddress : asset.tokenAddress.toLowerCase(),
        symbol: asset.symbol,
        name: asset.name,
        balance: asset.balance,
        price_usd: asset.priceUsd,
        value_usd: asset.valueUsd,
        liquidity_usd: null,
        source: 'authoritative',
        provisional_updated_at: null,
        authoritative_refreshed_at: nowMs,
        refreshed_at: nowMs,
      });
    }

    if (shouldFetchLiquidity && holdings.length > 0) {
      try {
        const uniqueTokens = holdings.map((h) => ({
          contractAddress: h.token_address,
          chain: h.chain,
        }));
        const fetchLiquidity = params.batchFetchLiquidity ?? batchFetchFromDexScreener;
        const liquidityData = await fetchLiquidity(uniqueTokens);
        for (const h of holdings) {
          const liquidityKey = h.chain === 'solana' ? h.token_address : h.token_address_lower;
          const data = liquidityData.get(liquidityKey);
          if (data) {
            h.liquidity_usd = data.liquidity;
          }
        }
      } catch (err) {
        console.error('[holdingsRefresh] wallet DexScreener liquidity fetch failed:', err);
      }
    }
  }

  if (!success) {
    return {
      status: 'error',
      chain,
      holdingsRowCount: 0,
      filteredOutHoldingCount,
      totalAssetUsd: null,
      lastError: lastError ?? 'Wallet holdings refresh failed',
    };
  }

  const walletStatus: CurrentHoldingWalletStatusRecord = {
    tracked_address: address,
    tracked_address_lower: addressLower,
    user_id: userId,
    chain,
    status: 'success',
    refreshed_at: nowMs,
  };
  replaceWalletHoldings(db, addressLower, chain, holdings, walletStatus);

  // Robinhood is not a tracked_addresses chain — only update totals for OKX chains.
  if (updateTotals && chain !== ROBINHOOD_CHAIN && totalAssetUsd != null) {
    updateAssetSnapshots(
      [
        {
          userId,
          address,
          chain,
          totalAssetUsd,
          updatedAt: nowMs,
        },
      ],
      [
        {
          userId,
          totalValueUsd: totalAssetUsd,
          totalAssetUsd,
          updatedAt: nowMs,
        },
      ]
    );
  }

  return {
    status: 'idle',
    chain,
    holdingsRowCount: holdings.length,
    filteredOutHoldingCount,
    totalAssetUsd,
    lastError: null,
    provider: chain === ROBINHOOD_CHAIN ? 'gmgn' : 'okx',
    requestedChainCount: 1,
    upstreamRequestCount: 1,
  };
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
  const provisionalRecords = (
    handle.prepare(`SELECT COUNT(*) AS c FROM current_holdings WHERE source = 'xxyy_provisional'`).get() as { c: number }
  ).c;
  const hasQueue = Boolean(
    handle.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'holdings_refresh_jobs'`).get()
  );
  const pendingVerificationWallets = hasQueue
    ? (handle.prepare(`SELECT COUNT(*) AS c FROM holdings_refresh_jobs WHERE priority > 0`).get() as { c: number }).c
    : 0;

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
    provisionalRecords,
    pendingVerificationWallets,
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
  // Robinhood holdings are served exclusively by the persistent GMGN queue
  // (holdings-refresh-gmgn runtime task / enqueueHoldingsRefresh). This full
  // scan previously re-read every Robinhood wallet hourly with the same
  // weight-5 signed requests, duplicating the queue — removed 2026-08-13.
  const robinhoodCandidates: TrackedAddressRow[] = [];
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
    // Timestamp this wallet request, not the multi-hour sweep start.
    const walletRefreshAt = options.now ? options.now() : Date.now();

    if (!isSupportedOkxChain(row.chain)) {
      walletStatuses.push({
        tracked_address: row.address,
        tracked_address_lower: row.address_lower,
        user_id: row.user_id,
        chain: row.chain,
        status: 'failed',
        refreshed_at: walletRefreshAt,
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
        refreshed_at: walletRefreshAt,
      });
      summary.failedWalletCount += 1;
      failedUserIds.add(row.user_id);
      lastError = lastError ?? result.error;
      credentialFailure ||= !result.configured;
      // Preserve last-good bags: failed ≠ sold. Only success+missing means zero.
      holdings.push(...readPreviousHoldings(db, row.address_lower, row.chain));
      continue;
    }

    addressAssets.push({
      userId: row.user_id,
      address: row.address,
      chain: row.chain,
      totalAssetUsd: result.assets.reduce((sum, asset) => sum + asset.valueUsd, 0),
      updatedAt: walletRefreshAt,
    });

    walletStatuses.push({
      tracked_address: row.address,
      tracked_address_lower: row.address_lower,
      user_id: row.user_id,
      chain: row.chain,
      status: 'success',
      refreshed_at: walletRefreshAt,
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
        refreshed_at: walletRefreshAt,
      });
    }

    if (!options.dryRun) {
      const walletHoldings = holdings.filter(
        (holding) =>
          holding.tracked_address_lower === row.address_lower &&
          holding.chain === row.chain &&
          holding.refreshed_at === walletRefreshAt
      );
      const walletStatus = walletStatuses[walletStatuses.length - 1]!;
      replaceWalletHoldings(db, row.address_lower, row.chain, walletHoldings, walletStatus);
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
    const fetchLiquidity = options.batchFetchLiquidity ?? batchFetchFromDexScreener;
    const liquidityData = await fetchLiquidity(Array.from(uniqueTokens.values()));
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

  // Fact table keeps all value>=MIN bags (incl. low-liq). Display layers may filter.
  // Still count low-liq for ops visibility; do not drop from current_holdings.
  for (const h of holdings) {
    if (h.liquidity_usd !== null && h.liquidity_usd < MIN_LIQUIDITY_USD) {
      summary.filteredOutHoldingCount += 1;
    }
  }

  summary.holdingsRowCount = holdings.length;

  if (!options.dryRun) {
    replaceCurrentHoldings(db, holdings, walletStatuses);

    const users = listMonitoredUsers().filter((user) => !failedUserIds.has(user.id));
    for (const user of users) {
      completeUserIds.add(user.id);
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
  if (!acquireGmgnHeavyJob('holdings-refresh')) {
    const other = readGmgnHeavyJobLock()?.job;
    return {
      sleepMs: Math.min(getHoldingsRefreshIntervalMs(), 5 * 60_000),
      status: 'idle' as const,
      summary: {
        trackedAddressCount: 0,
        uniqueTrackedAddressCount: 0,
        refreshedWalletCount: 0,
        failedWalletCount: 0,
        holdingsRowCount: 0,
        filteredOutHoldingCount: 0,
        robinhoodWalletCount: 0,
        refreshedAtMs: Date.now(),
      },
      lastError: other
        ? `skipped: heavy job lock held by ${other}`
        : 'skipped: heavy job lock busy',
    };
  }
  try {
    const result = await refreshCurrentHoldings(options);
    return {
      sleepMs: getHoldingsRefreshIntervalMs(),
      status: result.status,
      summary: result.summary,
      lastError: result.lastError,
    };
  } finally {
    releaseGmgnHeavyJob('holdings-refresh');
  }
}
