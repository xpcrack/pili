'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User, DEFAULT_USERS } from '@/types';
import { createSafePersistStorage } from '@/lib/safePersistStorage';

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
  const currentChainAssetTotal = normalizeAssetTotal(userData.currentChainAssetTotal);
  const providedHistoricalMax = normalizeAssetTotal(userData.historicalMaxChainAssetTotal);
  const historicalMaxChainAssetTotal = Math.max(currentChainAssetTotal, providedHistoricalMax);

  return {
    ...userData,
    id: crypto.randomUUID(),
    currentChainAssetTotal,
    historicalMaxChainAssetTotal,
  };
}

function applyUserUpdates(user: User, updates: Partial<User>): User {
  const mergedUser = { ...user, ...updates };
  const hasCurrentAssetInUpdates = Object.prototype.hasOwnProperty.call(updates, 'currentChainAssetTotal');
  const hasHistoricalAssetInUpdates = Object.prototype.hasOwnProperty.call(updates, 'historicalMaxChainAssetTotal');

  const currentChainAssetTotal = hasCurrentAssetInUpdates
    ? normalizeAssetTotal(updates.currentChainAssetTotal)
    : normalizeAssetTotal(mergedUser.currentChainAssetTotal);

  const historicalCandidate = hasHistoricalAssetInUpdates
    ? normalizeAssetTotal(updates.historicalMaxChainAssetTotal)
    : normalizeAssetTotal(mergedUser.historicalMaxChainAssetTotal);

  return {
    ...mergedUser,
    currentChainAssetTotal,
    historicalMaxChainAssetTotal: Math.max(currentChainAssetTotal, historicalCandidate),
  };
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
  
  // 获取用户
  getUserById: (id: string) => User | undefined;
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
          users: state.users.map(user => 
            user.id === userId 
              ? { 
                  ...user, 
                  addresses: [...user.addresses, ...newAddresses] 
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
      storage: createSafePersistStorage()
    }
  )
);
