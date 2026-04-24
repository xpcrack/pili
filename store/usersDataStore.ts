'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { canonicalUsersToLegacy } from '@/lib/canonical';
import { createSafePersistStorage } from '@/lib/safePersistStorage';
import { type CanonicalAddress, type CanonicalUser, User, DEFAULT_USERS } from '@/types';

interface UsersDataState {
  users: User[];
  
  // CRUD 操作
  addUser: (user: Omit<User, 'id'>) => void;
  addUsers: (users: Omit<User, 'id'>[]) => void;
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

function normalizeAddress(address: User['addresses'][number], index: number): User['addresses'][number] {
  return {
    ...address,
    name: normalizeAddressName(address.name, index),
    totalAssetUsd: address.totalAssetUsd ?? null,
    assetUpdatedAt: address.assetUpdatedAt ?? null,
  };
}

function normalizeUser(user: User): User {
  return {
    ...user,
    totalAssetUsd: user.totalAssetUsd ?? 0,
    historicalMaxAssetUsd: user.historicalMaxAssetUsd ?? 0,
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
            (address as CanonicalAddress).chain === 'ethereum')
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
      users: DEFAULT_USERS,

      addUsers: (usersData) => {
        const newUsers: User[] = usersData.map((userData) => ({
          ...normalizeUser(userData as User),
          id: crypto.randomUUID(),
        }));

        set((state) => ({
          users: [...state.users, ...newUsers]
        }));
      },

      addUser: (userData) => {
        const newUser: User = {
          ...normalizeUser(userData as User),
          id: crypto.randomUUID(),
        };
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
            user.id === id ? { ...user, ...normalizedUpdates } : user
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
          users: state.users.map(user => 
            user.id === userId 
              ? { 
                  ...user, 
                  addresses: [
                    ...user.addresses,
                    ...newAddresses.map((address, index) => ({
                      ...address,
                      name: normalizeAddressName(address.name, user.addresses.length + index),
                      totalAssetUsd: null,
                      assetUpdatedAt: null,
                    })),
                  ] 
                } 
              : user
          )
        }));
      },

      removeAddress: (userId, addressToRemove) => {
        set((state) => ({
          users: state.users.map(user => 
            user.id === userId 
              ? { 
                  ...user, 
                  addresses: user.addresses.filter(a => a.address !== addressToRemove) 
                } 
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
              totalAssetUsd: successfulTotal,
              historicalMaxAssetUsd: Math.max(user.historicalMaxAssetUsd || 0, successfulTotal),
              assetUpdatedAt: payload.updatedAt,
            };
          }),
        }));
      },

      getUserById: (id) => {
        return get().users.find(user => user.id === id);
      }
    }),
    {
      name: 'web3-users-data',
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
