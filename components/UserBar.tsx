'use client';

import { useMemo } from 'react';
import { User } from '@/types';
import { UserAvatar } from './UserAvatar';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Activity } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useUserStore } from '@/store/userStore';
import { getUserAvatar } from '@/lib/userProfile';

export type SidebarSortBy = 'historicalMaxAsset' | 'lastActiveTime';

interface UserBarProps {
  users: User[];
  selectedUserId: string | null;
  onSelectUser: (user: User | null) => void;
  sortBy: SidebarSortBy;
  onSortByChange: (sortBy: SidebarSortBy) => void;
  lastActiveAtByUserId: Record<string, number>;
}

const compactNumberFormatter = new Intl.NumberFormat('zh-CN', {
  notation: 'compact',
  maximumFractionDigits: 2,
});

function formatAssetValue(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  return compactNumberFormatter.format(value);
}

export function UserBar({
  users,
  selectedUserId,
  onSelectUser,
  sortBy,
  onSortByChange,
  lastActiveAtByUserId,
}: UserBarProps) {
  const isAllSelected = selectedUserId === null;
  const hasNew = useUserStore((state) => state.hasNew);
  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) => {
      if (sortBy === 'lastActiveTime') {
        const bLastActive = lastActiveAtByUserId[b.id] ?? 0;
        const aLastActive = lastActiveAtByUserId[a.id] ?? 0;

        if (bLastActive !== aLastActive) {
          return bLastActive - aLastActive;
        }
      } else {
        const bHistorical = b.historicalMaxChainAssetTotal ?? 0;
        const aHistorical = a.historicalMaxChainAssetTotal ?? 0;

        if (bHistorical !== aHistorical) {
          return bHistorical - aHistorical;
        }
      }

      return a.name.localeCompare(b.name, 'zh-CN');
    });
  }, [lastActiveAtByUserId, sortBy, users]);

  return (
    <div className="w-full">
      {/* 移动端：保留横向头像栏 */}
      <div className="sticky top-14 z-40 border-b border-zinc-800/50 bg-zinc-950/95 backdrop-blur-sm md:hidden">
        <div className="px-4 pt-3">
          <div className="inline-flex rounded-lg bg-zinc-900/70 p-1 text-xs">
            <button
              onClick={() => onSortByChange('historicalMaxAsset')}
              className={`rounded-md px-2.5 py-1.5 transition ${
                sortBy === 'historicalMaxAsset'
                  ? 'bg-blue-500/20 text-blue-300'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              按历史最高
            </button>
            <button
              onClick={() => onSortByChange('lastActiveTime')}
              className={`rounded-md px-2.5 py-1.5 transition ${
                sortBy === 'lastActiveTime'
                  ? 'bg-blue-500/20 text-blue-300'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              按最后活跃
            </button>
          </div>
        </div>
        <ScrollArea className="w-full whitespace-nowrap">
          <div className="flex items-center gap-4 px-4 py-3">
            <button
              onClick={() => onSelectUser(null)}
              className={`flex min-w-[64px] flex-col items-center gap-1.5 ${
                isAllSelected ? 'opacity-100' : 'opacity-70'
              }`}
            >
              <div
                className={`relative flex h-12 w-12 items-center justify-center rounded-full transition-all duration-200 ${
                  isAllSelected
                    ? 'bg-blue-500/20 ring-2 ring-blue-500'
                    : 'bg-zinc-800/50 ring-2 ring-transparent'
                }`}
              >
                <Activity className={`h-5 w-5 ${isAllSelected ? 'text-blue-400' : 'text-zinc-400'}`} />
              </div>
              <span
                className={`max-w-[64px] truncate text-xs transition-colors ${
                  isAllSelected ? 'font-medium text-blue-400' : 'text-zinc-400'
                }`}
              >
                全部动态
              </span>
            </button>

            {sortedUsers.map((user) => (
              <UserAvatar
                key={user.id}
                user={user}
                isSelected={selectedUserId === user.id}
                onClick={() => onSelectUser(user)}
              />
            ))}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </div>

      {/* 桌面端：左侧栏 */}
      <div className="hidden md:block md:w-full">
        <div className="rounded-2xl border border-zinc-800/70 bg-zinc-900/50 p-2">
          <div className="mb-2 rounded-lg bg-zinc-950/70 p-1">
            <div className="grid grid-cols-2 gap-1">
              <button
                onClick={() => onSortByChange('historicalMaxAsset')}
                className={`rounded-md px-2 py-1.5 text-xs transition ${
                  sortBy === 'historicalMaxAsset'
                    ? 'bg-blue-500/20 text-blue-300'
                    : 'text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-200'
                }`}
              >
                历史最高
              </button>
              <button
                onClick={() => onSortByChange('lastActiveTime')}
                className={`rounded-md px-2 py-1.5 text-xs transition ${
                  sortBy === 'lastActiveTime'
                    ? 'bg-blue-500/20 text-blue-300'
                    : 'text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-200'
                }`}
              >
                最后活跃
              </button>
            </div>
          </div>
          <div className="max-h-[calc(100vh-7rem)] space-y-1 overflow-y-auto pr-1">
            <button
              onClick={() => onSelectUser(null)}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                isAllSelected ? 'bg-blue-500/15 text-blue-300' : 'text-zinc-300 hover:bg-zinc-800/70'
              }`}
            >
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-full ${
                  isAllSelected ? 'bg-blue-500/20 ring-1 ring-blue-500' : 'bg-zinc-800'
                }`}
              >
                <Activity className={`h-4 w-4 ${isAllSelected ? 'text-blue-400' : 'text-zinc-400'}`} />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">全部动态</div>
                <div className="truncate text-xs text-zinc-500">All users</div>
              </div>
            </button>

            {sortedUsers.map((user) => {
              const isSelected = selectedUserId === user.id;

              return (
                <button
                  key={user.id}
                  onClick={() => onSelectUser(user)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                    isSelected ? 'bg-blue-500/15 text-blue-300' : 'text-zinc-300 hover:bg-zinc-800/70'
                  }`}
                >
                  <div className="relative">
                    <Avatar className={`h-9 w-9 ${isSelected ? 'ring-1 ring-blue-500' : ''}`}>
                      <AvatarImage src={getUserAvatar(user)} alt={user.name} />
                      <AvatarFallback className="bg-zinc-800 text-zinc-300">{user.name.slice(0, 2)}</AvatarFallback>
                    </Avatar>
                    {hasNew[user.id] && !isSelected && (
                      <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-zinc-900" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{user.name}</div>
                    <div className="truncate text-xs text-zinc-500">
                      历史峰值 {formatAssetValue(user.historicalMaxChainAssetTotal ?? 0)}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
