import 'server-only';

import {
  USER_HOLDINGS_THRESHOLD_USD,
  type UserHoldingRow,
  type UserHoldingsSummary,
} from '@/lib/userDetails';
import { getDb } from '@/lib/server/sqlite';
import type { User } from '@/types';

export class UserHoldingsDetailsUnavailableError extends Error {}

interface ReadUserHoldingsDetailsOptions {
  /** @deprecated No longer used — holdings now read from current_holdings table. */
  fetchAddressAssetDetails?: unknown;
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

  const addressConditions = user.addresses.map(() => '(tracked_address_lower = ? AND chain = ?)');
  const whereClause = addressConditions.join(' OR ');
  const params = user.addresses.flatMap((addr) => [addr.address.toLowerCase(), addr.chain]);

  const rows = db
    .prepare(
      `SELECT tracked_address_lower, chain, token_address, token_address_lower, symbol, name,
              balance, price_usd, value_usd, refreshed_at
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
      });
      continue;
    }

    existing.balance += row.balance;
    existing.valueUsd += row.value_usd;
    existing.priceUsd =
      existing.balance > 0 ? existing.valueUsd / existing.balance : 0;
    if (!existing.name && row.name) existing.name = row.name;
    if (!existing.symbol && row.symbol) existing.symbol = row.symbol;
  }

  const holdings = Array.from(merged.values())
    .filter((h) => h.valueUsd >= USER_HOLDINGS_THRESHOLD_USD)
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
  const successfulAddressCount = successfulAddresses.size;
  const failedAddressCount = Math.max(0, user.addresses.length - successfulAddressCount);

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
