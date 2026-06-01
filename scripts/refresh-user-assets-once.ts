import './server-only-shim.cjs';

import { collectAddressAssetSnapshots } from '@/lib/addressAssetSnapshots';
import { listTrackedUsers, updateAssetSnapshots } from '@/lib/server/trackedUsersRepo';

function normalize(value: string | undefined | null) {
  return (value || '').trim().toLowerCase();
}

async function run() {
  const keyword = normalize(process.argv[2] || 'finn');
  const users = listTrackedUsers();
  const target = users.find((user) => {
    return (
      normalize(user.name) === keyword ||
      normalize(user.handle) === keyword ||
      normalize(user.twitter) === keyword
    );
  });

  if (!target) {
    throw new Error(`user not found: ${keyword}`);
  }

  const forced = {
    ...target,
    addresses: target.addresses.map((address) => ({
      ...address,
      assetUpdatedAt: null,
    })),
  };

  const snapshots = await collectAddressAssetSnapshots([forced]);
  updateAssetSnapshots(snapshots.addressAssets, snapshots.userAssets);

  const refreshed = listTrackedUsers().find((item) => item.id === target.id);
  if (!refreshed) {
    throw new Error('user disappeared after refresh');
  }

  console.log(
    JSON.stringify(
      {
        userId: refreshed.id,
        name: refreshed.name,
        totalAssetUsd: refreshed.totalAssetUsd,
        assetUpdatedAt: refreshed.assetUpdatedAt,
        addresses: refreshed.addresses.map((address) => ({
          chain: address.chain,
          address: address.address,
          totalAssetUsd: address.totalAssetUsd,
          assetUpdatedAt: address.assetUpdatedAt,
        })),
      },
      null,
      2
    )
  );
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
