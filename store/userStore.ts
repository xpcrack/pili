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
  // 手动标星的交易员（true=已标星）
  starredUserIds: Record<string, boolean>;
  // 左侧栏「只看标星」开关
  onlyStarred: boolean;
  
  // 操作方法
  setLastSeen: (userId: string, timestamp: number) => void;
  markHasNew: (userId: string, hasNew: boolean) => void;
  checkAndUpdateNewStatus: (userId: string, latestActivityTime: number) => void;
  selectUser: (userId: string | null) => void;
  dismissNewForUser: (userId: string) => void;
  toggleStarredUser: (userId: string) => void;
  setOnlyStarred: (value: boolean) => void;
}

export const useUserStore = create<UserState>()(
  persist(
    (set, get) => ({
      lastSeenAt: {},
      hasNew: {},
      selectedUserId: null,
      starredUserIds: {},
      onlyStarred: false,

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
      })),

      toggleStarredUser: (userId) => set((state) => ({
        starredUserIds: { ...state.starredUserIds, [userId]: !state.starredUserIds[userId] }
      })),

      setOnlyStarred: (value) => set({ onlyStarred: value })
    }),
    {
      name: 'web3-dashboard-storage',
      partialize: (state) => ({
        lastSeenAt: state.lastSeenAt,
        starredUserIds: state.starredUserIds,
        onlyStarred: state.onlyStarred,
      }),
      storage: createSafePersistStorage()
    }
  )
);
