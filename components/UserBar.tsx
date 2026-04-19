'use client';

import { useEffect, useState } from 'react';
import { User } from '@/types';
import { UserAvatar } from './UserAvatar';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Activity } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useUserStore } from '@/store/userStore';
import { getUserAvatar } from '@/lib/userProfile';
import { formatUsdCompact } from '@/lib/assetFormat';
import { formatRelativeTimeCompact } from '@/lib/timeFormat';

interface UserBarProps {
  users: User[];
  selectedUserId: string | null;
  latestActivityAtByUser: Map<string, number>;
  onSelectUser: (user: User | null) => void;
}

export function UserBar({ users, selectedUserId, latestActivityAtByUser, onSelectUser }: UserBarProps) {
  const isAllSelected = selectedUserId === null;
  const hasNew = useUserStore((state) => state.hasNew);
  const [now, setNow] = useState(0);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const kickoff = window.setTimeout(tick, 0);
    const timer = window.setInterval(() => {
      tick();
    }, 60 * 1000);

    return () => {
      window.clearTimeout(kickoff);
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="w-full">
      {/* 移动端：保留横向头像栏 */}
      <div className="sticky top-14 z-40 border-b border-zinc-800/50 bg-zinc-950/95 backdrop-blur-sm md:hidden">
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

            {users.map((user) => (
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

            {users.map((user) => {
              const isSelected = selectedUserId === user.id;
              const latestActivityAt = latestActivityAtByUser.get(user.id) ?? 0;
              const latestActivityText = formatRelativeTimeCompact(latestActivityAt, now);

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
                    <div className="mt-0.5 flex items-center gap-2 text-xs">
                      <span className="min-w-0 truncate text-zinc-500">
                        {formatUsdCompact(user.totalAssetUsd)}
                      </span>
                      <span className={`shrink-0 text-[11px] ${isSelected ? 'text-blue-300/90' : 'text-zinc-400'}`}>
                        {latestActivityText}
                      </span>
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
