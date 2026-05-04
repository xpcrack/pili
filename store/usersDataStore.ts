'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { canonicalUsersToLegacy } from '@/lib/canonical';
import { repairMalformedTrackedAddress } from '@/lib/trackedAddressValidation';
import { createSafePersistStorage } from '@/lib/safePersistStorage';
import { type CanonicalAddress, type CanonicalUser, User, DEFAULT_USERS } from '@/types';

type UserDraftInput = Omit<User, 'id' | 'currentChainAssetTotal' | 'historicalMaxChainAssetTotal'> & {
  currentChainAssetTotal?: number;
  historicalMaxChainAssetTotal?: number;
};

function isPersistedUser(value: unknown): value is User {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<User>;

  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.handle === 'string' &&
    typeof candidate.avatar === 'string' &&
    Array.isArray(candidate.addresses) &&
    Array.isArray(candidate.tags)
  );
}

function extractUsersFromPersistedState(persistedState: unknown): User[] {
  let rawUsers: unknown;

  if (Array.isArray(persistedState)) {
    rawUsers = persistedState;
  } else if (persistedState && typeof persistedState === 'object') {
    const candidate = persistedState as {
      users?: unknown;
      state?: {
        users?: unknown;
      };
    };

    if (Array.isArray(candidate.users)) {
      rawUsers = candidate.users;
    } else if (Array.isArray(candidate.state?.users)) {
      rawUsers = candidate.state.users;
    }
  }

  if (!Array.isArray(rawUsers)) {
    return [];
  }

  return rawUsers.filter(isPersistedUser).map(normalizePersistedUser);
}

function normalizeAssetTotal(value: unknown) {
  const amount = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(amount) || amount < 0) {
    return 0;
  }

  return amount;
}

function buildUserWithAssetFields(userData: UserDraftInput): User {
  const totalAssetUsd =
    typeof userData.totalAssetUsd === 'number'
      ? normalizeAssetTotal(userData.totalAssetUsd)
      : normalizeAssetTotal(userData.currentChainAssetTotal);
  const historicalMaxAssetUsd = Math.max(
    totalAssetUsd,
    typeof userData.historicalMaxAssetUsd === 'number'
      ? normalizeAssetTotal(userData.historicalMaxAssetUsd)
      : normalizeAssetTotal(userData.historicalMaxChainAssetTotal)
  );

  return normalizeUser({
    ...userData,
    id: crypto.randomUUID(),
    totalAssetUsd,
    historicalMaxAssetUsd,
    assetUpdatedAt: userData.assetUpdatedAt ?? null,
  } as User);
}

function applyUserUpdates(user: User, updates: Partial<User>): User {
  const mergedUser = { ...user, ...updates };
  const hasCurrentAssetInUpdates = Object.prototype.hasOwnProperty.call(updates, 'currentChainAssetTotal');
  const hasHistoricalAssetInUpdates = Object.prototype.hasOwnProperty.call(updates, 'historicalMaxChainAssetTotal');
  const hasTotalAssetInUpdates = Object.prototype.hasOwnProperty.call(updates, 'totalAssetUsd');
  const hasHistoricalMaxUsdInUpdates = Object.prototype.hasOwnProperty.call(updates, 'historicalMaxAssetUsd');

  const totalAssetUsd = hasTotalAssetInUpdates
    ? normalizeAssetTotal(updates.totalAssetUsd)
    : hasCurrentAssetInUpdates
      ? normalizeAssetTotal(updates.currentChainAssetTotal)
      : normalizeAssetTotal(mergedUser.totalAssetUsd);

  const historicalCandidate = hasHistoricalMaxUsdInUpdates
    ? normalizeAssetTotal(updates.historicalMaxAssetUsd)
    : hasHistoricalAssetInUpdates
      ? normalizeAssetTotal(updates.historicalMaxChainAssetTotal)
      : normalizeAssetTotal(mergedUser.historicalMaxAssetUsd);

  return normalizeUser({
    ...mergedUser,
    totalAssetUsd,
    historicalMaxAssetUsd: Math.max(totalAssetUsd, historicalCandidate),
  });
}

