import 'server-only';

import crypto from 'node:crypto';

import { EVM_CHAINS, expandTrackedAddresses, isEvmAddress, isEvmChain } from '@/lib/addressBook';
import { type AddressAssetSnapshot, type UserAssetSnapshot } from '@/lib/activityFeed';
import { getDb, withTransaction } from '@/lib/server/sqlite';
import { assertValidTrackedAddress } from '@/lib/trackedAddressValidation';
import { type AddressInfo, type ChainType, type User } from '@/types';

const SUPPORTED_CHAINS = new Set<ChainType>(['bsc', 'solana', 'ethereum', 'base']);
const TRACKED_ADDRESS_EVM_EXPANSION_APP_STATE_KEY = 'tracked_address_evm_expansion_v1';

interface TrackedUserRow {
  id: string;
  name: string;
  handle: string;
  avatar: string;
  twitter: string | null;
  twitter_user_id: string | null;
  twitter_avatar_url: string | null;
  telegram: string | null;
  telegrams_json: string;
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

interface NormalizedTrackedAddress {
  chain: ChainType;
  address: string;
  addressLower: string;
}

export interface AddressOwnershipRepairResult {
  ownerUserId: string;
  ownerUserName: string;
  chain: ChainType;
  address: string;
  removedOwnerCount: number;
  reassignedEventCount: number;
  reassignedFeedCount: number;
  reassignedTxStateCount: number;
}

export class TrackedAddressOwnershipConflictError extends Error {
  readonly chain: ChainType;
  readonly address: string;
  readonly existingUserId: string;
  readonly existingUserName: string;

