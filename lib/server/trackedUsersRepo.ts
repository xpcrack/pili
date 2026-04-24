import 'server-only';

import crypto from 'node:crypto';

import { type AddressAssetSnapshot, type UserAssetSnapshot } from '@/lib/activityFeed';
import { getDb, withTransaction } from '@/lib/server/sqlite';
import { type AddressInfo, type ChainType, type User } from '@/types';

const SUPPORTED_CHAINS = new Set<ChainType>(['bsc', 'solana', 'ethereum', 'base']);

interface TrackedUserRow {
  id: string;
  name: string;
  handle: string;
  avatar: string;
  twitter: string | null;
  telegram: string | null;
  tags_json: string;
  total_asset_usd: number;
  historical_max_asset_usd: number;
  asset_updated_at: number | null;
}

interface TrackedAddressRow {
  id: string;
  user_id: string;
  address: string;
  address_lower: string;
  name: string;
  chain: ChainType;
  total_asset_usd: number | null;
  asset_updated_at: number | null;
  last_synced_at: number | null;
}

export interface TrackedAddressSyncCursor {
  userId: string;
  chain: ChainType;
  address: string;
  addressLower: string;
  lastSyncedAt: number | null;
}

function normalize(value: string | undefined) {
  return (value || '').trim().toLowerCase();
}

function parseTags(value: string | null | undefined) {
  if (!value) {
    return [] as string[];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [] as string[];
    }
    return parsed.filter((tag): tag is string => typeof tag === 'string');
  } catch {
    return [] as string[];
  }
}

function mapAddressRow(row: TrackedAddressRow): AddressInfo {
  return {
    address: row.address,
    name: row.name,
    chain: row.chain,
    totalAssetUsd: typeof row.total_asset_usd === 'number' ? row.total_asset_usd : null,
    assetUpdatedAt: typeof row.asset_updated_at === 'number' ? row.asset_updated_at : null,
  };
}

function mapUserRow(row: TrackedUserRow, addresses: AddressInfo[]): User {
  const totalAssetUsd = typeof row.total_asset_usd === 'number' ? row.total_asset_usd : 0;
  const historicalMaxAssetUsd =
    typeof row.historical_max_asset_usd === 'number' ? row.historical_max_asset_usd : totalAssetUsd;
  const assetUpdatedAt = typeof row.asset_updated_at === 'number' ? row.asset_updated_at : null;
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    avatar: row.avatar,
    twitter: row.twitter || undefined,
    telegram: row.telegram || undefined,
    addresses,
    currentChainAssetTotal: totalAssetUsd,
    historicalMaxChainAssetTotal: historicalMaxAssetUsd,
    totalAssetUsd,
    historicalMaxAssetUsd,
    assetUpdatedAt,
    tags: parseTags(row.tags_json),
  };
}

function sanitizeAddresses(addresses: User['addresses']) {
  const deduped = new Map<string, AddressInfo>();

  for (const item of addresses) {
    const chain = item.chain;
    if (!SUPPORTED_CHAINS.has(chain)) {
      continue;
    }
    const address = item.address.trim();
    const addressLower = normalize(address);
    if (!addressLower) {
      continue;
    }
    const name = item.name.trim() || '#1';
    deduped.set(`${chain}|${addressLower}`, {
      address,
      name,
      chain,
      totalAssetUsd: typeof item.totalAssetUsd === 'number' ? item.totalAssetUsd : null,
      assetUpdatedAt: typeof item.assetUpdatedAt === 'number' ? item.assetUpdatedAt : null,
    });
  }

  return Array.from(deduped.values());
}

function sanitizeUser(user: User): User {
  const totalAssetUsd =
    typeof user.totalAssetUsd === 'number' ? user.totalAssetUsd : user.currentChainAssetTotal ?? 0;
  const historicalMaxAssetUsd =
    typeof user.historicalMaxAssetUsd === 'number'
      ? user.historicalMaxAssetUsd
      : user.historicalMaxChainAssetTotal ?? totalAssetUsd;
  const assetUpdatedAt = typeof user.assetUpdatedAt === 'number' ? user.assetUpdatedAt : null;
  return {
    ...user,
    name: user.name.trim() || '未命名人物',
    handle: user.handle.trim() || `user-${user.id.slice(0, 8)}`,
    avatar: user.avatar.trim(),
    twitter: user.twitter?.trim() || undefined,
    telegram: user.telegram?.trim() || undefined,
    currentChainAssetTotal: totalAssetUsd,
    historicalMaxChainAssetTotal: Math.max(totalAssetUsd, historicalMaxAssetUsd),
    totalAssetUsd,
    historicalMaxAssetUsd: Math.max(totalAssetUsd, historicalMaxAssetUsd),
    assetUpdatedAt,
    tags: Array.isArray(user.tags) ? user.tags.filter((tag) => typeof tag === 'string') : [],
    addresses: sanitizeAddresses(user.addresses),
  };
}

