import { fetchOkxTotalValueByAddress } from '@/lib/okx';
import type { AddressAssetSnapshot, UserAssetSnapshot } from '@/lib/activityFeed';
import type { User } from '@/types';

const ASSET_REFRESH_INTERVAL_WITH_BALANCE_MS = 2 * 60 * 60 * 1000;
const ASSET_REFRESH_INTERVAL_EMPTY_MS = 3 * 24 * 60 * 60 * 1000;

interface TotalValueResult {
  ok: boolean;
  configured: boolean;
  totalAssetUsd: number | null;
  error: string | null;
}

type TotalValueFetcher = (
  address: string,
  chain: string
) => Promise<TotalValueResult>;

interface CollectAddressAssetSnapshotsOptions {
  nowMs?: number;
}

function toFiniteAmount(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function shouldRefreshAddressAsset(address: User['addresses'][number], nowMs: number) {
  if (typeof address.assetUpdatedAt !== 'number' || !Number.isFinite(address.assetUpdatedAt)) {
    return true;
  }

  const ageMs = nowMs - address.assetUpdatedAt;
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return true;
  }

  const intervalMs =
    typeof address.totalAssetUsd === 'number' && address.totalAssetUsd > 0
      ? ASSET_REFRESH_INTERVAL_WITH_BALANCE_MS
      : ASSET_REFRESH_INTERVAL_EMPTY_MS;

  return ageMs >= intervalMs;
}

export async function collectAddressAssetSnapshots(
  users: User[],
  fetcher: TotalValueFetcher = fetchOkxTotalValueByAddress,
  options?: CollectAddressAssetSnapshotsOptions
) {
  const nowMs =
    typeof options?.nowMs === 'number' && Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const requests = users.flatMap((user) =>
    user.addresses.flatMap((address) => {
      if (!shouldRefreshAddressAsset(address, nowMs)) {
        return [];
      }

      return [async () => {
        const result = await fetcher(address.address, address.chain);
        return {
          userId: user.id,
          address,
          result,
        };
      }];
    })
  );

  const settled = await Promise.all(requests.map((request) => request()));
  const updatedAt = nowMs;
  const addressAssets: AddressAssetSnapshot[] = [];
  const totalsByUserId = new Map<string, number>();

  for (const item of settled) {
    const totalAssetUsd = toFiniteAmount(item.result.totalAssetUsd);
    if (!item.result.ok || totalAssetUsd === null) {
      continue;
    }

    addressAssets.push({
      userId: item.userId,
      address: item.address.address,
      chain: item.address.chain,
      token: '',
      tokenAddress: '',
      balance: '',
      valueUsd: totalAssetUsd,
      totalAssetUsd,
      updatedAt,
    });

    totalsByUserId.set(item.userId, (totalsByUserId.get(item.userId) || 0) + totalAssetUsd);
  }

  const userAssets: UserAssetSnapshot[] = Array.from(totalsByUserId.entries()).map(([userId, totalAssetUsd]) => ({
    userId,
    totalValueUsd: totalAssetUsd,
    totalAssetUsd,
    updatedAt,
  }));

  return {
    addressAssets,
    userAssets,
  };
}
