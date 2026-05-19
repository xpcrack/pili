import 'server-only';

import { expandTrackedAddresses } from '@/lib/addressBook';
import { buildAddressManagementRows } from '@/lib/addressManagement';
import { getDb } from '@/lib/server/sqlite';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import type { User } from '@/types';

function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

function buildChainAddressKey(chain: string, address: string) {
  return `${normalize(chain)}:${normalize(address)}`;
}

function listLatestActivityByChainAddress(users: readonly User[]) {
  const db = getDb();
  const latestByChainAddress = new Map<string, number>();
  const trackedKeys = new Set(
    expandTrackedAddresses(users.flatMap((user) => user.addresses))
      .map((address) => buildChainAddressKey(address.chain, address.address))
      .filter(Boolean)
  );
  const latestTimestampStmt = db.prepare(
    `SELECT MAX(timestamp) AS latest_ts
     FROM events
     WHERE source = 'blockchain'
       AND chain = ?
       AND TRIM(COALESCE(address, '')) <> ''
       AND LOWER(address) = ?`
  );

  for (const key of trackedKeys) {
    const [chain, addressLower] = key.split(':', 2);
    if (!chain || !addressLower) {
      continue;
    }

    const row = latestTimestampStmt.get(chain, addressLower) as { latest_ts: number | null } | undefined;
    if (typeof row?.latest_ts !== 'number') {
      continue;
    }

    latestByChainAddress.set(key, row.latest_ts);
  }

  return latestByChainAddress;
}

export function listAddressManagementRows() {
  const users = listTrackedUsers();
  return buildAddressManagementRows(users, listLatestActivityByChainAddress(users));
}