function refreshPersistedUserSnapshots(user: User) {
  const db = getDb();
  const userJson = JSON.stringify(user);

  db.prepare(
    `UPDATE activity_feed
     SET user_json = ?
     WHERE user_id = ?`
  ).run(userJson, user.id);

  db.prepare(
    `UPDATE events
     SET user_name = ?,
         user_json = ?,
         updated_at = ?
     WHERE user_id = ?`
  ).run(user.name, userJson, Date.now(), user.id);
}

function upsertUserRow(user: User, now: number) {
  const db = getDb();
  const totalAssetUsd =
    typeof user.totalAssetUsd === 'number' ? user.totalAssetUsd : user.currentChainAssetTotal ?? 0;
  const historicalMaxAssetUsd =
    typeof user.historicalMaxAssetUsd === 'number'
      ? user.historicalMaxAssetUsd
      : user.historicalMaxChainAssetTotal ?? totalAssetUsd;
  db.prepare(
    `INSERT INTO tracked_users (
      id,
      name,
      handle,
      avatar,
      twitter,
      telegram,
      tags_json,
      total_asset_usd,
      historical_max_asset_usd,
      asset_updated_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      handle = excluded.handle,
      avatar = excluded.avatar,
      twitter = excluded.twitter,
      telegram = excluded.telegram,
      tags_json = excluded.tags_json,
      updated_at = excluded.updated_at`
  ).run(
    user.id,
    user.name,
    user.handle,
    user.avatar,
    user.twitter ?? null,
    user.telegram ?? null,
    JSON.stringify(user.tags),
    totalAssetUsd,
    Math.max(historicalMaxAssetUsd, totalAssetUsd),
    user.assetUpdatedAt,
    now,
    now
  );
}

function upsertAddressRows(userId: string, addresses: AddressInfo[], now: number, replaceExisting: boolean) {
  const db = getDb();
  const nextKeys = new Set<string>();

  const upsert = db.prepare(
    `INSERT INTO tracked_addresses (
      id,
      user_id,
      address,
      address_lower,
      name,
      chain,
      total_asset_usd,
      asset_updated_at,
      last_synced_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, chain, address_lower) DO UPDATE SET
      name = excluded.name,
      updated_at = excluded.updated_at`
  );

  for (const address of addresses) {
    const addressLower = normalize(address.address);
    if (!addressLower) {
      continue;
    }
    const key = `${address.chain}|${addressLower}`;
    nextKeys.add(key);

    const id = `${userId}:${address.chain}:${addressLower}`;
    upsert.run(
      id,
      userId,
      address.address,
      addressLower,
      address.name,
      address.chain,
      address.totalAssetUsd,
      address.assetUpdatedAt,
      null,
      now,
      now
    );
  }

  if (!replaceExisting) {
    return;
  }

  const existing = db
    .prepare('SELECT chain, address_lower FROM tracked_addresses WHERE user_id = ?')
    .all(userId) as Array<{ chain: string; address_lower: string }>;

  for (const row of existing) {
    const key = `${row.chain}|${row.address_lower}`;
    if (nextKeys.has(key)) {
      continue;
    }

    db.prepare('DELETE FROM tracked_addresses WHERE user_id = ? AND chain = ? AND address_lower = ?').run(
      userId,
      row.chain,
      row.address_lower
    );
    purgeAddressRelatedData(userId, row.chain, row.address_lower);
  }
}

function purgeAddressRelatedData(userId: string, chain: string, addressLower: string) {
  const db = getDb();
  db.prepare(
    `DELETE FROM activity_feed
     WHERE user_id = ? AND chain = ? AND tracked_address_lower = ?`
  ).run(userId, chain, addressLower);
  db.prepare(
    `DELETE FROM raw_transactions
     WHERE chain = ? AND tracked_address_lower = ?`
  ).run(chain, addressLower);
  db.prepare(
    `DELETE FROM activity_judgments
     WHERE chain = ? AND tracked_address_lower = ?`
  ).run(chain, addressLower);
}

function purgeTelegramMonitorEventsByTrackedAddress(chain: string, addressLower: string) {
  const db = getDb();
  db.prepare(
    `DELETE FROM telegram_monitor_events
     WHERE chain = ? AND tracked_wallet_address_lower = ?`
  ).run(chain, addressLower);
}

