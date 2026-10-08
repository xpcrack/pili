import 'server-only';

import { batchFetchFromDexScreener, fetchFromDexScreener } from '@/lib/server/dexscreener';
import { getDb, type DbHandle } from '@/lib/server/sqlite';
import {
  fetchRobinhoodTendiesEthUsd,
  fetchRobinhoodV4LpPositions,
  type RobinhoodV4LpPosition,
} from '@/lib/server/robinhoodV4Lp';

/**
 * Live Uniswap V4 LP positions for tracked EVM wallets, persisted into
 * current_lp_positions and projected into current_holdings as kind=lp rows so
 * the holdings page (and downstream consumers) can show LP bags like newone.
 *
 * OKX address assets do not surface V4 LP NFTs — without this, LP positions
 * are invisible on pili (Rop's $490k AI/BONER LP missing = wrong portfolio %).
 */

export const LP_REFRESH_INTERVAL_MS = (() => {
  const configured = Number.parseInt(process.env.PILI_LP_REFRESH_INTERVAL_MS || '', 10);
  return Number.isFinite(configured) && configured >= 5 * 60_000 ? configured : 45 * 60_000;
})();

/** Minimum LP position USD value to persist (mirrors MIN_HOLDING_USD). */
const MIN_LP_POSITION_USD = 5;

export interface LpPositionRow {
  tracked_address_lower: string;
  user_id: string | null;
  token_id: number;
  pool_id: string;
  symbol: string;
  name: string;
  currency0: string;
  currency1: string;
  fee: number;
  tick_lower: number;
  tick_upper: number;
  liquidity: string;
  amount0_human: number;
  amount1_human: number;
  amount0_usd: number | null;
  amount1_usd: number | null;
  total_usd: number | null;
  full_range: number;
  refreshed_at: number;
}

export interface LpRefreshSummary {
  walletCount: number;
  walletsWithLp: number;
  positionCount: number;
  totalUsd: number;
  priceWarnings: number;
  refreshedAtMs: number;
  lastError: string | null;
}

export interface LpRefreshCycleResult {
  status: 'idle' | 'partial' | 'error';
  sleepMs: number;
  summary: LpRefreshSummary;
}

export function ensureLpPositionsTable(db?: DbHandle) {
  getDbOrDefault(db).exec(`
    CREATE TABLE IF NOT EXISTS current_lp_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracked_address_lower TEXT NOT NULL,
      user_id TEXT,
      token_id INTEGER NOT NULL,
      pool_id TEXT NOT NULL,
      symbol TEXT,
      name TEXT,
      currency0 TEXT,
      currency1 TEXT,
      fee INTEGER,
      tick_lower INTEGER,
      tick_upper INTEGER,
      liquidity TEXT,
      amount0_human REAL,
      amount1_human REAL,
      amount0_usd REAL,
      amount1_usd REAL,
      total_usd REAL,
      full_range INTEGER DEFAULT 0,
      refreshed_at INTEGER NOT NULL,
      UNIQUE(tracked_address_lower, token_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lp_positions_user
      ON current_lp_positions(user_id);
    CREATE INDEX IF NOT EXISTS idx_lp_positions_address
      ON current_lp_positions(tracked_address_lower);
  `);
}

function getDbOrDefault(db?: DbHandle) {
  return db ?? getDb();
}

interface TrackedEvmWallet {
  addressLower: string;
  userId: string | null;
}