function normalizePersistedUser(user: User): User {
  return applyUserUpdates(user, {});
}

interface UsersDataState {
  users: User[];
  
  // CRUD 操作
  addUser: (user: UserDraftInput) => void;
  addUsers: (users: UserDraftInput[]) => void;
  updateUser: (id: string, updates: Partial<User>) => void;
  deleteUser: (id: string) => void;
  
  // 批量添加地址
  batchAddAddresses: (userId: string, addresses: { address: string; name: string; chain: User['addresses'][0]['chain'] }[]) => void;
  
  // 删除地址
  removeAddress: (userId: string, address: string) => void;

  // 更新资产快照
  upsertUserAssetSnapshot: (
    userId: string,
    payload: {
      addresses: Array<{ address: string; totalAssetUsd: number | null; updatedAt: number }>;
      updatedAt: number;
    }
  ) => void;
  
  // 获取用户
  getUserById: (id: string) => User | undefined;
}

function normalizeAddressName(name: string, index: number) {
  const trimmed = name.trim();
  if (!trimmed) {
    return `#${index + 1}`;
  }

  const legacyMatch = trimmed.match(/^地址\s*(\d+)$/);
  if (legacyMatch) {
    const parsedIndex = Number.parseInt(legacyMatch[1], 10);
    return `#${Number.isFinite(parsedIndex) && parsedIndex > 0 ? parsedIndex : index + 1}`;
  }

  return trimmed;
}

function normalizeAddressLookupValue(value: string) {
  return value.trim().toLowerCase();
}

function sumAddressAssetUsd(addresses: readonly User['addresses'][number][]) {
  return addresses.reduce((sum, address) => {
    if (typeof address.totalAssetUsd !== 'number') {
      return sum;
    }

    return sum + address.totalAssetUsd;
  }, 0);
}

function getLatestAddressAssetUpdatedAt(addresses: readonly User['addresses'][number][]) {
  const timestamps = addresses
    .map((address) => address.assetUpdatedAt)
    .filter((value): value is number => typeof value === 'number');

  if (timestamps.length === 0) {
    return null;
  }

  return Math.max(...timestamps);
}

function applyAddressCollectionUpdate(user: User, addresses: User['addresses']) {
  const normalizedAddresses = addresses.map((address, index) => normalizeAddress(address, index));
  const currentTotalAssetUsd = sumAddressAssetUsd(normalizedAddresses);
  const historicalMaxAssetUsd = Math.max(
    normalizeAssetTotal(user.historicalMaxAssetUsd),
    normalizeAssetTotal(user.historicalMaxChainAssetTotal),
    currentTotalAssetUsd
  );

  return normalizeUser({
    ...user,
    addresses: normalizedAddresses,
    totalAssetUsd: currentTotalAssetUsd,
    currentChainAssetTotal: currentTotalAssetUsd,
    historicalMaxAssetUsd,
    historicalMaxChainAssetTotal: historicalMaxAssetUsd,
    assetUpdatedAt: getLatestAddressAssetUpdatedAt(normalizedAddresses),
  });
}

function normalizeAddress(address: User['addresses'][number], index: number): User['addresses'][number] {
  const repairedAddress = repairMalformedTrackedAddress(address.address, address.chain) ?? address.address.trim();

  return {
    ...address,
    address: repairedAddress,
    name: normalizeAddressName(address.name, index),
    totalAssetUsd: address.totalAssetUsd ?? null,
    assetUpdatedAt: address.assetUpdatedAt ?? null,
  };
}