function purgeOrphanedAddressData() {
  const db = getDb();
  db.prepare(
    `DELETE FROM activity_feed
     WHERE tracked_address_lower IS NOT NULL
       AND tracked_address_lower != ''
       AND chain IS NOT NULL
       AND chain != ''
       AND NOT EXISTS (
       SELECT 1 FROM tracked_addresses ta
       WHERE ta.chain = activity_feed.chain
         AND ta.address_lower = activity_feed.tracked_address_lower
     )`
  ).run();
  db.prepare(
    `DELETE FROM raw_transactions
     WHERE NOT EXISTS (
       SELECT 1 FROM tracked_addresses ta
       WHERE ta.chain = raw_transactions.chain
         AND ta.address_lower = raw_transactions.tracked_address_lower
     )`
  ).run();
  db.prepare(
    `DELETE FROM activity_judgments
     WHERE NOT EXISTS (
       SELECT 1 FROM tracked_addresses ta
       WHERE ta.chain = activity_judgments.chain
         AND ta.address_lower = activity_judgments.tracked_address_lower
     )`
  ).run();
}

export function listTrackedUsers() {
  const db = getDb();
  const userRows = db
    .prepare(
      `SELECT
        id,
        name,
        handle,
        avatar,
        twitter,
        telegram,
        tags_json,
        total_asset_usd,
        historical_max_asset_usd,
        asset_updated_at
      FROM tracked_users
      ORDER BY created_at ASC, name ASC`
    )
    .all() as TrackedUserRow[];

  if (userRows.length === 0) {
    return [] as User[];
  }

  const addressRows = db
    .prepare(
      `SELECT
        id,
        user_id,
        address,
        address_lower,
        name,
        chain,
        total_asset_usd,
        asset_updated_at,
        last_synced_at
      FROM tracked_addresses
      ORDER BY created_at ASC, name ASC`
    )
    .all() as TrackedAddressRow[];

  const addressMap = new Map<string, AddressInfo[]>();
  for (const row of addressRows) {
    const list = addressMap.get(row.user_id) || [];
    list.push(mapAddressRow(row));
    addressMap.set(row.user_id, list);
  }

  return userRows.map((row) => mapUserRow(row, addressMap.get(row.id) || []));
}

export function countTrackedUsers() {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(1) AS count FROM tracked_users').get() as { count: number };
  return row.count;
}

export function importTrackedUsers(users: User[], options?: { replaceExisting?: boolean }) {
  const replaceExisting = options?.replaceExisting === true;

  return withTransaction(() => {
    const db = getDb();
    const now = Date.now();

    if (replaceExisting) {
      db.prepare('DELETE FROM tracked_addresses').run();
      db.prepare('DELETE FROM tracked_users').run();
    }

    const importedIds: string[] = [];

    for (const incomingUser of users) {
      const baseUser = sanitizeUser(incomingUser);
      const id = baseUser.id.trim() || crypto.randomUUID();
      const user: User = {
        ...baseUser,
        id,
      };

      upsertUserRow(user, now);
      upsertAddressRows(user.id, user.addresses, now, true);
      importedIds.push(user.id);
    }

    purgeOrphanedAddressData();

    return {
      importedCount: importedIds.length,
      importedIds,
    };
  });
}

export function createTrackedUser(input: Omit<User, 'id'>) {
  const now = Date.now();
  const user = sanitizeUser({
    ...input,
    id: crypto.randomUUID(),
  });

  withTransaction(() => {
    upsertUserRow(user, now);
    upsertAddressRows(user.id, user.addresses, now, true);
  });

  return user;
}

export function updateTrackedUser(id: string, updates: Partial<User>) {
  return withTransaction(() => {
    const currentUsers = listTrackedUsers();
    const current = currentUsers.find((user) => user.id === id);
    if (!current) {
      return null;
    }

    const next = sanitizeUser({
      ...current,
      ...updates,
      id,
      addresses: updates.addresses ? sanitizeAddresses(updates.addresses) : current.addresses,
    });
    const now = Date.now();

    upsertUserRow(next, now);
    if (updates.addresses) {
      upsertAddressRows(next.id, next.addresses, now, true);
    }

    refreshPersistedUserSnapshots(next);
    const refreshed = listTrackedUsers().find((user) => user.id === id);
    return refreshed || next;
  });
}

export function deleteTrackedUser(id: string) {
  return withTransaction(() => {
    const db = getDb();
    const addresses = db
      .prepare(
        `SELECT chain, address_lower
         FROM tracked_addresses
         WHERE user_id = ?`
      )
      .all(id) as Array<{ chain: string; address_lower: string }>;

    for (const row of addresses) {
      purgeAddressRelatedData(id, row.chain, row.address_lower);
      purgeTelegramMonitorEventsByTrackedAddress(row.chain, row.address_lower);
    }

    db.prepare('DELETE FROM tracked_addresses WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM activity_feed WHERE user_id = ?').run(id);
    const result = db.prepare('DELETE FROM tracked_users WHERE id = ?').run(id);

    return result.changes > 0;
  });
}

