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

function latestActivityTextColor(timestamp: number, now: number) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'text-zinc-500';

  const ageMs = Math.max(0, (now || Date.now()) - timestamp);
  const hourMs = 60 * 60 * 1000;

  if (ageMs < hourMs) return 'text-emerald-300';
  if (ageMs < 6 * hourMs) return 'text-lime-300';
  if (ageMs < 24 * hourMs) return 'text-amber-300';
  return 'text-zinc-500';
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

      {/* 桌面端：左侧栏 — ATH 排序 + 红点更新（v1 设计稿） */}
      <div className="hidden md:block md:w-full">
        <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-[#111318]/95">
          <div className="flex items-center justify-between gap-2 border-b border-white/[0.07] px-3 py-2.5">
            <div>
              <div className="text-[12.5px] font-semibold text-zinc-100">聪明钱雷达</div>
              <div className="text-[11px] text-zinc-500">当前资产排序</div>
            </div>
            <div className="text-[11px] text-zinc-500">更新</div>
          </div>
          <div className="space-y-0.5 p-2">
            <button
              onClick={() => onSelectUser(null)}
              className={`grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 rounded-[9px] border px-2 py-1.5 text-left transition-colors ${
                isAllSelected
                  ? 'border-sky-400/20 bg-sky-400/[0.07] text-sky-100'
                  : 'border-transparent text-zinc-300 hover:bg-white/[0.035]'
              }`}
            >
              <div
                className={`flex h-7 w-7 items-center justify-center rounded-full ${
                  isAllSelected ? 'bg-sky-500/20 ring-1 ring-sky-400/50' : 'bg-zinc-800'
                }`}
              >
                <Activity className={`h-3.5 w-3.5 ${isAllSelected ? 'text-sky-300' : 'text-zinc-400'}`} />
              </div>
              <div className="min-w-0">
                <div className="truncate text-[12.5px] font-semibold">全部动态</div>
                <div className="truncate text-[10.5px] text-zinc-500">全局 Feed</div>
              </div>
              <div className={`text-[10.5px] ${isAllSelected ? 'text-sky-300' : 'text-zinc-500'}`}>live</div>
            </button>

            {users.map((user) => {
              const isSelected = selectedUserId === user.id;
              const latestActivityAt = latestActivityAtByUser.get(user.id) ?? 0;
              const latestActivityText = formatRelativeTimeCompact(latestActivityAt, now);
              const latestActivityColor = latestActivityTextColor(latestActivityAt, now);
              const isDisabled = user.monitoringEnabled === false;

              return (
                <button
                  key={user.id}
                  onClick={() => onSelectUser(user)}
                  className={`grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 rounded-[9px] border px-2 py-1.5 text-left transition-colors ${
                    isSelected
                      ? 'border-sky-400/20 bg-sky-400/[0.07] text-sky-100'
                      : 'border-transparent text-zinc-300 hover:bg-white/[0.035]'
                  }`}
                >
                  <div className="relative h-7 w-7">
                    <Avatar className={`h-7 w-7 ${isSelected ? 'ring-1 ring-sky-400/60' : ''}`}>
                      <AvatarImage src={getUserAvatar(user)} alt={user.name} />
                      <AvatarFallback className="bg-zinc-800 text-[10px] text-zinc-300">
                        {user.name.slice(0, 2)}
                      </AvatarFallback>
                    </Avatar>
                    {hasNew[user.id] && !isSelected && (
                      <span className="absolute -right-px -top-px h-2 w-2 rounded-full bg-red-500 shadow-[0_0_0_2px_#111318]" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1">
                      <span className="truncate text-[12.5px] font-semibold">{user.name}</span>
                      {isDisabled && (
                        <span className="shrink-0 rounded bg-zinc-700/70 px-1 text-[9px] leading-3 text-zinc-300">
                          停用
                        </span>
                      )}
                    </div>
                    <div className="mt-px truncate text-[10.5px] text-zinc-500">
                      当前 {formatUsdCompact(user.totalAssetUsd)}
                    </div>
                  </div>
                  <div className={`shrink-0 text-[10.5px] ${isSelected ? 'text-sky-300' : latestActivityColor}`}>
                    {latestActivityText}
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