/** Distinct EVM wallets from tracked_addresses (the same set the holdings page derives robinhood rows from). */
function listTrackedEvmWallets(db: DbHandle): TrackedEvmWallet[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT address_lower, user_id
       FROM tracked_addresses
       WHERE address_lower LIKE '0x%'`,
    )
    .all() as Array<{ address_lower: string; user_id: string | null }>;
  const seen = new Set<string>();
  const wallets: TrackedEvmWallet[] = [];
  for (const row of rows) {
    if (seen.has(row.address_lower)) continue;
    seen.add(row.address_lower);
    wallets.push({ addressLower: row.address_lower, userId: row.user_id ?? null });
  }
  return wallets;
}

/**
 * Resolve USD prices for LP legs via DexScreener.
 *
 * ⚠️ 不用批量端点（/latest/dex/tokens/0xa,0xb,...）：30-pair 响应上限会把
 * 深池币之外的冷门腿整个挤掉（2026-10-08 实测：AI 的 30 个池把 UNICORN
 * 唯一的池挤出响应，LP 腿全 null）。LP 腿 ≤ 每轮几十个，逐 token 查 + 200ms
 * 间隔，单请求响应完整。
 */
async function fetchLegPrices(
  currencies: string[],
  singleFetch: typeof fetchFromDexScreener,
): Promise<{ prices: Record<string, number>; warnings: string[] }> {
  const unique = Array.from(new Set(currencies.map((c) => c.toLowerCase()))).filter(
    (c) => c !== '0x0000000000000000000000000000000000000000',
  );
  const prices: Record<string, number> = {};
  const warnings: string[] = [];
  if (unique.length === 0) return { prices, warnings };

  for (const address of unique) {
    try {
      const data = await singleFetch(address, 'robinhood');
      if (data && data.price > 0) {
        prices[address.toLowerCase()] = data.price;
      }
    } catch (error) {
      warnings.push(`dexscreener leg price ${address.slice(0, 10)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (unique.length > 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return { prices, warnings };
}

/** Apply prices to a position; native ETH legs need an ETH price anchor. */
function pricePosition(
  position: RobinhoodV4LpPosition,
  prices: Record<string, number>,
  ethUsd: number | null,
): RobinhoodV4LpPosition {
  const priced: RobinhoodV4LpPosition = { ...position };
  const resolve = (currency: string, fallback: number | null): number | null => {
    const lower = currency.toLowerCase();
    if (lower === '0x0000000000000000000000000000000000000000') {
      return ethUsd ?? null;
    }
    return prices[lower] ?? fallback ?? null;
  };
  priced.price0Usd = resolve(position.currency0, position.price0Usd);
  priced.price1Usd = resolve(position.currency1, position.price1Usd);
  priced.usd0 = priced.price0Usd != null ? position.amount0Human * priced.price0Usd : null;
  priced.usd1 = priced.price1Usd != null ? position.amount1Human * priced.price1Usd : null;
  priced.totalUsd =
    priced.usd0 != null || priced.usd1 != null ? (priced.usd0 ?? 0) + (priced.usd1 ?? 0) : null;
  return priced;
}

/**
 * Refresh LP positions for all tracked EVM wallets.
 * Sequential per wallet (RPC friendly), balanceOf gate skips LP-less wallets cheaply.
 */
export async function refreshLpPositions(
  options: {
    db?: DbHandle;
    signal?: AbortSignal;
    now?: () => number;
    fetchLpPositions?: typeof fetchRobinhoodV4LpPositions;
    fetchTendiesEthUsd?: typeof fetchRobinhoodTendiesEthUsd;
    /** 注入单币价格查询（测试）。默认 fetchFromDexScreener（逐 token，避开批量端点 30-pair 截断）。 */
    fetchLegPrice?: typeof fetchFromDexScreener;
    wallets?: TrackedEvmWallet[];
  } = {},
): Promise<LpRefreshCycleResult> {
  const db = getDbOrDefault(options.db);
  const now = options.now ?? Date.now;
  const nowMs = now();
  const summary: LpRefreshSummary = {
    walletCount: 0,
    walletsWithLp: 0,
    positionCount: 0,
    totalUsd: 0,
    priceWarnings: 0,
    refreshedAtMs: nowMs,
    lastError: null,
  };

  ensureLpPositionsTable(db);

  const fetchLp = options.fetchLpPositions ?? fetchRobinhoodV4LpPositions;
  const fetchTendies = options.fetchTendiesEthUsd ?? fetchRobinhoodTendiesEthUsd;

  try {
    const wallets = options.wallets ?? listTrackedEvmWallets(db);
    summary.walletCount = wallets.length;

    // Bootstrap TENDIES/ETH anchor once (only needed by wallets holding LP).
    const tendiesEth = await fetchTendies().catch(() => ({ ethUsd: null, tendiesUsd: null }));

    // Single pass: scan every wallet. balance=0 wallets cost one eth_call and
    // return immediately (fetchLp early-returns before the expensive getLogs).
    const scanned: Array<{ wallet: TrackedEvmWallet; positions: RobinhoodV4LpPosition[] }> = [];
    const allLegCurrencies: string[] = [];
    for (const wallet of wallets) {
      if (options.signal?.aborted) break;
      try {
        const result = await fetchLp(wallet.addressLower, {
          ethUsd: tendiesEth.ethUsd,
          tendiesUsd: tendiesEth.tendiesUsd,
          signal: options.signal,
        });
        if (result.positions.length === 0) continue;
        scanned.push({ wallet, positions: result.positions });
        summary.walletsWithLp += 1;
        for (const position of result.positions) {
          allLegCurrencies.push(position.currency0, position.currency1);
        }
        for (const warning of result.warnings) {
          console.warn(`[lp-refresh] ${wallet.addressLower}: ${warning}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summary.lastError = summary.lastError ?? message;
        console.warn(`[lp-refresh] scan failed for ${wallet.addressLower}: ${message}`);
      }
    }

    if (scanned.length > 0 && tendiesEth.ethUsd == null && tendiesEth.tendiesUsd == null) {
      summary.priceWarnings += 1;
    }

    // Leg pricing: DexScreener batch for meme legs. ETH legs already priced by ethUsd anchor.
    const { prices, warnings } = await fetchLegPrices(
      allLegCurrencies,
      options.fetchLegPrice ?? fetchFromDexScreener,
    );
    summary.priceWarnings += warnings.length;
    for (const warning of warnings) {
      console.warn(`[lp-refresh] ${warning}`);
    }

    const rows: LpPositionRow[] = [];
    for (const { wallet, positions } of scanned) {
      for (const position of positions) {
        const priced = pricePosition(position, prices, tendiesEth.ethUsd);
        if (priced.totalUsd != null && priced.totalUsd < MIN_LP_POSITION_USD) continue;
        rows.push({
          tracked_address_lower: wallet.addressLower,
          user_id: wallet.userId,
          token_id: position.tokenId,
          pool_id: position.poolId,
          symbol: `${position.token0Symbol}/${position.token1Symbol}`,
          name: position.name,
          currency0: position.currency0,
          currency1: position.currency1,
          fee: position.fee,
          tick_lower: position.tickLower,
          tick_upper: position.tickUpper,
          liquidity: position.liquidity,
          amount0_human: position.amount0Human,
          amount1_human: position.amount1Human,
          amount0_usd: priced.usd0,
          amount1_usd: priced.usd1,
          total_usd: priced.totalUsd,
          full_range: position.fullRange ? 1 : 0,
          refreshed_at: nowMs,
        });
        summary.totalUsd += priced.totalUsd ?? 0;
      }
    }

    summary.positionCount = rows.length;

    writeLpPositionRows(db, rows, nowMs);
    projectIntoCurrentHoldings(db, rows, nowMs);

    return { status: summary.lastError ? 'partial' : 'idle', sleepMs: LP_REFRESH_INTERVAL_MS, summary };
  } catch (error) {
    summary.lastError = error instanceof Error ? error.message : String(error);
    return { status: 'error', sleepMs: LP_REFRESH_INTERVAL_MS, summary };
  }
}

function writeLpPositionRows(db: DbHandle, rows: LpPositionRow[], refreshedAtMs: number) {
  const staleIds = new Set<string>();
  const existing = db
    .prepare(`SELECT tracked_address_lower, token_id FROM current_lp_positions WHERE refreshed_at < ?`)
    .all(refreshedAtMs) as Array<{ tracked_address_lower: string; token_id: number }>;
  for (const row of existing) staleIds.add(`${row.tracked_address_lower}:${row.token_id}`);
  const writtenIds = new Set(rows.map((row) => `${row.tracked_address_lower}:${row.token_id}`));

  const del = db.prepare(
    `DELETE FROM current_lp_positions WHERE tracked_address_lower = ? AND token_id = ?`,
  );
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO current_lp_positions
    (tracked_address_lower, user_id, token_id, pool_id, symbol, name,
     currency0, currency1, fee, tick_lower, tick_upper, liquidity,
     amount0_human, amount1_human, amount0_usd, amount1_usd, total_usd,
     full_range, refreshed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const write = db.transaction(() => {
    for (const key of staleIds) {
      if (writtenIds.has(key)) continue;
      const [address, tokenId] = key.split(':');
      del.run(address, Number(tokenId));
    }
    for (const row of rows) {
      upsert.run(
        row.tracked_address_lower,
        row.user_id,
        row.token_id,
        row.pool_id,
        row.symbol,
        row.name,
        row.currency0,
        row.currency1,
        row.fee,
        row.tick_lower,
        row.tick_upper,
        row.liquidity,
        row.amount0_human,
        row.amount1_human,
        row.amount0_usd,
        row.amount1_usd,
        row.total_usd,
        row.full_range,
        row.refreshed_at,
      );
    }
  });
  write();
}

/**
 * Project LP rows into current_holdings as one aggregated row per wallet
 * (kind marker via token_address = 'lp:uniswap-v4'), replacing that wallet's
 * previous LP row. wallet×chain key: current_holdings rows for LP use chain='robinhood-lp'
 * so they never collide with OKX token rows.
 */
function projectIntoCurrentHoldings(db: DbHandle, rows: LpPositionRow[], refreshedAtMs: number) {
  if (rows.length === 0) {
    // Still delete stale LP projection rows so closed positions disappear.
    db.prepare(`DELETE FROM current_holdings WHERE chain = 'robinhood-lp' AND refreshed_at < ?`)
      .run(refreshedAtMs);
    return;
  }

  const byWallet = new Map<string, { userId: string | null; totalUsd: number; legs: LpPositionRow[] }>();
  for (const row of rows) {
    const entry = byWallet.get(row.tracked_address_lower) ?? {
      userId: row.user_id,
      totalUsd: 0,
      legs: [],
    };
    entry.totalUsd += row.total_usd ?? 0;
    entry.legs.push(row);
    byWallet.set(row.tracked_address_lower, entry);
  }

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO current_holdings
    (tracked_address, tracked_address_lower, user_id, chain,
     token_address, token_address_lower, symbol, name,
     balance, price_usd, value_usd, liquidity_usd, source,
     provisional_updated_at, authoritative_refreshed_at, refreshed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'lp', NULL, ?, ?)
  `);
  const del = db.prepare(
    `DELETE FROM current_holdings WHERE chain = 'robinhood-lp' AND refreshed_at < ?`,
  );

  const write = db.transaction(() => {
    del.run(refreshedAtMs);
    for (const [addressLower, entry] of byWallet) {
      if (!(entry.totalUsd > 0)) continue;
      const legsDesc = [...entry.legs].sort((a, b) => (b.total_usd ?? 0) - (a.total_usd ?? 0));
      const symbol = legsDesc.map((leg) => leg.symbol).slice(0, 2).join(' + ');
      const name = `Uniswap V4 LP ×${entry.legs.length}`;
      upsert.run(
        addressLower,
        addressLower,
        entry.userId,
        'robinhood-lp',
        'lp:uniswap-v4',
        'lp:uniswap-v4',
        symbol || 'V4-LP',
        name,
        entry.legs.length,
        entry.totalUsd / Math.max(1, entry.legs.length),
        entry.totalUsd,
        null,
        refreshedAtMs,
        refreshedAtMs,
      );
    }
  });
  write();
}