function normalizeUser(user: User): User {
  const totalAssetUsd =
    typeof user.totalAssetUsd === 'number'
      ? normalizeAssetTotal(user.totalAssetUsd)
      : normalizeAssetTotal(user.currentChainAssetTotal);
  const historicalMaxAssetUsd = Math.max(
    totalAssetUsd,
    typeof user.historicalMaxAssetUsd === 'number'
      ? normalizeAssetTotal(user.historicalMaxAssetUsd)
      : normalizeAssetTotal(user.historicalMaxChainAssetTotal)
  );
  return {
    ...user,
    currentChainAssetTotal: totalAssetUsd,
    historicalMaxChainAssetTotal: historicalMaxAssetUsd,
    totalAssetUsd,
    historicalMaxAssetUsd,
    assetUpdatedAt: user.assetUpdatedAt ?? null,
    addresses: user.addresses.map((address, index) => normalizeAddress(address, index)),
  };
}

function isCanonicalUser(candidate: unknown): candidate is CanonicalUser {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const user = candidate as Partial<CanonicalUser>;
  return (
    typeof user.id === 'string' &&
    typeof user.name === 'string' &&
    typeof user.avatar === 'string' &&
    typeof user.currentBalanceUsd === 'number' &&
    typeof user.maxBalanceUsd === 'number'
  );
}

function isLegacyUser(candidate: unknown): candidate is User {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const user = candidate as Partial<User>;
  return (
    typeof user.id === 'string' &&
    typeof user.name === 'string' &&
    typeof user.handle === 'string' &&
    typeof user.avatar === 'string' &&
    Array.isArray(user.addresses)
  );
}

function isCanonicalAddressesByUserId(value: unknown): value is Record<string, CanonicalAddress[]> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return Object.values(value).every(
    (addresses) =>
      Array.isArray(addresses) &&
      addresses.every(
        (address) =>
          !!address &&
          typeof address === 'object' &&
          typeof (address as CanonicalAddress).id === 'string' &&
          typeof (address as CanonicalAddress).userId === 'string' &&
          typeof (address as CanonicalAddress).address === 'string' &&
          ((address as CanonicalAddress).chain === 'bsc' ||
            (address as CanonicalAddress).chain === 'solana' ||
            (address as CanonicalAddress).chain === 'ethereum' ||
            (address as CanonicalAddress).chain === 'base')
      )
  );
}

function mergeRecoveredAddresses(users: User[], addressesByUserId: Record<string, CanonicalAddress[]>) {
  return users.map((user) => {
    const recovered = addressesByUserId[user.id] || [];
    if (recovered.length === 0) {
      return user;
    }

    const existingKeys = new Set(
      user.addresses.map((address) => `${address.chain}:${address.address.trim().toLowerCase()}`)
    );
    const restoredAddresses = recovered.flatMap((address, index) => {
      const key = `${address.chain}:${address.address.trim().toLowerCase()}`;
      if (existingKeys.has(key)) {
        return [];
      }

      existingKeys.add(key);
      return [
        {
          address: address.address,
          name: `#${user.addresses.length + index + 1}`,
          chain: address.chain,
          totalAssetUsd: null,
          assetUpdatedAt: null,
        },
      ];
    });

    if (restoredAddresses.length === 0) {
      return user;
    }

    return normalizeUser({
      ...user,
      addresses: [...user.addresses, ...restoredAddresses],
    });
  });
}

function restorePersistedUsers(persistedState: unknown, currentUsers: User[]) {
  const state = (persistedState ?? {}) as {
    users?: unknown;
    addressesByUserId?: unknown;
  };
  const addressesByUserId = isCanonicalAddressesByUserId(state.addressesByUserId)
    ? state.addressesByUserId
    : {};

  if (!Array.isArray(state.users)) {
    return currentUsers;
  }

  if (state.users.every(isLegacyUser)) {
    return mergeRecoveredAddresses(state.users.map((user) => normalizeUser(user)), addressesByUserId);
  }

  if (state.users.every(isCanonicalUser)) {
    return canonicalUsersToLegacy(state.users, addressesByUserId).map((user) => normalizeUser(user));
  }

  return currentUsers;
}