export function addTrackedAddresses(userId: string, addresses: User['addresses']) {
  return withTransaction(() => {
    const db = getDb();
    const exists = db.prepare('SELECT id FROM tracked_users WHERE id = ? LIMIT 1').get(userId);
    if (!exists) {
      return null;
    }

    const sanitized = sanitizeAddresses(addresses);
    const now = Date.now();
    upsertAddressRows(userId, sanitized, now, false);

    const refreshed = listTrackedUsers().find((user) => user.id === userId);
    return refreshed || null;
  });
}

export function removeTrackedAddress(userId: string, address: string, chain?: ChainType) {
  return withTransaction(() => {
    const db = getDb();
    const addressLower = normalize(address);
    if (!addressLower) {
      return false;
    }

    const removedRows = chain
      ? (db
          .prepare(
            `SELECT chain, address_lower
             FROM tracked_addresses
             WHERE user_id = ? AND chain = ? AND address_lower = ?`
          )
          .all(userId, chain, addressLower) as Array<{ chain: string; address_lower: string }>)
      : (db
          .prepare(
            `SELECT chain, address_lower
             FROM tracked_addresses
             WHERE user_id = ? AND address_lower = ?`
          )
          .all(userId, addressLower) as Array<{ chain: string; address_lower: string }>);

    if (removedRows.length === 0) {
      return false;
    }

    if (chain) {
      db.prepare('DELETE FROM tracked_addresses WHERE user_id = ? AND chain = ? AND address_lower = ?').run(
        userId,
        chain,
        addressLower
      );
    } else {
      db.prepare('DELETE FROM tracked_addresses WHERE user_id = ? AND address_lower = ?').run(userId, addressLower);
    }

    for (const row of removedRows) {
      purgeAddressRelatedData(userId, row.chain, row.address_lower);
    }

    return true;
  });
}

export function listTrackedAddressSyncCursors() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
        user_id,
        chain,
        address,
        address_lower,
        last_synced_at
      FROM tracked_addresses`
    )
    .all() as Array<{
    user_id: string;
    chain: ChainType;
    address: string;
    address_lower: string;
    last_synced_at: number | null;
  }>;

  return rows.map((row) => ({
    userId: row.user_id,
    chain: row.chain,
    address: row.address,
    addressLower: row.address_lower,
    lastSyncedAt: typeof row.last_synced_at === 'number' ? row.last_synced_at : null,
  })) as TrackedAddressSyncCursor[];
}

export function markAddressesSynced(cursors: Array<{ chain: string; address: string; syncedAt: number }>) {
  if (cursors.length === 0) {
    return;
  }

  withTransaction(() => {
    const db = getDb();
    const stmt = db.prepare(
      `UPDATE tracked_addresses
       SET last_synced_at = ?, updated_at = ?
       WHERE chain = ? AND address_lower = ?`
    );

    for (const cursor of cursors) {
      const chain = normalize(cursor.chain);
      const addressLower = normalize(cursor.address);
      if (!chain || !addressLower) {
        continue;
      }
      stmt.run(cursor.syncedAt, Date.now(), chain, addressLower);
    }
  });
}

export function updateAssetSnapshots(addressAssets: AddressAssetSnapshot[], userAssets: UserAssetSnapshot[]) {
  if (addressAssets.length === 0 && userAssets.length === 0) {
    return;
  }

  withTransaction(() => {
    const db = getDb();

    const addressStmt = db.prepare(
      `UPDATE tracked_addresses
       SET total_asset_usd = ?, asset_updated_at = ?, updated_at = ?
       WHERE user_id = ? AND chain = ? AND address_lower = ?`
    );

    for (const snapshot of addressAssets) {
      const chain = normalize(snapshot.chain);
      const addressLower = normalize(snapshot.address);
      if (!chain || !addressLower) {
        continue;
      }

      addressStmt.run(
        typeof snapshot.totalAssetUsd === 'number' ? snapshot.totalAssetUsd : null,
        snapshot.updatedAt,
        Date.now(),
        snapshot.userId,
        chain,
        addressLower
      );
    }

    const userStmt = db.prepare(
      `UPDATE tracked_users
       SET total_asset_usd = ?,
           historical_max_asset_usd = MAX(historical_max_asset_usd, ?),
           asset_updated_at = ?,
           updated_at = ?
       WHERE id = ?`
    );

    for (const snapshot of userAssets) {
      userStmt.run(snapshot.totalAssetUsd, snapshot.totalAssetUsd, snapshot.updatedAt, Date.now(), snapshot.userId);
    }
  });
}
