'use client';

import { KeyboardEvent, useMemo, useState } from 'react';
import { Activity, User } from '@/types';
import { UserBar } from '@/components/UserBar';
import { ActivityCard } from '@/components/ActivityCard';
import { FeedDebugPanel } from '@/components/FeedDebugPanel';
import { TopNav } from '@/components/TopNav';
import { useActivityPolling } from '@/hooks/useActivityPolling';
import { useIsClient } from '@/hooks/useIsClient';
import { useUserStore } from '@/store/userStore';
import { useUsersDataStore } from '@/store/usersDataStore';
import { ArrowLeft, User as UserIcon } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getUserAvatar } from '@/lib/userProfile';
import { formatUsdCompact } from '@/lib/assetFormat';
import { Input } from '@/components/ui/input';
import {
  applySuggestionToInput,
  buildSearchSuggestionSources,
  getSearchSuggestions,
  hasActiveSearchQuery,
  parseSearchQuery,
} from '@/lib/smartSearch';

const MAX_GLOBAL_FEED_ITEMS = 200;
const MIN_SELECTED_USER_FEED_ITEMS = 50;

function rebalanceMixedFeed(feed: Array<{ user: User; activity: Activity }>) {
  const twitter = feed.filter((item) => item.activity.source === 'twitter');
  const nonTwitter = feed.filter((item) => item.activity.source !== 'twitter');

  if (twitter.length === 0 || nonTwitter.length === 0) {
    return feed;
  }

  const balanced: Array<{ user: User; activity: Activity }> = [];
  let twitterIndex = 0;
  let nonTwitterIndex = 0;

  while (twitterIndex < twitter.length || nonTwitterIndex < nonTwitter.length) {
    for (let i = 0; i < 4 && nonTwitterIndex < nonTwitter.length; i += 1) {
      balanced.push(nonTwitter[nonTwitterIndex]);
      nonTwitterIndex += 1;
    }
    if (twitterIndex < twitter.length) {
      balanced.push(twitter[twitterIndex]);
      twitterIndex += 1;
    }
  }

  return balanced.sort((a, b) => {
    const indexA = balanced.indexOf(a);
    const indexB = balanced.indexOf(b);
    if (Math.abs(a.activity.timestamp - b.activity.timestamp) > 30 * 60 * 1000) {
      return b.activity.timestamp - a.activity.timestamp;
    }
    return indexA - indexB;
  });
}

function mergeGlobalFeedByPrimaryKey(feed: Array<{ user: User; activity: Activity }>) {
  const merged = new Map<string, { user: User; activity: Activity }>();

  for (const item of feed) {
    const tweetId = item.activity.metadata.tweetId?.trim().toLowerCase();
    if (tweetId) {
      const key = `twitter:${tweetId}`;
      const existing = merged.get(key);
      if (!existing || item.activity.timestamp >= existing.activity.timestamp) {
        merged.set(key, item);
      }
      continue;
    }

    const txHash = item.activity.metadata.txHash?.trim().toLowerCase();
    if (!txHash) {
      merged.set(`__nohash__:${item.activity.id}`, item);
      continue;
    }

    const existing = merged.get(txHash);
    if (!existing) {
      merged.set(txHash, item);
      continue;
    }

    const representative =
      item.activity.timestamp >= existing.activity.timestamp ? item : existing;
    const counterpart = representative === item ? existing : item;

    const userNames = new Set([
      ...(representative.activity.metadata.coHitUserNames || [representative.user.name]),
      ...(counterpart.activity.metadata.coHitUserNames || [counterpart.user.name]),
    ]);

    const addresses = new Set([
      ...(representative.activity.metadata.coHitAddresses || []).map((value) => value.toLowerCase()),
      ...(counterpart.activity.metadata.coHitAddresses || []).map((value) => value.toLowerCase()),
      representative.activity.metadata.trackedAddress?.toLowerCase() || '',
      counterpart.activity.metadata.trackedAddress?.toLowerCase() || '',
    ]);
    addresses.delete('');

    merged.set(txHash, {
      ...representative,
      activity: {
        ...representative.activity,
        metadata: {
          ...representative.activity.metadata,
          coHitUserCount: userNames.size,
          coHitAddressCount: addresses.size,
          coHitUserNames: Array.from(userNames),
          coHitAddresses: Array.from(addresses),
        },
      },
    });
  }

  return Array.from(merged.values()).sort((a, b) => b.activity.timestamp - a.activity.timestamp);
}

