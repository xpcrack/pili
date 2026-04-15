'use client';

import { useState, useMemo } from 'react';
import { User } from '@/types';
import { UserBar, type SidebarSortBy } from '@/components/UserBar';
import { ActivityCard } from '@/components/ActivityCard';
import { useActivityPolling } from '@/hooks/useActivityPolling';
import { useIsClient } from '@/hooks/useIsClient';
import { useUserStore } from '@/store/userStore';
import { useUsersDataStore } from '@/store/usersDataStore';
import { RefreshCw, Zap, ArrowLeft, User as UserIcon, Settings } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import Link from 'next/link';
import { getUserAvatar } from '@/lib/userProfile';

export default function Home() {
  // null 表示全部动态，有值表示特定用户
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [sidebarSortBy, setSidebarSortBy] = useState<SidebarSortBy>('historicalMaxAsset');
  const isClient = useIsClient();
  
  const { users } = useUsersDataStore();
  const { feed, loading, error, refetch, lastUpdate, summary, diagnostics } = useActivityPolling();
  const { dismissNewForUser } = useUserStore();

  // 当前选中的用户对象
  const selectedUser = useMemo(() => {
    if (!selectedUserId) return null;
    return users.find(u => u.id === selectedUserId) || null;
  }, [selectedUserId, users]);

  // 筛选后的动态列表
  const filteredFeed = useMemo(() => {
    if (!selectedUserId) return feed; // 全部动态
    return feed.filter(item => item.user.id === selectedUserId);
  }, [feed, selectedUserId]);

  const lastActiveAtByUserId = useMemo(() => {
    const activityMap: Record<string, number> = {};

    for (const item of feed) {
      const userId = item.user.id;
      const currentLatest = activityMap[userId] ?? 0;

      if (item.activity.timestamp > currentLatest) {
        activityMap[userId] = item.activity.timestamp;
      }
    }

    return activityMap;
  }, [feed]);

  // 处理选择用户
  const handleSelectUser = (user: User | null) => {
    setSelectedUserId(user?.id || null);
    
    // 如果选中某个用户，清除该用户的红点
    if (user) {
      dismissNewForUser(user.id);
    }
  };

  // 返回全部动态
  const handleBackToAll = () => {
    setSelectedUserId(null);
  };

  if (!isClient) {
    return (
      <div className="min-h-screen bg-zinc-950">
        <div className="mx-auto flex min-h-screen max-w-4xl items-center justify-center px-4">
          <div className="text-sm text-zinc-500">加载中...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* 顶部导航 */}
      <header className="sticky top-0 z-50 bg-zinc-950/95 backdrop-blur-md border-b border-zinc-800/50">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <h1 className="text-lg font-semibold text-zinc-100">
              Web3玩家动态
            </h1>
          </div>
          
          <div className="flex items-center gap-2">
            {lastUpdate && (
              <span className="text-xs text-zinc-500 hidden sm:inline">
                更新于 {lastUpdate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            <button
              onClick={refetch}
              disabled={loading}
              className="p-2 rounded-lg bg-zinc-800/50 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <Link
              href="/manage"
              className="p-2 rounded-lg bg-zinc-800/50 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              <Settings className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-7xl px-4 py-6">
        <div className="flex flex-col gap-6 md:flex-row md:items-start">
          <aside className="w-full md:sticky md:top-20 md:w-64 md:shrink-0">
            <UserBar
              users={users}
              selectedUserId={selectedUserId}
              onSelectUser={handleSelectUser}
              sortBy={sidebarSortBy}
              onSortByChange={setSidebarSortBy}
              lastActiveAtByUserId={lastActiveAtByUserId}
            />
          </aside>

          <main className="min-w-0 flex-1">
            {error && (
              <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-400">
                {error}
              </div>
            )}

            {summary && (
              <div className="mb-4 rounded-lg border border-zinc-800/60 bg-zinc-900/50 p-4 text-sm text-zinc-300">
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  <span>已检查 {summary.userCount} 人</span>
                  <span>{summary.addressCount} 个地址</span>
                  <span>{summary.transactionCount} 条动态</span>
                  <span>成功 {summary.successfulAddressCount}</span>
                  <span>空地址 {summary.emptyAddressCount}</span>
                  <span className={summary.failedAddressCount > 0 ? 'text-red-400' : 'text-zinc-400'}>
                    失败 {summary.failedAddressCount}
                  </span>
                </div>
                {diagnostics.some((item) => item.error) && (
                  <div className="mt-3 space-y-1 text-xs text-zinc-500">
                    {diagnostics
                      .filter((item) => item.error)
                      .slice(0, 5)
                      .map((item) => (
                        <div key={`${item.userId}-${item.address}`}>
                          {item.userName} / {item.addressName}: {item.error}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}

            {selectedUser && (
              <div className="mb-6 flex items-center gap-4 rounded-xl border border-zinc-800/50 bg-zinc-900/50 p-4">
                <button
                  onClick={handleBackToAll}
                  className="flex items-center gap-2 text-zinc-400 transition-colors hover:text-zinc-200"
                >
                  <ArrowLeft className="h-4 w-4" />
                  <span className="text-sm">返回</span>
                </button>

                <div className="h-6 w-px bg-zinc-800" />

                <Avatar className="h-10 w-10">
                  <AvatarImage src={getUserAvatar(selectedUser)} alt={selectedUser.name} />
                  <AvatarFallback className="bg-zinc-800 text-zinc-400">
                    {selectedUser.name.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>

                <div>
                  <h2 className="font-medium text-zinc-100">{selectedUser.name}</h2>
                  <p className="text-sm text-zinc-500">@{selectedUser.handle}</p>
                </div>

                <div className="ml-auto flex items-center gap-2">
                  {selectedUser.tags.map((tag) => (
                    <span key={tag} className="rounded bg-zinc-800/50 px-2 py-0.5 text-xs text-zinc-400">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-4">
              {loading && filteredFeed.length === 0 ? (
                <div className="space-y-4">
                  {[...Array(5)].map((_, i) => (
                    <div key={i} className="h-32 animate-pulse rounded-xl bg-zinc-900/50" />
                  ))}
                </div>
              ) : filteredFeed.length > 0 ? (
                <div className="space-y-4">
                  {filteredFeed.map(({ user, activity }) => (
                    <ActivityCard key={activity.id} activity={activity} user={user} />
                  ))}
                </div>
              ) : (
                <div className="py-20 text-center">
                  {selectedUser ? (
                    <div>
                      <UserIcon className="mx-auto mb-3 h-12 w-12 text-zinc-600" />
                      <p className="text-zinc-500">{selectedUser.name} 暂无动态</p>
                    </div>
                  ) : (
                    <p className="text-zinc-500">暂无动态</p>
                  )}
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