export const useUsersDataStore = create<UsersDataState>()(
  persist(
    (set, get) => ({
      users: DEFAULT_USERS.map(normalizePersistedUser),

      addUsers: (usersData) => {
        const newUsers: User[] = usersData.map(buildUserWithAssetFields);

        set((state) => ({
          users: [...state.users, ...newUsers]
        }));
      },

      addUser: (userData) => {
        const newUser = buildUserWithAssetFields(userData);
        set((state) => ({
          users: [...state.users, newUser]
        }));
      },

      updateUser: (id, updates) => {
        const normalizedUpdates: Partial<User> = { ...updates };

        if (updates.addresses) {
          normalizedUpdates.addresses = updates.addresses.map((address, index) => normalizeAddress(address, index));
        }

        set((state) => ({
          users: state.users.map(user => 
            user.id === id ? applyUserUpdates(normalizePersistedUser(user), updates) : normalizePersistedUser(user)
          )
        }));
      },

      deleteUser: (id) => {
        set((state) => ({
          users: state.users.filter(user => user.id !== id)
        }));
      },

      batchAddAddresses: (userId, newAddresses) => {
        set((state) => ({
          users: state.users.map((user) =>
            user.id === userId
              ? applyAddressCollectionUpdate(user, [
                  ...user.addresses,
                  ...newAddresses.map((address, index) => ({
                    ...address,
                    name: normalizeAddressName(address.name, user.addresses.length + index),
                    totalAssetUsd: null,
                    assetUpdatedAt: null,
                  })),
                ])
              : user
          )
        }));
      },

      removeAddress: (userId, addressToRemove) => {
        const addressLookup = normalizeAddressLookupValue(addressToRemove);
        set((state) => ({
          users: state.users.map((user) =>
            user.id === userId
              ? applyAddressCollectionUpdate(
                  user,
                  user.addresses.filter(
                    (address) => normalizeAddressLookupValue(address.address) !== addressLookup
                  )
                )
              : user
          )
        }));
      },

      upsertUserAssetSnapshot: (userId, payload) => {
        set((state) => ({
          users: state.users.map((user) => {
            if (user.id !== userId) {
              return user;
            }

            const addressAssetMap = new Map(
              payload.addresses.map((item) => [item.address.toLowerCase(), item] as const)
            );
            const nextAddresses = user.addresses.map((address) => {
              const incoming = addressAssetMap.get(address.address.toLowerCase());
              if (!incoming) {
                return address;
              }

              return {
                ...address,
                totalAssetUsd: incoming.totalAssetUsd,
                assetUpdatedAt: incoming.updatedAt,
              };
            });

            const successfulTotal = nextAddresses.reduce((sum, address) => {
              if (typeof address.totalAssetUsd !== 'number') {
                return sum;
              }
              return sum + address.totalAssetUsd;
            }, 0);

            return {
              ...user,
              addresses: nextAddresses,
              currentChainAssetTotal: successfulTotal,
              historicalMaxChainAssetTotal: Math.max(user.historicalMaxChainAssetTotal || 0, successfulTotal),
              totalAssetUsd: successfulTotal,
              historicalMaxAssetUsd: Math.max(user.historicalMaxAssetUsd || 0, successfulTotal),
              assetUpdatedAt: payload.updatedAt,
            };
          }),
        }));
      },

      getUserById: (id) => {
        const user = get().users.find((item) => item.id === id);
        return user ? normalizePersistedUser(user) : undefined;
      }
    }),
    {
      name: 'web3-users-data',
      version: 1,
      migrate: (persistedState) => {
        const users = extractUsersFromPersistedState(persistedState);
        return { users };
      },
      partialize: (state) => ({ users: state.users }),
      storage: createSafePersistStorage(),
      merge: (persistedState, currentState) => {
        return {
          ...currentState,
          users: restorePersistedUsers(persistedState, currentState.users),
        };
      },
    }
  )
);
