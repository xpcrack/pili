import type { AddressAssetSnapshot } from '@/lib/activityFeed';
import type { User } from '@/types';

export const LIQUIDITY_RATIO_LIMIT = 0.5;
export const DETAIL_TOTAL_MISMATCH_RATIO_LIMIT = 2;
export const DETAIL_TOTAL_MISMATCH_MIN_DELTA_USD = 50_000;
export const SUSPICIOUS_PEAK_RATIO_LIMIT = 2;
export const SUSPICIOUS_PEAK_DELTA_USD = 50_000;

export function isDetailTotalMismatch(
  candidateTotalAssetUsd: number,
  detailTotalAssetUsd: number
) {
  if (!(candidateTotalAssetUsd > 0) || !(detailTotalAssetUsd > 0)) {
    return false;
  }

  const larger = Math.max(candidateTotalAssetUsd, detailTotalAssetUsd);
  const smaller = Math.min(candidateTotalAssetUsd, detailTotalAssetUsd);
  const ratio = larger / smaller;
  const deltaUsd = Math.abs(candidateTotalAssetUsd - detailTotalAssetUsd);

  return ratio >= DETAIL_TOTAL_MISMATCH_RATIO_LIMIT && deltaUsd >= DETAIL_TOTAL_MISMATCH_MIN_DELTA_USD;
}

export function isSuspiciousHistoricalPeak(
  historicalMaxAssetUsd: number,
  currentTotalAssetUsd: number,
  suspiciousPeakRatio = SUSPICIOUS_PEAK_RATIO_LIMIT,
  suspiciousPeakDeltaUsd = SUSPICIOUS_PEAK_DELTA_USD
) {
  if (!(historicalMaxAssetUsd > currentTotalAssetUsd) || !(currentTotalAssetUsd > 0)) {
    return false;
  }

  const ratio = historicalMaxAssetUsd / currentTotalAssetUsd;
  const deltaUsd = historicalMaxAssetUsd - currentTotalAssetUsd;
  return ratio >= suspiciousPeakRatio && deltaUsd >= suspiciousPeakDeltaUsd;
}

export function countSnapshotsByUserId(addressAssets: readonly AddressAssetSnapshot[]) {
  const counts = new Map<string, number>();

  for (const asset of addressAssets) {
    if (!asset.userId) {
      continue;
    }
    counts.set(asset.userId, (counts.get(asset.userId) || 0) + 1);
  }

  return counts;
}

export function isCompleteAssetSnapshotForUser(
  user: Pick<User, 'id' | 'addresses'>,
  snapshotCounts: ReadonlyMap<string, number>
) {
  return (snapshotCounts.get(user.id) || 0) === user.addresses.length;
}
