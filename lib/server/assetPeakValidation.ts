import 'server-only';

import type { AddressAssetSnapshot, UserAssetSnapshot } from '@/lib/activityFeed';
import {
  fetchOkxAddressAssetDetails,
  type OkxAddressAssetDetail,
} from '@/lib/okx';
import { fetchDexscreenerTokenInfo } from '@/lib/tokenLogo';
import { getDb, withTransaction } from '@/lib/server/sqlite';
import { updateAssetSnapshots } from '@/lib/server/trackedUsersRepo';
import type { ChainType, User } from '@/types';

const TOP_HOLDINGS_LIMIT = 5;
const LIQUIDITY_RATIO_LIMIT = 0.5;
const DETAIL_TOTAL_MISMATCH_RATIO_LIMIT = 2;
const DETAIL_TOTAL_MISMATCH_MIN_DELTA_USD = 50_000;

type FetchAddressAssetDetails = typeof fetchOkxAddressAssetDetails;
type FetchTokenLiquidity = (
  chain: ChainType,
  tokenAddress: string
) => Promise<{ liquidityUsd: number | null } | null>;

export interface PeakValidationHolding extends OkxAddressAssetDetail {
  addresses: string[];
  liquidityUsd: number | null;
  liquidityRatio: number | null;
}

export interface BlockedPeakSnapshot {
  userId: string;
  userName: string;
  candidateTotalAssetUsd: number;
  previousHistoricalMaxAssetUsd: number;
  status: 'missing_liquidity' | 'liquidity_ratio_exceeded' | 'detail_total_mismatch';
  reason: string;
  topHoldings: PeakValidationHolding[];
}

export interface PeakValidationResult {
  addressAssets: AddressAssetSnapshot[];
  userAssets: UserAssetSnapshot[];
  blockedUsers: BlockedPeakSnapshot[];
}

interface InspectUserPeakSnapshotParams {
  user: User;
  candidateTotalAssetUsd: number;
  previousHistoricalMaxAssetUsd: number;
  addressAssets: AddressAssetSnapshot[];
  fetchAddressAssetDetails?: FetchAddressAssetDetails;
  fetchTokenLiquidity?: FetchTokenLiquidity;
}

function normalizeAddressKey(chain: ChainType, address: string) {
  const trimmed = address.trim();
  return chain === 'solana' ? trimmed : trimmed.toLowerCase();
}

