'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User, DEFAULT_USERS } from '@/types';
import { createSafePersistStorage } from '@/lib/safePersistStorage';

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
  
  // 获取用户
  getUserById: (id: string) => User | undefined;
}

export const useUsersDataStore = create<UsersDataState>()(
  persist(
    (set, get) => ({
      users: DEFAULT_USERS,

      addUsers: (usersData) => {
        const newUsers: User[] = usersData.map((userData) => ({
          ...userData,
          id: crypto.randomUUID(),
        }));

        set((state) => ({
          users: [...state.users, ...newUsers]
        }));
      },

      addUser: (userData) => {
        const newUser: User = {
          ...userData,
          id: crypto.randomUUID(),
        };
        set((state) => ({
          users: [...state.users, newUser]
        }));
      },

      updateUser: (id, updates) => {
        set((state) => ({
          users: state.users.map(user => 
            user.id === id ? { ...user, ...updates } : user
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
        return get().users.find(user => user.id === id);
      }
    }),
    {
      name: 'web3-users-data',
      partialize: (state) => ({ users: state.users }),
      storage: createSafePersistStorage()
    }
  )
);