export default function Home() {
  // null 表示全部动态，有值表示特定用户
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [sidebarSortMode, setSidebarSortMode] = useState<'recent' | 'asset'>('asset');
  const [hoveredTokenCa, setHoveredTokenCa] = useState<string | null>(null);
  const [hoveredAddress, setHoveredAddress] = useState<string | null>(null);
  const [globalVisibleCount, setGlobalVisibleCount] = useState(MAX_GLOBAL_FEED_ITEMS);
  const [selectedUserVisibleCount, setSelectedUserVisibleCount] = useState(MIN_SELECTED_USER_FEED_ITEMS);
  const [isExpanding, setIsExpanding] = useState(false);
  const [expandFeedback, setExpandFeedback] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [isSuggestionOpen, setIsSuggestionOpen] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const isClient = useIsClient();
  
  const { users } = useUsersDataStore();
  const {
    feed,
    latestActivityAtByUser,
    loading,
    error,
    hasMore,
    historyComplete,
    localQualifiedCount,
    refetch,
    lastUpdate,
    summary,
    diagnostics,
  } = useActivityPolling(selectedUserId, searchInput);
  const { dismissNewForUser } = useUserStore();

  // 当前选中的用户对象
  const selectedUser = useMemo(() => {
    if (!selectedUserId) return null;
    return users.find(u => u.id === selectedUserId) || null;
  }, [selectedUserId, users]);

  const parsedSearchQuery = useMemo(() => parseSearchQuery(searchInput), [searchInput]);
  const hasSearchQuery = hasActiveSearchQuery(parsedSearchQuery);
  const suggestionSources = useMemo(
    () => buildSearchSuggestionSources(feed, users),
    [feed, users]
  );
  const suggestions = useMemo(
    () => getSearchSuggestions(searchInput, suggestionSources),
    [searchInput, suggestionSources]
  );

  const selectedUserFeed = useMemo(() => feed, [feed]);
  const pagedSourceFeed = useMemo(() => {
    if (selectedUserId) {
      return selectedUserFeed;
    }
    return rebalanceMixedFeed(mergeGlobalFeedByPrimaryKey(selectedUserFeed));
  }, [selectedUserFeed, selectedUserId]);
  const filteredFeed = useMemo(() => {
    if (!selectedUserId) return pagedSourceFeed.slice(0, globalVisibleCount);
    return pagedSourceFeed.slice(0, selectedUserVisibleCount);
  }, [selectedUserId, globalVisibleCount, pagedSourceFeed, selectedUserVisibleCount]);
  const isInitialLoading = loading && feed.length === 0;

  const visibleUserIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of feed) {
      ids.add(item.user.id);
    }
    return ids;
  }, [feed]);

  const sidebarUsers = useMemo(() => {
    const sorted = [...users];

    sorted.sort((a, b) => {
      if (sidebarSortMode === 'asset') {
        const byHistoricalAsset = b.historicalMaxAssetUsd - a.historicalMaxAssetUsd;
        if (byHistoricalAsset !== 0) return byHistoricalAsset;

        const byCurrentAsset = b.totalAssetUsd - a.totalAssetUsd;
        if (byCurrentAsset !== 0) return byCurrentAsset;
      } else {
        const byLatest = (latestActivityAtByUser.get(b.id) ?? 0) - (latestActivityAtByUser.get(a.id) ?? 0);
        if (byLatest !== 0) return byLatest;
      }

      return a.name.localeCompare(b.name, 'zh-CN');
    });

    if (hasSearchQuery) {
      return sorted.filter((user) => visibleUserIds.has(user.id));
    }

    return sorted;
  }, [users, sidebarSortMode, latestActivityAtByUser, hasSearchQuery, visibleUserIds]);

  const addressAliasMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const trackedUser of users) {
      for (const address of trackedUser.addresses) {
        const key = address.address.toLowerCase();
        if (map.has(key)) continue;
        const alias = address.name.startsWith('#')
          ? `${trackedUser.name}${address.name}`
          : `${trackedUser.name}#${address.name}`;
        map.set(key, alias);
      }
    }
    return map;
  }, [users]);

  const resetExpandStateForSearch = () => {
    setGlobalVisibleCount(MAX_GLOBAL_FEED_ITEMS);
    setSelectedUserVisibleCount(MIN_SELECTED_USER_FEED_ITEMS);
    setExpandFeedback(null);
    setIsExpanding(false);
  };

  const safeActiveSuggestionIndex = suggestions.length === 0
    ? 0
    : Math.min(activeSuggestionIndex, suggestions.length - 1);

  const handleApplySuggestion = (suggestionText: string) => {
    setSearchInput((current) => applySuggestionToInput(current, suggestionText));
    setIsSuggestionOpen(false);
    setActiveSuggestionIndex(0);
    resetExpandStateForSearch();
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!isSuggestionOpen || suggestions.length === 0) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveSuggestionIndex((index) => (index + 1) % suggestions.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveSuggestionIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
      return;
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const suggestion = suggestions[safeActiveSuggestionIndex];
      if (!suggestion) return;
      handleApplySuggestion(suggestion.insertText);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setIsSuggestionOpen(false);
    }
  };

  // 处理选择用户
  const handleSelectUser = async (user: User | null) => {
    setSelectedUserId(user?.id || null);
    setExpandFeedback(null);
    
    // 如果选中某个用户，清除该用户的红点
    if (user) {
      dismissNewForUser(user.id);
      setSelectedUserVisibleCount(MIN_SELECTED_USER_FEED_ITEMS);

      setIsExpanding(true);
      setExpandFeedback('正在从本地库读取该人物动态...');
      const result = await refetch({
        targetCount: hasSearchQuery ? undefined : MIN_SELECTED_USER_FEED_ITEMS,
        selectedUserId: user.id,
        searchQuery: searchInput,
        syncStrategy: 'local',
      });
      setIsExpanding(false);

      if (!result.success) {
        if (result.error === '请求进行中') {
          setExpandFeedback('请求排队中，上一轮完成后会自动切换到该人物数据');
          return;
        }
        setExpandFeedback(result.error ? `API 拉取失败：${result.error}` : 'API 拉取失败');
        return;
      }

      const partialSuffix = result.partialSyncWarning ? '（部分地址失败，数据可能未完全对齐）' : '';
      const historySuffix =
        result.historyComplete === true
          ? '（本地历史已补完）'
          : result.selectedFeedLength < MIN_SELECTED_USER_FEED_ITEMS && !hasSearchQuery
            ? '（已自动继续补历史）'
            : '';
      setExpandFeedback(
        `已从本地库读取该人物 ${result.selectedFeedLength} 条动态${historySuffix}${partialSuffix}`
      );
      return;
    }

    setSelectedUserVisibleCount(MIN_SELECTED_USER_FEED_ITEMS);
  };

  // 返回全部动态
  const handleBackToAll = () => {
    setSelectedUserId(null);
    setExpandFeedback(null);
    setGlobalVisibleCount(MAX_GLOBAL_FEED_ITEMS);
    setSelectedUserVisibleCount(MIN_SELECTED_USER_FEED_ITEMS);
    void refetch({ selectedUserId: null, searchQuery: searchInput, syncStrategy: 'local' });
  };

  const handlePullMoreHistory = async () => {
    if (isExpanding) {
      return;
    }

    const isSelectedMode = Boolean(selectedUserId);
    const nextVisibleCount = isSelectedMode
      ? selectedUserVisibleCount + 50
      : globalVisibleCount + 50;

    if (isSelectedMode) {
      setSelectedUserVisibleCount(nextVisibleCount);
      if (pagedSourceFeed.length >= nextVisibleCount) {
        setExpandFeedback(`已从缓存展开到 ${Math.min(nextVisibleCount, pagedSourceFeed.length)}/${pagedSourceFeed.length} 条`);
        return;
      }
    } else {
      setGlobalVisibleCount(nextVisibleCount);
      if (pagedSourceFeed.length >= nextVisibleCount) {
        setExpandFeedback(`已从缓存展开到 ${Math.min(nextVisibleCount, pagedSourceFeed.length)}/${pagedSourceFeed.length} 条`);
        return;
      }
    }

    if (hasMore) {
      setIsExpanding(true);
      setExpandFeedback('正在从本地库加载更多动态...');
      const localResult = await refetch({
        targetCount: nextVisibleCount,
        selectedUserId,
        searchQuery: searchInput,
        syncStrategy: 'local',
      });
      setIsExpanding(false);

      if (!localResult.success) {
        setExpandFeedback(localResult.error ? `本地读取失败：${localResult.error}` : '本地读取失败');
        return;
      }

      const localCount = isSelectedMode ? localResult.selectedFeedLength : localResult.feedLength;
      setExpandFeedback(`已从本地库展开到 ${localCount} 条`);
      if (localCount >= nextVisibleCount || localResult.hasMore) {
        return;
      }
    }

    setIsExpanding(true);
    setExpandFeedback(
      isSelectedMode
        ? '该人物本地动态不足，正在向前补 7 天历史...'
        : '本地库不足，正在按所有源向前拉取 7 天历史...'
    );
    const result = await refetch({
      selectedUserId,
      searchQuery: searchInput,
      syncStrategy: 'backfill',
      backfillScope: isSelectedMode ? 'user' : 'global',
    });
    setIsExpanding(false);

    if (!result.success) {
      setExpandFeedback(result.error ? `API 拉取失败：${result.error}` : 'API 拉取失败');
      return;
    }
    const partialSuffix = result.partialSyncWarning ? '（部分地址失败，数据可能未完全对齐）' : '';
    const autoBackfillSuffix = '（已前推 7 天）';

    if (!isSelectedMode && result.feedLength >= nextVisibleCount) {
      setExpandFeedback(
        `API 拉取完成，已展开到 ${nextVisibleCount}/${result.feedLength} 条${autoBackfillSuffix}${partialSuffix}`
      );
      return;
    }

    if (isSelectedMode) {
      if (result.selectedFeedLength >= nextVisibleCount) {
        setExpandFeedback(
          `API 拉取完成，已展开到 ${nextVisibleCount}/${result.selectedFeedLength} 条${autoBackfillSuffix}${partialSuffix}`
        );
        return;
      }
      setExpandFeedback(
        `API 拉取完成，该人物本地可用 ${result.selectedFeedLength} 条${
          result.historyComplete === true ? '（历史已补完）' : autoBackfillSuffix
        }${partialSuffix}`
      );
      return;
    }

    setExpandFeedback(`API 拉取完成，筛选后可用 ${result.feedLength} 条${autoBackfillSuffix}${partialSuffix}`);
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
      <TopNav
        active="feed"
        rightSlot={
          lastUpdate ? (
            <span className="hidden text-xs text-zinc-500 sm:inline">
              更新于 {lastUpdate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          ) : null
        }
      />

      <div className="mx-auto w-full max-w-7xl px-4 py-6">
        <div className="flex flex-col gap-6 md:flex-row md:items-start">
          <aside className="w-full md:sticky md:top-20 md:w-64 md:shrink-0">
            <div className="mb-2 flex items-center justify-center gap-1 rounded-lg border border-zinc-800/70 bg-zinc-900/50 p-1">
              <button
                onClick={() => setSidebarSortMode('recent')}
                className={`rounded px-2 py-1 text-xs transition-colors ${
                  sidebarSortMode === 'recent'
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                最近活跃
              </button>
              <button
                onClick={() => setSidebarSortMode('asset')}
                className={`rounded px-2 py-1 text-xs transition-colors ${
                  sidebarSortMode === 'asset'
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                最高资产
              </button>
            </div>
            <UserBar
              users={sidebarUsers}
              selectedUserId={selectedUserId}
              latestActivityAtByUser={latestActivityAtByUser}
              onSelectUser={handleSelectUser}
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

            <div className="relative mb-4 rounded-lg border border-zinc-800/60 bg-zinc-900/50 p-3">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={searchInput}
                  onChange={(event) => {
                    setSearchInput(event.target.value);
                    setIsSuggestionOpen(true);
                    setActiveSuggestionIndex(0);
                    resetExpandStateForSearch();
                  }}
                  onFocus={() => setIsSuggestionOpen(true)}
                  onBlur={() => {
                    window.setTimeout(() => setIsSuggestionOpen(false), 120);
                  }}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="智能搜索：person:昵称 address:0x... tx:... ca:... ticker:SOL action:buy"
                  className="h-9 border-zinc-700 bg-zinc-950 text-zinc-100 placeholder:text-zinc-500"
                />
                <button
                  type="button"
                  onClick={() => {
                    setSearchInput('');
                    setIsSuggestionOpen(false);
                    setActiveSuggestionIndex(0);
                    resetExpandStateForSearch();
                  }}
                  className="h-9 rounded border border-zinc-700 px-3 text-sm text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
                >
                  清空筛选
                </button>
              </div>
              {isSuggestionOpen && suggestions.length > 0 && (
                <div className="absolute left-3 right-3 top-[calc(100%-2px)] z-40 mt-1 overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 shadow-lg">
                  <ul className="max-h-64 overflow-y-auto py-1 text-sm">
                    {suggestions.map((suggestion, index) => (
                      <li key={`${suggestion.insertText}-${index}`}>
                        <button
                          type="button"
                          onMouseDown={(event) => {
                            event.preventDefault();
                            handleApplySuggestion(suggestion.insertText);
                          }}
                          className={`w-full px-3 py-1.5 text-left transition-colors ${
                            index === safeActiveSuggestionIndex
                              ? 'bg-zinc-700 text-zinc-100'
                              : 'text-zinc-300 hover:bg-zinc-800'
                          }`}
                        >
                          {suggestion.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="mt-2 text-xs text-zinc-500">
                支持字段：person / address / tx / ca / ticker / action。空格分隔表示 AND 条件。
              </p>
            </div>

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

                <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-1.5 text-xs text-zinc-300">
                  <div className="text-zinc-500">总资产</div>
                  <div className="text-sm font-medium text-zinc-100">{formatUsdCompact(selectedUser.totalAssetUsd)}</div>
                </div>

                <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-1.5 text-xs text-zinc-300">
                  <div className="text-zinc-500">历史最高</div>
                  <div className="text-sm font-medium text-zinc-100">
                    {formatUsdCompact(selectedUser.historicalMaxAssetUsd)}
                  </div>
                </div>

                <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-1.5 text-xs text-zinc-300">
                  <div className="text-zinc-500">本地动态</div>
                  <div className="text-sm font-medium text-zinc-100">
                    {localQualifiedCount}
                    <span className="ml-2 text-xs text-zinc-500">
                      {historyComplete === true ? '已补完' : '补历史中'}
                    </span>
                  </div>
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

            <div className="space-y-2">
              {isInitialLoading ? (
                <div className="space-y-2">
                  {[...Array(5)].map((_, i) => (
                    <div key={i} className="h-16 animate-pulse rounded-xl bg-zinc-900/50" />
                  ))}
                </div>
              ) : filteredFeed.length > 0 ? (
                <div className="space-y-3">
                  <div className="overflow-hidden rounded-xl border border-zinc-800/70 bg-zinc-950/70">
                  <div className="divide-y divide-zinc-800/70">
                  {filteredFeed.map(({ user, activity }) => (
                    <ActivityCard
                      key={activity.id}
                      activity={activity}
                      user={user}
                      activeTokenCa={hoveredTokenCa}
                      onTokenCaHover={setHoveredTokenCa}
                      activeAddress={hoveredAddress}
                      onAddressHover={setHoveredAddress}
                      addressAliasMap={addressAliasMap}
                    />
                  ))}
                  </div>
                  </div>
                  <div className="flex items-center justify-end rounded-lg border border-zinc-800/70 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-400">
                    {expandFeedback && (
                      <span className="mr-3 text-zinc-500">{expandFeedback}</span>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handlePullMoreHistory()}
                        disabled={isExpanding}
                        className="rounded border border-zinc-700 px-3 py-1 text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        拉取更多（前推 7 天）
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="py-20 text-center">
                  {selectedUser ? (
                    <div>
                      <UserIcon className="mx-auto mb-3 h-12 w-12 text-zinc-600" />
                      <p className="text-zinc-500">
                        {historyComplete === false && !hasSearchQuery
                          ? `${selectedUser.name} 本地动态不足，正在继续补历史...`
                          : hasSearchQuery
                            ? `${selectedUser.name} 在当前筛选下暂无动态`
                            : `${selectedUser.name} 暂无动态`}
                      </p>
                      {selectedUserId && !hasSearchQuery && (
                        <p className="mt-2 text-xs text-zinc-600">
                          本地已收录 {localQualifiedCount} 条合格动态
                          {historyComplete === true ? '，历史已补完' : '，历史仍在补齐中'}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-zinc-500">
                      {hasSearchQuery ? '当前筛选条件下暂无动态' : '暂无动态'}
                    </p>
                  )}
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
      <FeedDebugPanel
        totalInDatabase={summary?.transactionCount || 0}
        apiFeedLength={feed.length}
        lastUpdate={lastUpdate}
      />
    </div>
  );
}