function sanitizeLiquidity(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function defaultFetchTokenLiquidity(chain: ChainType, tokenAddress: string) {
  return fetchDexscreenerTokenInfo(chain, tokenAddress).then((result) => ({
    liquidityUsd: sanitizeLiquidity(result?.liquidityUsd ?? null),
  }));
}

function buildTopHoldingsSnapshot(holdings: PeakValidationHolding[]) {
  return holdings.map((holding) => ({
    assetKey: holding.assetKey,
    chain: holding.chain,
    tokenAddress: holding.tokenAddress,
    symbol: holding.symbol,
    name: holding.name,
    addresses: holding.addresses,
    balance: holding.balance,
    priceUsd: holding.priceUsd,
    valueUsd: holding.valueUsd,
    liquidityUsd: holding.liquidityUsd,
    liquidityRatio: holding.liquidityRatio,
  }));
}

function isDetailTotalMismatch(candidateTotalAssetUsd: number, detailTotalAssetUsd: number) {
  if (!(candidateTotalAssetUsd > 0) || !(detailTotalAssetUsd > 0)) {
    return false;
  }

  const larger = Math.max(candidateTotalAssetUsd, detailTotalAssetUsd);
  const smaller = Math.min(candidateTotalAssetUsd, detailTotalAssetUsd);
  const ratio = larger / smaller;
  const deltaUsd = Math.abs(candidateTotalAssetUsd - detailTotalAssetUsd);

  return ratio >= DETAIL_TOTAL_MISMATCH_RATIO_LIMIT && deltaUsd >= DETAIL_TOTAL_MISMATCH_MIN_DELTA_USD;
}

function writeBlockedPeakAuditRows(rows: BlockedPeakSnapshot[]) {
  if (rows.length === 0) {
    return;
  }

  withTransaction(() => {
    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO asset_peak_validation_blocks (
        user_id,
        candidate_total_asset_usd,
        previous_historical_max_asset_usd,
        block_status,
        reason_text,
        top_holdings_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    for (const row of rows) {
      stmt.run(
        row.userId,
        row.candidateTotalAssetUsd,
        row.previousHistoricalMaxAssetUsd,
        row.status,
        row.reason,
        JSON.stringify(buildTopHoldingsSnapshot(row.topHoldings)),
        Date.now()
      );
    }
  });
}

export function mergePersonLevelAssetHoldings(assets: OkxAddressAssetDetail[]) {
  const merged = new Map<string, PeakValidationHolding>();

  for (const asset of assets) {
    const existing = merged.get(asset.assetKey);
    if (!existing) {
      merged.set(asset.assetKey, {
        ...asset,
        addresses: [asset.address],
        liquidityUsd: null,
        liquidityRatio: null,
      });
      continue;
    }

    existing.balance += asset.balance;
    existing.valueUsd += asset.valueUsd;
    existing.priceUsd = existing.balance > 0 ? existing.valueUsd / existing.balance : existing.priceUsd;
    if (!existing.name && asset.name) {
      existing.name = asset.name;
    }
    if (!existing.addresses.includes(asset.address)) {
      existing.addresses.push(asset.address);
    }
  }

  return Array.from(merged.values()).sort(
    (left, right) => right.valueUsd - left.valueUsd || left.assetKey.localeCompare(right.assetKey)
  );
}

export async function inspectUserPeakSnapshot(params: InspectUserPeakSnapshotParams) {
  const fetchAddressAssetDetails = params.fetchAddressAssetDetails || fetchOkxAddressAssetDetails;
  const fetchTokenLiquidity = params.fetchTokenLiquidity || defaultFetchTokenLiquidity;
  const candidateAddresses = params.user.addresses.filter(
    (address) => typeof address.address === 'string' && address.address.trim().length > 0
  );

  if (candidateAddresses.length === 0) {
    return {
      userId: params.user.id,
      userName: params.user.name,
      candidateTotalAssetUsd: params.candidateTotalAssetUsd,
      previousHistoricalMaxAssetUsd: params.previousHistoricalMaxAssetUsd,
      status: 'missing_liquidity' as const,
      reason: 'candidate snapshot has no address assets to validate',
      topHoldings: [],
    };
  }

  const detailsByAddress = await Promise.all(
    candidateAddresses.map(async (address) => ({
      address,
      detail: await fetchAddressAssetDetails(address.address, address.chain as ChainType),
    }))
  );

  const failedDetail = detailsByAddress.find((item) => !item.detail.ok);
  if (failedDetail) {
    return {
      userId: params.user.id,
      userName: params.user.name,
      candidateTotalAssetUsd: params.candidateTotalAssetUsd,
      previousHistoricalMaxAssetUsd: params.previousHistoricalMaxAssetUsd,
      status: 'missing_liquidity' as const,
      reason: `failed to fetch asset details for ${failedDetail.address.chain}:${failedDetail.address.address}`,
      topHoldings: [],
    };
  }

  const mergedHoldings = mergePersonLevelAssetHoldings(
    detailsByAddress.flatMap((item) =>
      item.detail.assets.map((detail) => ({
        ...detail,
        userId: params.user.id,
        address: item.address.address,
      }))
    )
  );

  const detailTotalAssetUsd = mergedHoldings.reduce((sum, holding) => sum + holding.valueUsd, 0);
  if (isDetailTotalMismatch(params.candidateTotalAssetUsd, detailTotalAssetUsd)) {
    return {
      userId: params.user.id,
      userName: params.user.name,
      candidateTotalAssetUsd: params.candidateTotalAssetUsd,
      previousHistoricalMaxAssetUsd: params.previousHistoricalMaxAssetUsd,
      status: 'detail_total_mismatch' as const,
      reason: `candidate/detail total mismatch: candidate=${params.candidateTotalAssetUsd.toFixed(2)} detail=${detailTotalAssetUsd.toFixed(2)}`,
      topHoldings: mergedHoldings.slice(0, TOP_HOLDINGS_LIMIT),
    };
  }

  const topHoldings = mergedHoldings.slice(0, TOP_HOLDINGS_LIMIT);

  if (topHoldings.length === 0) {
    return {
      userId: params.user.id,
      userName: params.user.name,
      candidateTotalAssetUsd: params.candidateTotalAssetUsd,
      previousHistoricalMaxAssetUsd: params.previousHistoricalMaxAssetUsd,
      status: 'missing_liquidity' as const,
      reason: 'candidate snapshot has no token holdings to validate',
      topHoldings: [],
    };
  }

  const liquidityCache = new Map<string, number | null>();
  const topHoldingsWithLiquidity = await Promise.all(
    topHoldings.map(async (holding) => {
      const cacheKey = `${holding.chain}:${normalizeAddressKey(holding.chain, holding.tokenAddress)}`;
      let liquidityUsd: number | null;
      if (liquidityCache.has(cacheKey)) {
        liquidityUsd = liquidityCache.get(cacheKey) ?? null;
      } else {
        const liquidity = await fetchTokenLiquidity(holding.chain, holding.tokenAddress);
        liquidityUsd = sanitizeLiquidity(liquidity?.liquidityUsd ?? null);
        liquidityCache.set(cacheKey, liquidityUsd);
      }

      const liquidityRatio = liquidityUsd ? holding.valueUsd / liquidityUsd : null;
      return {
        ...holding,
        liquidityUsd,
        liquidityRatio,
      };
    })
  );

  const missingLiquidityHolding = topHoldingsWithLiquidity.find((holding) => holding.liquidityUsd === null);
  if (missingLiquidityHolding) {
    return {
      userId: params.user.id,
      userName: params.user.name,
      candidateTotalAssetUsd: params.candidateTotalAssetUsd,
      previousHistoricalMaxAssetUsd: params.previousHistoricalMaxAssetUsd,
      status: 'missing_liquidity' as const,
      reason: `missing liquidity for ${missingLiquidityHolding.chain}:${missingLiquidityHolding.tokenAddress}`,
      topHoldings: topHoldingsWithLiquidity,
    };
  }

  const liquidityExceededHolding = topHoldingsWithLiquidity.find(
    (holding) => holding.liquidityRatio !== null && holding.liquidityRatio > LIQUIDITY_RATIO_LIMIT
  );
  if (liquidityExceededHolding) {
    return {
      userId: params.user.id,
      userName: params.user.name,
      candidateTotalAssetUsd: params.candidateTotalAssetUsd,
      previousHistoricalMaxAssetUsd: params.previousHistoricalMaxAssetUsd,
      status: 'liquidity_ratio_exceeded' as const,
      reason: `${liquidityExceededHolding.symbol} position/liquidity ratio ${liquidityExceededHolding.liquidityRatio?.toFixed(2)} > ${LIQUIDITY_RATIO_LIMIT.toFixed(2)}`,
      topHoldings: topHoldingsWithLiquidity,
    };
  }

  return null;
}

export async function validatePeakAssetSnapshots(params: {
  users: User[];
  addressAssets: AddressAssetSnapshot[];
  userAssets: UserAssetSnapshot[];
  fetchAddressAssetDetails?: FetchAddressAssetDetails;
  fetchTokenLiquidity?: FetchTokenLiquidity;
}) {
  const userById = new Map(params.users.map((user) => [user.id, user] as const));
  const blockedUsers: BlockedPeakSnapshot[] = [];
  const blockedUserIds = new Set<string>();

  for (const snapshot of params.userAssets) {
    const user = userById.get(snapshot.userId);
    if (!user) {
      continue;
    }
    if (!(snapshot.totalAssetUsd > user.historicalMaxAssetUsd)) {
      continue;
    }

    const blocked = await inspectUserPeakSnapshot({
      user,
      candidateTotalAssetUsd: snapshot.totalAssetUsd,
      previousHistoricalMaxAssetUsd: user.historicalMaxAssetUsd,
      addressAssets: params.addressAssets,
      fetchAddressAssetDetails: params.fetchAddressAssetDetails,
      fetchTokenLiquidity: params.fetchTokenLiquidity,
    });

    if (blocked) {
      blockedUsers.push(blocked);
      blockedUserIds.add(user.id);
    }
  }

  return {
    addressAssets: params.addressAssets.filter((snapshot) => !snapshot.userId || !blockedUserIds.has(snapshot.userId)),
    userAssets: params.userAssets.filter((snapshot) => !blockedUserIds.has(snapshot.userId)),
    blockedUsers,
  } satisfies PeakValidationResult;
}

export async function validateAndPersistPeakAssetSnapshots(params: {
  users: User[];
  addressAssets: AddressAssetSnapshot[];
  userAssets: UserAssetSnapshot[];
  fetchAddressAssetDetails?: FetchAddressAssetDetails;
  fetchTokenLiquidity?: FetchTokenLiquidity;
}) {
  const validation = await validatePeakAssetSnapshots(params);

  writeBlockedPeakAuditRows(validation.blockedUsers);
  updateAssetSnapshots(validation.addressAssets, validation.userAssets);

  return validation;
}
