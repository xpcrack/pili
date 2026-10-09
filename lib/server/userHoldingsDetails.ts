import 'server-only';

import { isEvmAddress } from '@/lib/addressBook';
import {
  USER_HOLDINGS_THRESHOLD_USD,
  type LpLegInfo,
  type UserHoldingRow,
  type UserHoldingsSummary,
} from '@/lib/userDetails';
import { getDb } from '@/lib/server/sqlite';
import type { User } from '@/types';

export class UserHoldingsDetailsUnavailableError extends Error {}

interface ReadUserHoldingsDetailsOptions {
  now?: () => number;
}

interface ReadUserHoldingsDetailsResult {
  holdings: UserHoldingRow[];
  holdingsUpdatedAt: number | null;
  summary: UserHoldingsSummary;
}

interface HoldingsRow {
  tracked_address_lower: string;
  chain: string;
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

interface HoldingsWalletStatusRow {
  tracked_address_lower: string;
  chain: string;
  status: string;
  refreshed_at: number;
}

interface LpPositionRow {
  tracked_address_lower: string;
  token_id: number;
  symbol: string | null;
  name: string | null;
  currency0: string | null;
  currency1: string | null;
  token0_symbol: string | null;
  token1_symbol: string | null;
  fee: number | null;
  tick_lower: number | null;
  tick_upper: number | null;
  full_range: number | null;
  amount0_human: number | null;
  amount1_human: number | null;
  amount0_usd: number | null;
  amount1_usd: number | null;
  total_usd: number | null;
  refreshed_at: number;
}

export async function readUserHoldingsDetails(
  user: User,
  options: ReadUserHoldingsDetailsOptions = {},
): Promise<ReadUserHoldingsDetailsResult> {
  if (user.addresses.length === 0) {
    return {
      holdings: [],
      holdingsUpdatedAt: null,
      summary: {
        visibleCount: 0,
        partial: false,
        successfulAddressCount: 0,
        failedAddressCount: 0,
      },
    };
  }

  const db = getDb();
  try {
    db.exec('ALTER TABLE current_holdings ADD COLUMN liquidity_usd REAL');
  } catch {
    // Column already exists.
  }
  try {
    db.exec(`
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
  } catch {
    // Table already exists.
  }

  const addressConditions = user.addresses.map(() => '(tracked_address_lower = ? AND chain = ?)');
  const params = user.addresses.flatMap((addr) => [addr.address.toLowerCase(), addr.chain]);

  // Robinhood rows are derived per unique EVM address, not stored as address book chains.
  const robinhoodAddresses = new Set(
    user.addresses
      .filter((addr) => isEvmAddress(addr.address) || addr.chain === 'bsc' || addr.chain === 'ethereum' || addr.chain === 'base')
      .map((addr) => addr.address.toLowerCase()),
  );
  for (const addressLower of robinhoodAddresses) {
    addressConditions.push('(tracked_address_lower = ? AND chain = ?)');
    params.push(addressLower, 'robinhood');
  }

  const whereClause = addressConditions.join(' OR ');

  const rows = db
    .prepare(
      `SELECT tracked_address_lower, chain, token_address, token_address_lower, symbol, name,
              balance, price_usd, value_usd, liquidity_usd, refreshed_at
      FROM current_holdings
       WHERE ${whereClause}`,
    )
    .all(...params) as HoldingsRow[];

  // Robinhood-lp 投影行（lpPositionsRefresh 每腿一行，chain='robinhood-lp'）。
  // 直接加进 rows 一起按 (chain, token_address_lower) 合并——它的 token_address
  // 是真实 token 合约，与 OKX/spot 的 robinhood 行同 key 合并后即「直接持有 + LP」总量。
  if (robinhoodAddresses.size > 0) {
    try {
      const lpProjectionRows = db
        .prepare(
          `SELECT tracked_address_lower, chain, token_address, token_address_lower, symbol, name,
                  balance, price_usd, value_usd, liquidity_usd, refreshed_at
           FROM current_holdings
           WHERE chain = 'robinhood-lp'
             AND tracked_address_lower IN (${Array.from(robinhoodAddresses)
               .map(() => '?')
               .join(',')})`,
        )
        .all(...Array.from(robinhoodAddresses)) as HoldingsRow[];
      // 旧版聚合行（token_address='lp:uniswap-v4'）在新投影覆盖前可能残留，排除。
      rows.push(
        ...lpProjectionRows.filter((row) => row.token_address_lower !== 'lp:uniswap-v4'),
      );
    } catch {
      // current_holdings may not exist yet — handled by the rows.length === 0 path.
    }
  }

  // LP 腿明细（hover tooltip 数据源）：从 current_lp_positions 取每条仓的两腿，
  // 后面 attachLpLegs 按 (wallet, token) 挂到合并后的持仓行上。
  const lpQueryRows =
    robinhoodAddresses.size > 0
      ? ((() => {
          try {
            return db
              .prepare(
                `SELECT tracked_address_lower, token_id, symbol, name,
                        currency0, currency1, token0_symbol, token1_symbol,
                        fee, tick_lower, tick_upper, full_range,
                        amount0_human, amount1_human,
                        amount0_usd, amount1_usd, total_usd, refreshed_at
                 FROM current_lp_positions
                 WHERE tracked_address_lower IN (${Array.from(robinhoodAddresses)
                   .map(() => '?')
                   .join(',')})
                   AND COALESCE(total_usd, 0) > 0`,
              )
              .all(...Array.from(robinhoodAddresses)) as LpPositionRow[];
          } catch {
            // current_lp_positions may not exist yet (before first lp-refresh run).
            return [] as LpPositionRow[];
          }
        })())
      : [];

  if (rows.length === 0) {
    // Table may not have been populated yet — fall back to empty
    const maxTs = (
      db.prepare('SELECT MAX(refreshed_at) as ts FROM current_holdings').get() as { ts: number | null }
    ).ts;

    if (lpQueryRows.length === 0 && !maxTs) {
      throw new UserHoldingsDetailsUnavailableError(
        'current_holdings 表无数据，请等待 pili-holdings-refresh cron 运行',
      );
    }

    // 纯 LP 钱包：robinhood-lp 投影行已随 rows 为空而不存在（rows 为空意味着连
    // LP 投影都没查到），此时直接从 current_lp_positions 重建每 token 的 LP 行。
    const lpOnlyHoldings = mergeLpOnlyRows(lpQueryRows);
    return {
      holdings: lpOnlyHoldings,
      holdingsUpdatedAt:
        lpQueryRows.length > 0
          ? lpQueryRows.reduce<number | null>(
              (latest, row) =>
                latest === null ? row.refreshed_at : Math.max(latest, row.refreshed_at),
              null,
            )
          : maxTs,
      summary: {
        visibleCount: lpOnlyHoldings.length,
        partial: false,
        successfulAddressCount: lpQueryRows.length > 0 ? robinhoodAddresses.size : 0,
        failedAddressCount: 0,
      },
    };
  }

  // Merge by (chain, token_address_lower) — same logic as the old mergeHoldingRows.
  // robinhood-lp 行的 key 是真实 token 合约但 chain 不同，按 token 归并到 robinhood
  // 现货行上：balance/valueUsd 累加成「直接持有 + LP」总量（balance 含 LP 数量，
  // 前端 livePrice × balance 才是正确总价），LP 部分单独记在 lpUsd。
  const merged = new Map<string, UserHoldingRow>();
  const successfulAddresses = new Set<string>();

  for (const row of rows) {
    const tokenAddrNorm = (row.chain === 'solana' ? row.token_address : row.token_address_lower).trim();
    const isLpLegRow = row.chain === 'robinhood-lp';
    const mergeKey = `${isLpLegRow ? 'robinhood' : row.chain}:${tokenAddrNorm}`;
    if (!isLpLegRow) successfulAddresses.add(`${row.chain}:${row.tracked_address_lower}`);

    const existing = merged.get(mergeKey);
    if (!existing) {
      merged.set(mergeKey, {
        chain: isLpLegRow ? 'robinhood' : (row.chain as UserHoldingRow['chain']),
        tokenAddress: tokenAddrNorm,
        symbol: row.symbol,
        name: row.name,
        balance: row.balance,
        priceUsd: row.balance > 0 ? row.value_usd / row.balance : 0,
        valueUsd: row.value_usd,
        liquidityUsd: row.liquidity_usd,
        ...(isLpLegRow ? { lpUsd: row.value_usd } : {}),
      });
      continue;
    }

    existing.balance += row.balance;
    existing.valueUsd += row.value_usd;
    if (isLpLegRow) {
      existing.lpUsd = (existing.lpUsd ?? 0) + row.value_usd;
    }
    existing.priceUsd = existing.balance > 0 ? existing.valueUsd / existing.balance : 0;
    if (!existing.name && row.name) existing.name = row.name;
    if (!existing.symbol && row.symbol) existing.symbol = row.symbol;
    if (existing.liquidityUsd == null && row.liquidity_usd != null) existing.liquidityUsd = row.liquidity_usd;
  }

  // Display filter only: fact table may keep low-liq bags for consumers (newone mirror).
  // Robinhood 例外：GMGN 的 RH 代币 liquidity 常为 0（无 DEX 池），不代表死币——
  // 否则整行被丢，$17k 的 RH 持仓在面板上凭空消失（2026-09-12 实测 quq榜 26 行）。
  const MIN_DISPLAY_LIQUIDITY_USD = 5_000;
  const holdings = Array.from(merged.values())
    .filter((h) => h.valueUsd >= USER_HOLDINGS_THRESHOLD_USD)
    .filter(
      (h) =>
        h.liquidityUsd == null ||
        !Number.isFinite(h.liquidityUsd) ||
        // RH: GMGN 报 liquidity=0 = 无 DEX 池数据，不代表死币（9-12 教训）。
        // 但实测尘埃流动性（0<liq<5k，如 4FOUR $0.0003 → $3.59M 幻觉估值）
        // 是死币证据，与其他链一样按 5k 过滤。
        (h.chain === 'robinhood' && h.liquidityUsd === 0) ||
        h.liquidityUsd >= MIN_DISPLAY_LIQUIDITY_USD,
    )
    .sort(
      (a, b) =>
        b.valueUsd - a.valueUsd ||
        a.chain.localeCompare(b.chain) ||
        a.tokenAddress.localeCompare(b.tokenAddress),
    );

  // LP 腿明细挂到对应 token 行（hover tooltip），无腿明细不影响行本身。
  attachLpLegs(holdings, lpQueryRows);

  holdings.sort(
    (a, b) =>
      b.valueUsd - a.valueUsd ||
      a.chain.localeCompare(b.chain) ||
      a.tokenAddress.localeCompare(b.tokenAddress),
  );

  const refreshedAt = rows.reduce<number | null>((latest, row) => {
    if (typeof row.refreshed_at !== 'number') return latest;
    return latest === null ? row.refreshed_at : Math.max(latest, row.refreshed_at);
  }, null);

  // Wallet status counts stay on address-book chains only; Robinhood is additive.
  const statusParams = user.addresses.flatMap((addr) => [addr.address.toLowerCase(), addr.chain]);
  const statusWhere = user.addresses.map(() => '(tracked_address_lower = ? AND chain = ?)').join(' OR ');
  const walletStatusRows =
    statusWhere.length > 0
      ? (db
          .prepare(
            `SELECT tracked_address_lower, chain, status, refreshed_at
             FROM current_holdings_wallet_status
             WHERE ${statusWhere}`,
          )
          .all(...statusParams) as HoldingsWalletStatusRow[])
      : [];

  const robinhoodStatusRows =
    robinhoodAddresses.size > 0
      ? (db
          .prepare(
            `SELECT tracked_address_lower, chain, status, refreshed_at
             FROM current_holdings_wallet_status
             WHERE chain = 'robinhood'
               AND tracked_address_lower IN (${Array.from(robinhoodAddresses)
                 .map(() => '?')
                 .join(',')})`,
          )
          .all(...Array.from(robinhoodAddresses)) as HoldingsWalletStatusRow[])
      : [];

  let successfulAddressCount = successfulAddresses.size;
  let failedAddressCount = Math.max(0, user.addresses.length - successfulAddressCount);

  if (walletStatusRows.length > 0) {
    successfulAddressCount = walletStatusRows.filter((row) => row.status === 'success').length;
    failedAddressCount = walletStatusRows.filter((row) => row.status === 'failed').length;
  } else if (refreshedAt !== null) {
    successfulAddressCount = user.addresses.length;
    failedAddressCount = 0;
  }

  const robinhoodFailed = robinhoodStatusRows.filter((row) => row.status === 'failed').length;
  if (robinhoodFailed > 0) {
    failedAddressCount += robinhoodFailed;
  }

  return {
    holdings,
    holdingsUpdatedAt: refreshedAt,
    summary: {
      visibleCount: holdings.length,
      partial: failedAddressCount > 0,
      successfulAddressCount,
      failedAddressCount,
    },
  };
}

/**
 * Attach per-leg LP details to merged holding rows (hover tooltip data).
 * A leg belongs to the row whose token address matches the leg's currency;
 * both legs of a pool are marked on their own token's row (AI row sees the
 * BONER side as otherSymbol, and vice versa).
 *
 * lpUsd 不在这里累加——robinhood-lp 投影行合并时已计入，这里只补腿明细，
 * 否则同一笔 LP 价值被算两遍。
 */
function attachLpLegs(holdings: UserHoldingRow[], lpRows: LpPositionRow[]) {
  if (lpRows.length === 0) return;
  const byToken = new Map<string, UserHoldingRow>();
  for (const holding of holdings) {
    if (holding.chain !== 'robinhood') continue;
    byToken.set(holding.tokenAddress.toLowerCase(), holding);
  }

  const zeroAddress = '0x0000000000000000000000000000000000000000';
  for (const row of lpRows) {
    const legs = [
      {
        wallet: row.tracked_address_lower,
        tokenAddress: (row.currency0 ?? '').toLowerCase(),
        symbol: row.token0_symbol,
        amountHuman: row.amount0_human,
        legUsd: row.amount0_usd,
        otherSymbol: row.token1_symbol,
      },
      {
        wallet: row.tracked_address_lower,
        tokenAddress: (row.currency1 ?? '').toLowerCase(),
        symbol: row.token1_symbol,
        amountHuman: row.amount1_human,
        legUsd: row.amount1_usd,
        otherSymbol: row.token0_symbol,
      },
    ];
    for (const leg of legs) {
      if (!leg.tokenAddress || leg.tokenAddress === zeroAddress) continue;
      const holding = byToken.get(leg.tokenAddress);
      if (!holding) continue;
      const legInfo: LpLegInfo = {
        poolSymbol: row.symbol ?? '',
        otherSymbol: leg.otherSymbol ?? '',
        feePct: row.fee != null ? row.fee / 10_000 : null,
        tickLower: row.tick_lower,
        tickUpper: row.tick_upper,
        fullRange: row.full_range === 1,
        amountHuman: leg.amountHuman,
        legUsd: leg.legUsd,
      };
      holding.lpLegs = [...(holding.lpLegs ?? []), legInfo];
    }
  }
}

/**
 * 纯 LP 钱包兜底：current_holdings 无任何行（连 OKX/spot 都没刷出来）时，
 * 直接从 current_lp_positions 重建每 (wallet, token) 一行的 LP 持仓，
 * 语义与 projectIntoCurrentHoldings 的投影一致。
 */
function mergeLpOnlyRows(lpRows: LpPositionRow[]): UserHoldingRow[] {
  const merged = new Map<
    string,
    { wallet: string; symbol: string | null; name: string | null; amount: number; usd: number; usdKnown: boolean; legs: LpLegInfo[] }
  >();
  const zeroAddress = '0x0000000000000000000000000000000000000000';
  for (const row of lpRows) {
    const legs = [
      {
        tokenAddress: (row.currency0 ?? '').toLowerCase(),
        symbol: row.token0_symbol,
        amountHuman: row.amount0_human,
        legUsd: row.amount0_usd,
        otherSymbol: row.token1_symbol,
      },
      {
        tokenAddress: (row.currency1 ?? '').toLowerCase(),
        symbol: row.token1_symbol,
        amountHuman: row.amount1_human,
        legUsd: row.amount1_usd,
        otherSymbol: row.token0_symbol,
      },
    ];
    for (const leg of legs) {
      if (!leg.tokenAddress || leg.tokenAddress === zeroAddress) continue;
      if (leg.legUsd == null || !(leg.legUsd >= USER_HOLDINGS_THRESHOLD_USD)) continue;
      const key = `${row.tracked_address_lower}:${leg.tokenAddress}`;
      const entry = merged.get(key) ?? {
        wallet: row.tracked_address_lower,
        symbol: leg.symbol,
        name: row.name,
        amount: 0,
        usd: 0,
        usdKnown: false,
        legs: [],
      };
      entry.amount += leg.amountHuman ?? 0;
      entry.usd += leg.legUsd;
      entry.usdKnown = true;
      entry.symbol = entry.symbol || leg.symbol;
      entry.legs.push({
        poolSymbol: row.symbol ?? '',
        otherSymbol: leg.otherSymbol ?? '',
        feePct: row.fee != null ? row.fee / 10_000 : null,
        tickLower: row.tick_lower,
        tickUpper: row.tick_upper,
        fullRange: row.full_range === 1,
        amountHuman: leg.amountHuman,
        legUsd: leg.legUsd,
      });
      merged.set(key, entry);
    }
  }

  const rows: UserHoldingRow[] = [];
  for (const [key, entry] of merged) {
    if (!entry.usdKnown) continue;
    const [, tokenAddress] = key.split(':');
    rows.push({
      chain: 'robinhood',
      tokenAddress,
      symbol: entry.symbol ?? 'V4-LP',
      name: entry.name,
      balance: entry.amount,
      priceUsd: entry.amount > 0 ? entry.usd / entry.amount : 0,
      valueUsd: entry.usd,
      liquidityUsd: null,
      lpUsd: entry.usd,
      lpLegs: entry.legs,
    });
  }
  return rows;
}