  constructor(params: {
    chain: ChainType;
    address: string;
    existingUserId: string;
    existingUserName: string;
  }) {
    super(`地址已归属于其他人物: ${params.address} (${params.chain}) -> ${params.existingUserName}`);
    this.name = 'TrackedAddressOwnershipConflictError';
    this.chain = params.chain;
    this.address = params.address;
    this.existingUserId = params.existingUserId;
    this.existingUserName = params.existingUserName;
  }
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

function parseTelegramList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  } catch {
    return [];
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
    twitterUserId: row.twitter_user_id || undefined,
    twitterAvatarUrl: row.twitter_avatar_url || undefined,
    telegram: row.telegram || undefined,
    telegrams: parseTelegramList(row.telegrams_json),
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

  for (const item of expandTrackedAddresses(addresses)) {
    const chain = item.chain;
    if (!SUPPORTED_CHAINS.has(chain)) {
      continue;
    }
    const address = assertValidTrackedAddress(item.address, chain);
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

function toNormalizedTrackedAddresses(addresses: User['addresses']): NormalizedTrackedAddress[] {
  const normalized = new Map<string, NormalizedTrackedAddress>();

  for (const item of expandTrackedAddresses(addresses)) {
    const chain = item.chain;
    if (!SUPPORTED_CHAINS.has(chain)) {
      continue;
    }
    const address = assertValidTrackedAddress(item.address, chain);
    const addressLower = normalize(address);
    if (!addressLower) {
      continue;
    }

    normalized.set(`${chain}|${addressLower}`, {
      chain,
      address,
      addressLower,
    });
  }

  return Array.from(normalized.values());
}

function getAppStateFlag(key: string) {
  const db = getDb();
  const row = db
    .prepare('SELECT value_json FROM app_state WHERE key = ? LIMIT 1')
    .get(key) as { value_json: string } | undefined;
  if (!row) {
    return false;
  }

  try {
    const parsed = JSON.parse(row.value_json) as { done?: boolean };
    return parsed.done === true;
  } catch {
    return false;
  }
}

function setAppStateFlag(key: string) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO app_state (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify({ done: true, at: now }), now);
}

function ensureExpandedTrackedAddressRows() {
  if (getAppStateFlag(TRACKED_ADDRESS_EVM_EXPANSION_APP_STATE_KEY)) {
    return;
  }

  withTransaction(() => {
    if (getAppStateFlag(TRACKED_ADDRESS_EVM_EXPANSION_APP_STATE_KEY)) {
      return;
    }

    const db = getDb();
    const rows = db
      .prepare(
        `SELECT
          user_id,
          address,
          address_lower,
          name,
          chain
        FROM tracked_addresses
        ORDER BY created_at ASC, name ASC`
      )
      .all() as Array<{
      user_id: string;
      address: string;
      address_lower: string;
      name: string;
      chain: ChainType;
    }>;

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
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(user_id, chain, address_lower) DO NOTHING`
    );

    const now = Date.now();
    for (const row of rows) {
      if (!isEvmAddress(row.address)) {
        continue;
      }

      for (const chain of EVM_CHAINS) {
        const id = `${row.user_id}:${chain}:${row.address_lower}`;
        upsert.run(id, row.user_id, row.address, row.address_lower, row.name, chain, now, now);
      }
    }

    setAppStateFlag(TRACKED_ADDRESS_EVM_EXPANSION_APP_STATE_KEY);
  });
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
    twitterUserId: user.twitterUserId?.trim() || undefined,
    twitterAvatarUrl: user.twitterAvatarUrl?.trim() || undefined,
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

function assertNoIncomingBatchAddressConflicts(users: User[]) {
  const ownershipByAddress = new Map<
    string,
    {
      userId: string;
      userName: string;
      chain: ChainType;
      address: string;
    }
  >();

  for (const user of users) {
    const normalizedAddresses = toNormalizedTrackedAddresses(user.addresses);
    for (const item of normalizedAddresses) {
      const key = `${item.chain}|${item.addressLower}`;
      const existing = ownershipByAddress.get(key);
      if (existing && existing.userId !== user.id) {
        throw new TrackedAddressOwnershipConflictError({
          chain: item.chain,
          address: item.address,
          existingUserId: existing.userId,
          existingUserName: existing.userName,
        });
      }

      ownershipByAddress.set(key, {
        userId: user.id,
        userName: user.name,
        chain: item.chain,
        address: item.address,
      });
    }
  }
}

function assertNoTrackedAddressOwnershipConflicts(userId: string, addresses: User['addresses']) {
  const normalizedAddresses = toNormalizedTrackedAddresses(addresses);
  if (normalizedAddresses.length === 0) {
    return;
  }

  const db = getDb();
  const existingStmt = db.prepare(
    `SELECT ta.user_id, tu.name, ta.address, ta.chain
     FROM tracked_addresses ta
     INNER JOIN tracked_users tu ON tu.id = ta.user_id
     WHERE ta.chain = ?
       AND ta.address_lower = ?
       AND ta.user_id != ?
     LIMIT 1`
  );

  for (const item of normalizedAddresses) {
    const existing = existingStmt.get(item.chain, item.addressLower, userId) as
      | {
          user_id: string;
          name: string;
          address: string;
          chain: ChainType;
        }
      | undefined;
    if (!existing) {
      continue;
    }

    throw new TrackedAddressOwnershipConflictError({
      chain: existing.chain,
      address: existing.address,
      existingUserId: existing.user_id,
      existingUserName: existing.name,
    });
  }
}

function rewriteActivityOwner(activityJson: string, ownerUserId: string) {
  try {
    const parsed = JSON.parse(activityJson) as { userId?: string };
    if (!parsed || typeof parsed !== 'object') {
      return activityJson;
    }

    return JSON.stringify({
      ...parsed,
      userId: ownerUserId,
    });
  } catch {
    return activityJson;
  }
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
      twitter_user_id,
      twitter_avatar_url,
      telegram,
      telegrams_json,
      tags_json,
      total_asset_usd,
      historical_max_asset_usd,
      asset_updated_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      handle = excluded.handle,
      avatar = excluded.avatar,
      twitter = excluded.twitter,
      twitter_user_id = excluded.twitter_user_id,
      twitter_avatar_url = excluded.twitter_avatar_url,
      telegram = excluded.telegram,
      telegrams_json = excluded.telegrams_json,
      tags_json = excluded.tags_json,
      updated_at = excluded.updated_at`
  ).run(
    user.id,
    user.name,
    user.handle,
    user.avatar,
    user.twitter ?? null,
    user.twitterUserId ?? null,
    user.twitterAvatarUrl ?? null,
    user.telegram ?? null,
    JSON.stringify(user.telegrams ?? []),
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
  const chains = isEvmChain(chain) || isEvmAddress(addressLower) ? EVM_CHAINS : [chain];

  for (const nextChain of chains) {
    db.prepare(
      `DELETE FROM activity_feed
       WHERE user_id = ? AND chain = ? AND tracked_address_lower = ?`
    ).run(userId, nextChain, addressLower);
    db.prepare(
      `DELETE FROM raw_transactions
       WHERE chain = ? AND tracked_address_lower = ?`
    ).run(nextChain, addressLower);
    db.prepare(
      `DELETE FROM activity_judgments
       WHERE chain = ? AND tracked_address_lower = ?`
    ).run(nextChain, addressLower);
    db.prepare(
      `DELETE FROM events
       WHERE chain = ? AND LOWER(COALESCE(address, '')) = ?`
    ).run(nextChain, addressLower);
    db.prepare(
      `DELETE FROM telegram_monitor_events
       WHERE chain = ? AND tracked_wallet_address_lower = ?`
    ).run(nextChain, addressLower);
  }
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
  ensureExpandedTrackedAddressRows();
  const db = getDb();
  const userRows = db
    .prepare(
      `SELECT
        id,
        name,
        handle,
        avatar,
        twitter,
        twitter_user_id,
        twitter_avatar_url,
        telegram,
        telegrams_json,
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
    const sanitizedUsers = users.map((incomingUser) => {
      const baseUser = sanitizeUser(incomingUser);
      const id = baseUser.id.trim() || crypto.randomUUID();
      return {
        ...baseUser,
        id,
      } satisfies User;
    });

    assertNoIncomingBatchAddressConflicts(sanitizedUsers);

    for (const user of sanitizedUsers) {
      assertNoTrackedAddressOwnershipConflicts(user.id, user.addresses);

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
    assertNoTrackedAddressOwnershipConflicts(user.id, user.addresses);
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

    assertNoTrackedAddressOwnershipConflicts(next.id, next.addresses);
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
    assertNoTrackedAddressOwnershipConflicts(userId, sanitized);
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

export function repairTrackedAddressOwnership(params: {
  chain: ChainType;
  address: string;
  ownerUserId: string;
}): AddressOwnershipRepairResult {
  return withTransaction(() => {
    const db = getDb();
    const chain = params.chain;
    const address = assertValidTrackedAddress(params.address, chain);
    const addressLower = normalize(address);
    const owner = listTrackedUsers().find((user) => user.id === params.ownerUserId) || null;
    if (!owner) {
      throw new Error(`Owner user not found: ${params.ownerUserId}`);
    }

    const ownerHasAddress = owner.addresses.some(
      (item) => item.chain === chain && normalize(item.address) === addressLower
    );
    if (!ownerHasAddress) {
      throw new Error(`Owner user does not currently track address: ${address}`);
    }

    const conflictingOwners = db
      .prepare(
        `SELECT DISTINCT ta.user_id
         FROM tracked_addresses ta
         WHERE ta.chain = ?
           AND ta.address_lower = ?
           AND ta.user_id != ?`
      )
      .all(chain, addressLower, owner.id) as Array<{ user_id: string }>;
    const conflictingUserIds = conflictingOwners.map((row) => row.user_id);

    if (conflictingUserIds.length === 0) {
      return {
        ownerUserId: owner.id,
        ownerUserName: owner.name,
        chain,
        address,
        removedOwnerCount: 0,
        reassignedEventCount: 0,
        reassignedFeedCount: 0,
        reassignedTxStateCount: 0,
      };
    }

    const ownerUserJson = JSON.stringify(owner);
    const placeholderParams = conflictingUserIds.map(() => '?').join(', ');
    const now = Date.now();

    const eventRows = db
      .prepare(
        `SELECT event_id, activity_json
         FROM events
         WHERE chain = ?
           AND LOWER(COALESCE(address, '')) = ?
           AND user_id IN (${placeholderParams})`
      )
      .all(chain, addressLower, ...conflictingUserIds) as Array<{ event_id: string; activity_json: string }>;
    const updateEventStmt = db.prepare(
      `UPDATE events
       SET user_id = ?,
           user_name = ?,
           user_json = ?,
           activity_json = ?,
           updated_at = ?
       WHERE event_id = ?`
    );
    for (const row of eventRows) {
      updateEventStmt.run(
        owner.id,
        owner.name,
        ownerUserJson,
        rewriteActivityOwner(row.activity_json, owner.id),
        now,
        row.event_id
      );
    }

    const feedRows = db
      .prepare(
        `SELECT activity_key, activity_json
         FROM activity_feed
         WHERE chain = ?
           AND tracked_address_lower = ?
           AND user_id IN (${placeholderParams})`
      )
      .all(chain, addressLower, ...conflictingUserIds) as Array<{ activity_key: string; activity_json: string }>;
    const updateFeedStmt = db.prepare(
      `UPDATE activity_feed
       SET user_id = ?,
           user_json = ?,
           activity_json = ?
       WHERE activity_key = ?`
    );
    for (const row of feedRows) {
      updateFeedStmt.run(
        owner.id,
        ownerUserJson,
        rewriteActivityOwner(row.activity_json, owner.id),
        row.activity_key
      );
    }

    const updateTxStatesStmt = db.prepare(
      `UPDATE telegram_monitor_tx_states
       SET user_id = ?,
           updated_at = ?
       WHERE chain = ?
         AND tracked_wallet_address_lower = ?
         AND user_id = ?`
    );
    let reassignedTxStateCount = 0;
    for (const conflictingUserId of conflictingUserIds) {
      const result = updateTxStatesStmt.run(owner.id, now, chain, addressLower, conflictingUserId);
      reassignedTxStateCount += result.changes;
    }

    const deleteTrackedAddressStmt = db.prepare(
      `DELETE FROM tracked_addresses
       WHERE chain = ?
         AND address_lower = ?
         AND user_id = ?`
    );
    let removedOwnerCount = 0;
    for (const conflictingUserId of conflictingUserIds) {
      const result = deleteTrackedAddressStmt.run(chain, addressLower, conflictingUserId);
      if (result.changes > 0) {
        removedOwnerCount += 1;
      }
    }

    return {
      ownerUserId: owner.id,
      ownerUserName: owner.name,
      chain,
      address,
      removedOwnerCount,
      reassignedEventCount: eventRows.length,
      reassignedFeedCount: feedRows.length,
      reassignedTxStateCount,
    };
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

// Latest observed on-chain transaction time per tracked address, derived from
// raw_transactions. The key shape `${chain}|${addressLower}` matches the dedupe
// key used elsewhere in this module. NULL entries (addresses with no recorded
// tx_time) are omitted from the map.
export function listTrackedAddressLastTxAtMap(): Map<string, number> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
        ta.chain AS chain,
        ta.address_lower AS address_lower,
        MAX(rt.tx_time) AS last_tx_time
      FROM tracked_addresses ta
      LEFT JOIN raw_transactions rt
        ON rt.chain = ta.chain
       AND rt.tracked_address_lower = ta.address_lower
       AND rt.tx_time IS NOT NULL
      GROUP BY ta.chain, ta.address_lower`
    )
    .all() as Array<{
    chain: string;
    address_lower: string;
    last_tx_time: number | null;
  }>;

  const map = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.last_tx_time !== 'number') {
      continue;
    }
    map.set(`${row.chain}|${row.address_lower}`, row.last_tx_time);
  }
  return map;
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
    const affectedUpdatedAtByUserId = new Map<string, number>();

    const addressStmt = db.prepare(
      `UPDATE tracked_addresses
       SET total_asset_usd = ?, asset_updated_at = ?, updated_at = ?
       WHERE user_id = ? AND chain = ? AND address_lower = ?`
    );

    for (const snapshot of addressAssets) {
      const chain = normalize(snapshot.chain);
      const addressLower = normalize(snapshot.address);
      const userId = snapshot.userId;
      if (!chain || !addressLower || !userId) {
        continue;
      }

      const previousUpdatedAt = affectedUpdatedAtByUserId.get(userId) || 0;
      affectedUpdatedAtByUserId.set(userId, Math.max(previousUpdatedAt, snapshot.updatedAt));
      addressStmt.run(
        typeof snapshot.totalAssetUsd === 'number' ? snapshot.totalAssetUsd : null,
        snapshot.updatedAt,
        Date.now(),
        userId,
        chain,
        addressLower
      );
    }

    for (const snapshot of userAssets) {
      const previousUpdatedAt = affectedUpdatedAtByUserId.get(snapshot.userId) || 0;
      affectedUpdatedAtByUserId.set(snapshot.userId, Math.max(previousUpdatedAt, snapshot.updatedAt));
    }

    const totalByUserStmt = db.prepare(
      `SELECT COALESCE(SUM(total_asset_usd), 0) AS total_asset_usd
       FROM tracked_addresses
       WHERE user_id = ?`
    );
    const userStmt = db.prepare(
      `UPDATE tracked_users
       SET total_asset_usd = ?,
           historical_max_asset_usd = MAX(historical_max_asset_usd, total_asset_usd, ?),
           asset_updated_at = ?,
           updated_at = ?
       WHERE id = ?`
    );

    for (const [userId, updatedAt] of affectedUpdatedAtByUserId) {
      const row = totalByUserStmt.get(userId) as { total_asset_usd: number | null } | undefined;
      const totalAssetUsd = typeof row?.total_asset_usd === 'number' ? row.total_asset_usd : 0;
      userStmt.run(totalAssetUsd, totalAssetUsd, updatedAt, Date.now(), userId);
    }
  });
}
