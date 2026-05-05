import 'server-only';

import type {
  AddressAssetSnapshot,
  AddressDiagnostic,
  UserAssetSnapshot,
} from '@/lib/activityFeed';
import {
  validateAndPersistPeakAssetSnapshots as defaultValidateAndPersistPeakAssetSnapshots,
  type BlockedPeakSnapshot,
} from '@/lib/server/assetPeakValidation';
import { markAddressesSynced as defaultMarkAddressesSynced } from '@/lib/server/trackedUsersRepo';
import type { User } from '@/types';

type ValidateAndPersistPeakAssetSnapshots = typeof defaultValidateAndPersistPeakAssetSnapshots;
type MarkAddressesSynced = typeof defaultMarkAddressesSynced;
type SyncedCursor = Parameters<MarkAddressesSynced>[0][number];

export interface RunAssetSyncPipelineParams {
  users: User[];
  addressAssets: AddressAssetSnapshot[];
  userAssets: UserAssetSnapshot[];
  diagnostics: AddressDiagnostic[];
  syncedAt: number;
  validateAndPersistPeakAssetSnapshots?: ValidateAndPersistPeakAssetSnapshots;
  markAddressesSynced?: MarkAddressesSynced;
}

export interface AssetSyncPipelineResult {
  blockedUsers: BlockedPeakSnapshot[];
  persistedAddressAssets: AddressAssetSnapshot[];
  persistedUserAssets: UserAssetSnapshot[];
  syncedCursors: SyncedCursor[];
}

export async function runAssetSyncPipeline(
  params: RunAssetSyncPipelineParams
): Promise<AssetSyncPipelineResult> {
  const validateAndPersist =
    params.validateAndPersistPeakAssetSnapshots ?? defaultValidateAndPersistPeakAssetSnapshots;
  const markSynced = params.markAddressesSynced ?? defaultMarkAddressesSynced;

  const validation = await validateAndPersist({
    users: params.users,
    addressAssets: params.addressAssets,
    userAssets: params.userAssets,
  });

  const syncedCursors = params.diagnostics
    .filter((item) => item.ok)
    .map(
      (item): SyncedCursor => ({
        chain: item.chain,
        address: item.address,
        syncedAt: params.syncedAt,
      })
    );

  markSynced(syncedCursors);

  return {
    blockedUsers: validation.blockedUsers,
    persistedAddressAssets: validation.addressAssets,
    persistedUserAssets: validation.userAssets,
    syncedCursors,
  };
}
