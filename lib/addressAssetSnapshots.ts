import { fetchOkxTotalValueByAddress } from '@/lib/okx';
import type { AddressAssetSnapshot, UserAssetSnapshot } from '@/lib/activityFeed';
import type { User } from '@/types';

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

function toFiniteAmount(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export async function collectAddressAssetSnapshots(
  users: User[],
  fetcher: TotalValueFetcher = fetchOkxTotalValueByAddress
) {
  const requests = users.flatMap((user) =>
    user.addresses.map(async (address) => {
      const result = await fetcher(address.address, address.chain);
      return {
        userId: user.id,
        address,
        result,
      };
    })
  );

  const settled = await Promise.all(requests);
  const updatedAt = Date.now();
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
