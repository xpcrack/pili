#!/usr/bin/env tsx

import type { AddressAssetSnapshot, UserAssetSnapshot } from '@/lib/activityFeed';
import { collectAddressAssetSnapshots } from '@/lib/addressAssetSnapshots';
import { inspectUserPeakSnapshot, type BlockedPeakSnapshot } from '@/lib/server/assetPeakValidation';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import type { User } from '@/types';

type AssetSnapshotCollection = Awaited<ReturnType<typeof collectAddressAssetSnapshots>>;

export async function runHistoricalPeakAssetAudit(params?: {
  users?: User[];
  collectAssetSnapshots?: (users: User[]) => Promise<AssetSnapshotCollection>;
  fetchAddressAssetDetails?: Parameters<typeof inspectUserPeakSnapshot>[0]['fetchAddressAssetDetails'];
  fetchTokenLiquidity?: Parameters<typeof inspectUserPeakSnapshot>[0]['fetchTokenLiquidity'];
  log?: (line: string) => void;
}) {
  const log = params?.log || ((line: string) => console.log(line));
  const users = params?.users || listTrackedUsers();
  const collectSnapshots = params?.collectAssetSnapshots || collectAddressAssetSnapshots;
  const { addressAssets, userAssets } = await collectSnapshots(users);
  const userAssetById = new Map(userAssets.map((asset) => [asset.userId, asset] as const));
  const findings: BlockedPeakSnapshot[] = [];

  for (const user of users) {
    const currentSnapshot = userAssetById.get(user.id);
    if (!currentSnapshot) {
      continue;
    }
    if (!(user.historicalMaxAssetUsd > currentSnapshot.totalAssetUsd)) {
      continue;
    }

    const finding = await inspectUserPeakSnapshot({
      user,
      candidateTotalAssetUsd: currentSnapshot.totalAssetUsd,
      previousHistoricalMaxAssetUsd: user.historicalMaxAssetUsd,
      addressAssets: addressAssets.filter((asset) => asset.userId === user.id),
      fetchAddressAssetDetails: params?.fetchAddressAssetDetails,
      fetchTokenLiquidity: params?.fetchTokenLiquidity,
    });

    if (!finding) {
      continue;
    }

    findings.push(finding);
    log(
      [
        `user=${finding.userName}`,
        `userId=${finding.userId}`,
        `storedPeak=${finding.previousHistoricalMaxAssetUsd}`,
        `currentTotal=${finding.candidateTotalAssetUsd}`,
        `status=${finding.status}`,
        `reason=${finding.reason}`,
      ].join(' ')
    );
  }

  if (findings.length === 0) {
    log('no suspicious historical peaks found');
  }

  return {
    findings,
    addressAssets,
    userAssets,
  };
}

if (require.main === module) {
  runHistoricalPeakAssetAudit().catch((error) => {
    console.error('historical asset peak audit failed:', error);
    process.exit(1);
  });
}

export type { AddressAssetSnapshot, UserAssetSnapshot };
