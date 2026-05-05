import assert from 'node:assert/strict';

import type { AddressAssetSnapshot } from '@/lib/activityFeed';
import type { User } from '@/types';

import {
  countSnapshotsByUserId,
  DETAIL_TOTAL_MISMATCH_MIN_DELTA_USD,
  DETAIL_TOTAL_MISMATCH_RATIO_LIMIT,
  isCompleteAssetSnapshotForUser,
  isDetailTotalMismatch,
  isSuspiciousHistoricalPeak,
  SUSPICIOUS_PEAK_DELTA_USD,
  SUSPICIOUS_PEAK_RATIO_LIMIT,
} from '@/lib/server/assetAnomalyRules';

function createAddressAssetSnapshot(userId: string, address: string): AddressAssetSnapshot {
  return {
    userId,
    address,
    chain: 'solana',
    totalAssetUsd: 100,
    updatedAt: 1_700_000_000_000,
  };
}

function createUser(id: string, addresses: string[]): User {
  return {
    id,
    name: id,
    handle: id,
    avatar: '',
    twitter: undefined,
    telegram: undefined,
    addresses: addresses.map((address, index) => ({
      address,
      name: `#${index + 1}`,
      chain: 'solana',
      totalAssetUsd: null,
      assetUpdatedAt: null,
    })),
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
  };
}

const snapshotCounts = countSnapshotsByUserId([
  createAddressAssetSnapshot('user-1', '71CPXu3TvH3iUKaY1bNkAAow24k6tjH473SsKprQBABC'),
  createAddressAssetSnapshot('user-1', '3qAKQ1c6gawUVNheSBmUVhMgKg7EqT1aHw72ZKmC8Jmk'),
  createAddressAssetSnapshot('user-2', 'HUNUywaDxTV3a8KLwC5cooSeg1hXKcyPnYjvicN6v6ey'),
]);

assert.equal(DETAIL_TOTAL_MISMATCH_RATIO_LIMIT, 2);
assert.equal(DETAIL_TOTAL_MISMATCH_MIN_DELTA_USD, 50_000);
assert.equal(SUSPICIOUS_PEAK_RATIO_LIMIT, 2);
assert.equal(SUSPICIOUS_PEAK_DELTA_USD, 50_000);
assert.equal(isDetailTotalMismatch(5_250_000, 108_222.77), true);
assert.equal(isDetailTotalMismatch(200_000, 180_000), false);
assert.equal(isSuspiciousHistoricalPeak(5_350_000, 195_000), true);
assert.equal(isSuspiciousHistoricalPeak(180_000, 120_000), false);
assert.deepEqual(
  Array.from(snapshotCounts.entries()).sort(([left], [right]) => left.localeCompare(right)),
  [
    ['user-1', 2],
    ['user-2', 1],
  ]
);
assert.equal(
  isCompleteAssetSnapshotForUser(
    createUser('user-1', [
      '71CPXu3TvH3iUKaY1bNkAAow24k6tjH473SsKprQBABC',
      '3qAKQ1c6gawUVNheSBmUVhMgKg7EqT1aHw72ZKmC8Jmk',
    ]),
    snapshotCounts
  ),
  true
);

console.log('asset anomaly rules tests: ok');
