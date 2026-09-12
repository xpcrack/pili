import 'server-only';

import { isEvmAddress } from '@/lib/addressBook';
import {
  USER_HOLDINGS_THRESHOLD_USD,
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

  if (rows.length === 0) {
    // Table may not have been populated yet — fall back to empty
    const maxTs = (
      db.prepare('SELECT MAX(refreshed_at) as ts FROM current_holdings').get() as { ts: number | null }
    ).ts;

    if (!maxTs) {
      throw new UserHoldingsDetailsUnavailableError(
        'current_holdings 表无数据，请等待 pili-holdings-refresh cron 运行',
      );
    }

    return {
      holdings: [],
      holdingsUpdatedAt: maxTs,
      summary: {
        visibleCount: 0,
        partial: false,
        successfulAddressCount: 0,
        failedAddressCount: 0,
      },
    };
  }

  // Merge by (chain, token_address_lower) — same logic as the old mergeHoldingRows
  const merged = new Map<string, UserHoldingRow>();
  const successfulAddresses = new Set<string>();

  for (const row of rows) {
    const tokenAddrNorm = (row.chain === 'solana' ? row.token_address : row.token_address_lower).trim();
    const mergeKey = `${row.chain}:${tokenAddrNorm}`;

    successfulAddresses.add(`${row.chain}:${row.tracked_address_lower}`);

    const existing = merged.get(mergeKey);
    if (!existing) {
      merged.set(mergeKey, {
        chain: row.chain as UserHoldingRow['chain'],
        tokenAddress: tokenAddrNorm,
        symbol: row.symbol,
        name: row.name,
        balance: row.balance,
        priceUsd: row.balance > 0 ? row.value_usd / row.balance : 0,
        valueUsd: row.value_usd,
         liquidityUsd: row.liquidity_usd,
      });
      continue;
    }

    existing.balance += row.balance;
    existing.valueUsd += row.value_usd;
    existing.priceUsd =
      existing.balance > 0 ? existing.valueUsd / existing.balance : 0;
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
        h.chain === 'robinhood' ||
        h.liquidityUsd == null ||
        !Number.isFinite(h.liquidityUsd) ||
        h.liquidityUsd >= MIN_DISPLAY_LIQUIDITY_USD,
    )
    .sort(
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
