import 'server-only';

import { collectAddressAssetSnapshots } from '@/lib/addressAssetSnapshots';
import type { AddressAssetSnapshot, UserAssetSnapshot } from '@/lib/activityFeed';
import {
  countSnapshotsByUserId,
  isCompleteAssetSnapshotForUser,
  isSuspiciousHistoricalPeak,
} from '@/lib/server/assetAnomalyRules';
import { getDb, withTransaction } from '@/lib/server/sqlite';
import { listTrackedUsers, updateAssetSnapshots } from '@/lib/server/trackedUsersRepo';
import type { User } from '@/types';

type AssetSnapshotCollection = Awaited<ReturnType<typeof collectAddressAssetSnapshots>>;

export interface RepairedHistoricalPeakUser {
  userId: string;
  userName: string;
  previousHistoricalMaxAssetUsd: number;
  newHistoricalMaxAssetUsd: number;
  previousTotalAssetUsd: number;
  newTotalAssetUsd: number;
}

export interface SkippedHistoricalPeakUser {
  userId: string;
  userName: string;
  reason: 'incomplete_snapshot' | 'missing_current_snapshot' | 'not_suspicious';
}

export interface HistoricalPeakRepairResult {
  repairedUsers: RepairedHistoricalPeakUser[];
  skippedUsers: SkippedHistoricalPeakUser[];
  addressAssets: AddressAssetSnapshot[];
  userAssets: UserAssetSnapshot[];
}

function forceRefreshUsers(users: readonly User[]) {
  return users.map((user) => ({
    ...user,
    addresses: user.addresses.map((address) => ({
      ...address,
      assetUpdatedAt: null,
    })),
  }));
}

export async function repairSuspiciousHistoricalPeaks(params?: {
  users?: User[];
  collectAssetSnapshots?: (users: User[]) => Promise<AssetSnapshotCollection>;
  nowMs?: number;
}) {
  const users = params?.users || listTrackedUsers();
  const nowMs =
    typeof params?.nowMs === 'number' && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  const collectAssetSnapshots =
    params?.collectAssetSnapshots || ((targetUsers: User[]) => collectAddressAssetSnapshots(targetUsers, undefined, { nowMs }));

  const refreshedUsers = forceRefreshUsers(users);
  const snapshots = await collectAssetSnapshots(refreshedUsers);
  const snapshotCounts = countSnapshotsByUserId(snapshots.addressAssets);
  const completeUserIds = new Set(
    users.filter((user) => isCompleteAssetSnapshotForUser(user, snapshotCounts)).map((user) => user.id)
  );

  const completeAddressAssets = snapshots.addressAssets.filter(
    (asset) => asset.userId && completeUserIds.has(asset.userId)
  );
  const completeUserAssets = snapshots.userAssets.filter((asset) => completeUserIds.has(asset.userId));

  updateAssetSnapshots(completeAddressAssets, completeUserAssets);

  const currentTotalByUserId = new Map(completeUserAssets.map((asset) => [asset.userId, asset.totalAssetUsd] as const));
  const repairedUsers: RepairedHistoricalPeakUser[] = [];
  const skippedUsers: SkippedHistoricalPeakUser[] = [];

  withTransaction(() => {
    const db = getDb();
    const repairStmt = db.prepare(
      `UPDATE tracked_users
       SET historical_max_asset_usd = ?, updated_at = ?
       WHERE id = ?`
    );

    for (const user of users) {
      if (!completeUserIds.has(user.id)) {
        skippedUsers.push({
          userId: user.id,
          userName: user.name,
          reason: 'incomplete_snapshot',
        });
        continue;
      }

      const currentTotalAssetUsd = currentTotalByUserId.get(user.id);
      if (typeof currentTotalAssetUsd !== 'number' || !Number.isFinite(currentTotalAssetUsd)) {
        skippedUsers.push({
          userId: user.id,
          userName: user.name,
          reason: 'missing_current_snapshot',
        });
        continue;
      }

      if (!isSuspiciousHistoricalPeak(user.historicalMaxAssetUsd, currentTotalAssetUsd)) {
        skippedUsers.push({
          userId: user.id,
          userName: user.name,
          reason: 'not_suspicious',
        });
        continue;
      }

      repairStmt.run(currentTotalAssetUsd, Date.now(), user.id);
      repairedUsers.push({
        userId: user.id,
        userName: user.name,
        previousHistoricalMaxAssetUsd: user.historicalMaxAssetUsd,
        newHistoricalMaxAssetUsd: currentTotalAssetUsd,
        previousTotalAssetUsd: user.totalAssetUsd,
        newTotalAssetUsd: currentTotalAssetUsd,
      });
    }
  });

  return {
    repairedUsers,
    skippedUsers,
    addressAssets: completeAddressAssets,
    userAssets: completeUserAssets,
  } satisfies HistoricalPeakRepairResult;
}
