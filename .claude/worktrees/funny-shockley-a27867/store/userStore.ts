import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafePersistStorage } from '@/lib/safePersistStorage';

interface UserState {
  // 每个用户最后查看时间
  lastSeenAt: Record<string, number>;
  // 每个用户是否有新动态
  hasNew: Record<string, boolean>;
  // 当前选中的用户（用于弹窗）
  selectedUserId: string | null;
  
  // 操作方法
  setLastSeen: (userId: string, timestamp: number) => void;
  markHasNew: (userId: string, hasNew: boolean) => void;
  checkAndUpdateNewStatus: (userId: string, latestActivityTime: number) => void;
  selectUser: (userId: string | null) => void;
  dismissNewForUser: (userId: string) => void;
}

export const useUserStore = create<UserState>()(
  persist(
    (set, get) => ({
      lastSeenAt: {},
      hasNew: {},
      selectedUserId: null,

      setLastSeen: (userId, timestamp) => set((state) => ({
        lastSeenAt: { ...state.lastSeenAt, [userId]: timestamp }
      })),

      markHasNew: (userId, hasNew) => set((state) => ({
        hasNew: { ...state.hasNew, [userId]: hasNew }
      })),

      checkAndUpdateNewStatus: (userId, latestActivityTime) => {
        const { lastSeenAt } = get();
        const lastSeen = lastSeenAt[userId] || 0;
        const isNew = latestActivityTime > lastSeen;
        
        if (isNew !== get().hasNew[userId]) {
          set((state) => ({
            hasNew: { ...state.hasNew, [userId]: isNew }
          }));
        }
      },

      selectUser: (userId) => set({ selectedUserId: userId }),

      dismissNewForUser: (userId) => set((state) => ({
        hasNew: { ...state.hasNew, [userId]: false },
        lastSeenAt: { ...state.lastSeenAt, [userId]: Date.now() }
      }))
    }),
    {
      name: 'web3-dashboard-storage',
      partialize: (state) => ({ lastSeenAt: state.lastSeenAt }),
      storage: createSafePersistStorage()
    }
  )
);
