import 'server-only';

import {
  fetchOkxAddressAssetDetails,
  type OkxAddressAssetDetail,
} from '@/lib/okx';
import {
  USER_HOLDINGS_THRESHOLD_USD,
  type UserHoldingRow,
  type UserHoldingsSummary,
} from '@/lib/userDetails';
import type { User } from '@/types';

type FetchAddressAssetDetails = typeof fetchOkxAddressAssetDetails;

export class UserHoldingsDetailsUnavailableError extends Error {}

interface ReadUserHoldingsDetailsOptions {
  fetchAddressAssetDetails?: FetchAddressAssetDetails;
  now?: () => number;
}

interface ReadUserHoldingsDetailsResult {
  holdings: UserHoldingRow[];
  holdingsUpdatedAt: number | null;
  summary: UserHoldingsSummary;
}

function getHoldingMergeKey(asset: Pick<OkxAddressAssetDetail, 'chain' | 'tokenAddress'>) {
  const tokenAddress = asset.chain === 'solana' ? asset.tokenAddress.trim() : asset.tokenAddress.trim().toLowerCase();
  return `${asset.chain}:${tokenAddress}`;
}

function mergeHoldingRows(assets: OkxAddressAssetDetail[]) {
  const merged = new Map<string, UserHoldingRow>();

  for (const asset of assets) {
    const tokenAddress = asset.chain === 'solana' ? asset.tokenAddress.trim() : asset.tokenAddress.trim().toLowerCase();
    const mergeKey = getHoldingMergeKey(asset);
    const existing = merged.get(mergeKey);
    if (!existing) {
      merged.set(mergeKey, {
        chain: asset.chain,
        tokenAddress,
        symbol: asset.symbol,
        name: asset.name,
        balance: asset.balance,
        priceUsd: asset.priceUsd,
        valueUsd: asset.valueUsd,
      });
      continue;
    }

    existing.balance += asset.balance;
    existing.valueUsd += asset.valueUsd;
    existing.priceUsd = existing.balance > 0 ? existing.valueUsd / existing.balance : existing.priceUsd;
    if (!existing.name && asset.name) {
      existing.name = asset.name;
    }
    if (!existing.symbol && asset.symbol) {
      existing.symbol = asset.symbol;
    }
  }

  return Array.from(merged.values())
    .filter((holding) => holding.valueUsd >= USER_HOLDINGS_THRESHOLD_USD)
    .sort(
      (left, right) =>
        right.valueUsd - left.valueUsd ||
        left.chain.localeCompare(right.chain) ||
        left.tokenAddress.localeCompare(right.tokenAddress)
    );
}

export async function readUserHoldingsDetails(
  user: User,
  options: ReadUserHoldingsDetailsOptions = {}
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

  const fetchAddressAssetDetails = options.fetchAddressAssetDetails ?? fetchOkxAddressAssetDetails;
  const now = options.now ?? Date.now;
  const settled = await Promise.all(
    user.addresses.map(async (address) => ({
      address,
      result: await fetchAddressAssetDetails(address.address, address.chain),
    }))
  );

  const successful = settled.filter((item) => item.result.ok);
  const failedCount = settled.length - successful.length;

  if (successful.length === 0) {
    throw new UserHoldingsDetailsUnavailableError('该人物全部地址的 OKX 明细读取失败');
  }

  const merged = mergeHoldingRows(successful.flatMap((item) => item.result.assets));

  return {
    holdings: merged,
    holdingsUpdatedAt: now(),
    summary: {
      visibleCount: merged.length,
      partial: failedCount > 0,
      successfulAddressCount: successful.length,
      failedAddressCount: failedCount,
    },
  };
}
