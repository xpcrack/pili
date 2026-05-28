import { NextRequest, NextResponse } from 'next/server';

import { requireInternalBidAuth } from '@/lib/server/internalBidAuth';
import { listTrackedAddressLastTxAtMap, listTrackedUsers } from '@/lib/server/trackedUsersRepo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseUserIds(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get('userIds') || '';
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function toIsoOrUndefined(value: number | null | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value).toISOString();
}

function normalizeNumber(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export async function GET(request: NextRequest) {
  const unauthorizedResponse = requireInternalBidAuth(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  try {
    const requestedUserIds = new Set(parseUserIds(request));
    const lastTxAtMap = listTrackedAddressLastTxAtMap();

    const users = listTrackedUsers()
      .filter((user) => requestedUserIds.size === 0 || requestedUserIds.has(user.id))
      .map((user) => {
        // Pilipili stores historical_max_asset_usd at the user level (anti-manipulation
        // operates on aggregated USD, not per address). BID's consumer expects a
        // per-address field, so the user-level peak is duplicated onto each address.
        const historicalMaxAssetUsd = normalizeNumber(user.historicalMaxAssetUsd);

        return {
          userId: user.id,
          userName: user.name,
          addresses: user.addresses.map((address) => {
            const addressKey = `${address.chain}|${address.address.toLowerCase()}`;
            const lastTxAt = toIsoOrUndefined(lastTxAtMap.get(addressKey));

            return {
              userId: user.id,
              userName: user.name,
              address: address.address,
              chain: address.chain,
              addressName: address.name,
              // tracked_addresses.total_asset_usd — current USD value of this address.
              totalAssetUsd: normalizeNumber(address.totalAssetUsd),
              // tracked_users.historical_max_asset_usd — peak USD of the owning user
              // (after assetPeakValidation). Duplicated onto each address for the BID
              // consumer; see comment above.
              historicalMaxAssetUsd,
              // tracked_addresses.asset_updated_at — ms epoch when totalAssetUsd was
              // last refreshed. Serialized as ISO 8601 per the BID contract.
              assetUpdatedAt: toIsoOrUndefined(address.assetUpdatedAt),
              // MAX(raw_transactions.tx_time) for this (chain, address). Serialized
              // as ISO 8601. Undefined when no transaction has been ingested yet.
              lastTxAt,
            };
          }),
        };
      });

    return NextResponse.json({
      ok: true,
      users,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : '读取 BID 用户失败',
      },
      { status: 500 }
    );
  }
}
