'use client';

import { useEffect, useMemo, useState } from 'react';
import { User } from '@/types';
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
import { prepareGlobalFeed, prepareUserFeed } from '@/lib/feedOrdering';
import { buildActivityScopedDedupKey } from '@/lib/activityIdentity';
import { shouldShowGlobalCompletenessWindow } from '@/lib/feedCompletenessVisibility';
import { Input } from '@/components/ui/input';
import {
  type FeedSearchFilters,
  DEFAULT_FEED_SEARCH_FILTERS,
  getRemoteFeedSearchKeyword,
  hasAnyEnabledFeedType,
  matchesFeedSearchFilters,
} from '@/lib/smartSearch';
import {
  normalizeTradeValueDisplayMode,
  type TradeValueDisplayMode,
} from '@/lib/tradeDisplay';
import {
  type FeedTimeDisplayMode,
  normalizeFeedTimeDisplayMode,
} from '@/lib/timeFormat';

const MAX_GLOBAL_FEED_ITEMS = 200;
const MIN_SELECTED_USER_FEED_ITEMS = 50;
const FEED_TIME_DISPLAY_MODE_STORAGE_KEY = 'pilipili:feed-time-display-mode';
const TRADE_VALUE_DISPLAY_MODE_STORAGE_KEY = 'pilipili:trade-value-display-mode';

function getActivityRenderKey(userId: string, activityId: string, scopedKey: string) {
  return scopedKey || `${userId}:${activityId}`;
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
  const [searchFilters, setSearchFilters] = useState<FeedSearchFilters>(DEFAULT_FEED_SEARCH_FILTERS);
  const [timeDisplayMode, setTimeDisplayMode] = useState<FeedTimeDisplayMode>('relative');
  const [tradeValueDisplayMode, setTradeValueDisplayMode] = useState<TradeValueDisplayMode>('native');
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
    activityBreakdown,
    completenessWindow,
    refetch,
    lastUpdate,
    summary,
    diagnostics,
    prewarmLabel,
  } = useActivityPolling(selectedUserId, getRemoteFeedSearchKeyword(searchFilters.keyword));
  const { dismissNewForUser } = useUserStore();

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      try {
        setTimeDisplayMode(
          normalizeFeedTimeDisplayMode(window.localStorage.getItem(FEED_TIME_DISPLAY_MODE_STORAGE_KEY))
        );
        setTradeValueDisplayMode(
          normalizeTradeValueDisplayMode(window.localStorage.getItem(TRADE_VALUE_DISPLAY_MODE_STORAGE_KEY))
        );
      } catch {
        setTimeDisplayMode('relative');
        setTradeValueDisplayMode('native');
      }
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.setItem(FEED_TIME_DISPLAY_MODE_STORAGE_KEY, timeDisplayMode);
    } catch {
      // Ignore persistence failures and keep the in-memory choice.
    }
  }, [timeDisplayMode]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.setItem(TRADE_VALUE_DISPLAY_MODE_STORAGE_KEY, tradeValueDisplayMode);
    } catch {
      // Ignore persistence failures and keep the in-memory choice.
    }
  }, [tradeValueDisplayMode]);

  // 当前选中的用户对象
  const selectedUser = useMemo(() => {
    if (!selectedUserId) return null;
    return users.find(u => u.id === selectedUserId) || null;
  }, [selectedUserId, users]);

  const hasActiveLocalFilters =
    searchFilters.keyword.trim().length > 0 ||
    !searchFilters.typeFilters.trade ||
    !searchFilters.typeFilters.transfer ||
    !searchFilters.typeFilters.twitter ||
    searchFilters.minTradeAmountUsd.trim().length > 0 ||
    searchFilters.minTradeMarketCapUsd.trim().length > 0;
  const hasEnabledFeedTypes = hasAnyEnabledFeedType(searchFilters.typeFilters);

  const selectedUserFeed = useMemo(() => {
    if (!selectedUserId) {
      return feed;
    }
    return feed.filter((item) => item.user.id === selectedUserId);
  }, [feed, selectedUserId]);
  const orderedFeed = useMemo(() => {
    if (selectedUserId) {
      return prepareUserFeed(selectedUserFeed);
    }
    return prepareGlobalFeed(selectedUserFeed);
  }, [selectedUserFeed, selectedUserId]);
  const matchedFeed = useMemo(
    () => orderedFeed.filter((item) => matchesFeedSearchFilters(item, searchFilters)),
    [orderedFeed, searchFilters]
  );
  const filteredFeed = useMemo(() => {
    if (!selectedUserId) return matchedFeed.slice(0, globalVisibleCount);
    return matchedFeed.slice(0, selectedUserVisibleCount);
  }, [selectedUserId, matchedFeed, globalVisibleCount, selectedUserVisibleCount]);
  const isInitialLoading = loading && feed.length === 0;
  const showGlobalCompletenessWindow = shouldShowGlobalCompletenessWindow({
    selectedUserId,
    completenessWindow,
  });

  const visibleUserIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of matchedFeed) {
      ids.add(item.user.id);
    }
    return ids;
  }, [matchedFeed]);

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

    if (hasActiveLocalFilters) {
      return sorted.filter((user) => visibleUserIds.has(user.id));
    }

    return sorted;
  }, [users, sidebarSortMode, latestActivityAtByUser, hasActiveLocalFilters, visibleUserIds]);

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
        targetCount: MIN_SELECTED_USER_FEED_ITEMS,
        selectedUserId: user.id,
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
          : result.selectedFeedLength < MIN_SELECTED_USER_FEED_ITEMS
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
    void refetch({ selectedUserId: null, syncStrategy: 'local' });
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
      if (matchedFeed.length >= nextVisibleCount) {
        setExpandFeedback(`已从缓存展开到 ${Math.min(nextVisibleCount, matchedFeed.length)}/${matchedFeed.length} 条`);
        return;
      }
    } else {
      setGlobalVisibleCount(nextVisibleCount);
      if (matchedFeed.length >= nextVisibleCount) {
        setExpandFeedback(`已从缓存展开到 ${Math.min(nextVisibleCount, matchedFeed.length)}/${matchedFeed.length} 条`);
        return;
      }
    }

    if (hasMore) {
      setIsExpanding(true);
      setExpandFeedback('正在从本地库加载更多动态...');
      const localResult = await refetch({
        targetCount: nextVisibleCount,
        selectedUserId,
        syncStrategy: 'local',
      });
      setIsExpanding(false);

      if (!localResult.success) {
        setExpandFeedback(localResult.error ? `本地读取失败：${localResult.error}` : '本地读取失败');
        return;
      }

      const localCount = isSelectedMode ? localResult.selectedFeedLength : localResult.feedLength;
      setExpandFeedback(
        hasActiveLocalFilters
          ? '已刷新本地库，筛选结果已更新'
          : `已从本地库展开到 ${localCount} 条`
      );
      if (localResult.hasMore || (!hasActiveLocalFilters && localCount >= nextVisibleCount)) {
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

    if (hasActiveLocalFilters) {
      setExpandFeedback(`API 拉取完成，筛选结果已更新${autoBackfillSuffix}${partialSuffix}`);
      return;
    }

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
      <TopNav active="feed" />

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
                {showGlobalCompletenessWindow && completenessWindow && (
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-zinc-500">
                    <span>全局完备起点 {completenessWindow.label || '尚未建立'}</span>
                    <span className={completenessWindow.complete ? 'text-emerald-400' : 'text-amber-400'}>
                      {completenessWindow.complete ? '已对齐' : '部分对齐'}
                    </span>
                  </div>
                )}
              </div>
            )}

            {prewarmLabel && (
              <div className="mb-4 flex flex-col gap-2 rounded-lg border border-zinc-800/60 bg-zinc-900/50 p-3 text-xs text-zinc-400 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="truncate">{prewarmLabel}</div>
                  {lastUpdate ? (
                    <div className="text-[11px] text-zinc-500">
                      更新于 {lastUpdate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <div className="inline-flex rounded-md border border-zinc-700 bg-zinc-950/70 p-0.5">
                    <button
                      type="button"
                      onClick={() => setTradeValueDisplayMode('native')}
                      className={`rounded px-2.5 py-1 transition-colors ${
                        tradeValueDisplayMode === 'native'
                          ? 'bg-zinc-700 text-zinc-100'
                          : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                      }`}
                    >
                      原生计价
                    </button>
                    <button
                      type="button"
                      onClick={() => setTradeValueDisplayMode('usd')}
                      className={`rounded px-2.5 py-1 transition-colors ${
                        tradeValueDisplayMode === 'usd'
                          ? 'bg-zinc-700 text-zinc-100'
                          : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                      }`}
                    >
                      USD计价
                    </button>
                  </div>
                  <div className="inline-flex rounded-md border border-zinc-700 bg-zinc-950/70 p-0.5">
                    <button
                      type="button"
                      onClick={() => setTimeDisplayMode('relative')}
                      className={`rounded px-2.5 py-1 transition-colors ${
                        timeDisplayMode === 'relative'
                          ? 'bg-zinc-700 text-zinc-100'
                          : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                      }`}
                    >
                      相对时间
                    </button>
                    <button
                      type="button"
                      onClick={() => setTimeDisplayMode('absolute')}
                      className={`rounded px-2.5 py-1 transition-colors ${
                        timeDisplayMode === 'absolute'
                          ? 'bg-zinc-700 text-zinc-100'
                          : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                      }`}
                    >
                      精确时间
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="relative mb-4 rounded-lg border border-zinc-800/60 bg-zinc-900/50 p-3">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={searchFilters.keyword}
                  onChange={(event) => {
                    setSearchFilters((current) => ({ ...current, keyword: event.target.value }));
                    resetExpandStateForSearch();
                  }}
                  placeholder="搜索人物名字、推文内容、CA 或地址"
                  className="h-9 border-zinc-700 bg-zinc-950 text-zinc-100 placeholder:text-zinc-500"
                />
                <button
                  type="button"
                  onClick={() => {
                    setSearchFilters(DEFAULT_FEED_SEARCH_FILTERS);
                    resetExpandStateForSearch();
                  }}
                  className="h-9 rounded border border-zinc-700 px-3 text-sm text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
                >
                  清空筛选
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {[
                  ['trade', '交易'],
                  ['transfer', '转账'],
                  ['twitter', '推特'],
                ].map(([key, label]) => {
                  const typedKey = key as keyof FeedSearchFilters['typeFilters'];
                  const active = searchFilters.typeFilters[typedKey];

                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => {
                        setSearchFilters((current) => ({
                          ...current,
                          typeFilters: {
                            ...current.typeFilters,
                            [typedKey]: !current.typeFilters[typedKey],
                          },
                        }));
                        resetExpandStateForSearch();
                      }}
                      className={`rounded border px-3 py-1.5 text-sm transition-colors ${
                        active
                          ? 'border-zinc-600 bg-zinc-700 text-zinc-100'
                          : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              {searchFilters.typeFilters.trade ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <Input
                    value={searchFilters.minTradeAmountUsd}
                    onChange={(event) => {
                      setSearchFilters((current) => ({
                        ...current,
                        minTradeAmountUsd: event.target.value,
                      }));
                      resetExpandStateForSearch();
                    }}
                    placeholder="最低成交金额（USD）"
                    className="h-9 border-zinc-700 bg-zinc-950 text-zinc-100 placeholder:text-zinc-500"
                  />
                  <Input
                    value={searchFilters.minTradeMarketCapUsd}
                    onChange={(event) => {
                      setSearchFilters((current) => ({
                        ...current,
                        minTradeMarketCapUsd: event.target.value,
                      }));
                      resetExpandStateForSearch();
                    }}
                    placeholder="最低成交市值"
                    className="h-9 border-zinc-700 bg-zinc-950 text-zinc-100 placeholder:text-zinc-500"
                  />
                </div>
              ) : null}
              {searchFilters.typeFilters.trade &&
              (searchFilters.minTradeAmountUsd.trim() || searchFilters.minTradeMarketCapUsd.trim()) ? (
                <p className="mt-2 text-xs text-zinc-500">交易金额和成交市值筛选仅对交易生效</p>
              ) : null}
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

                <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-1.5 text-xs text-zinc-300">
                  <div className="text-zinc-500">动态拆分</div>
                  <div className="text-sm font-medium text-zinc-100">
                    推特 {activityBreakdown?.twitterCount ?? 0} 条 / 交易 {activityBreakdown?.tradeCount ?? 0} 笔
                  </div>
                </div>

                <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-1.5 text-xs text-zinc-300">
                  <div className="text-zinc-500">个人完备起点</div>
                  <div className="text-sm font-medium text-zinc-100">
                    {completenessWindow?.label || '尚未建立'}
                  </div>
                  <div className={`mt-1 text-[11px] ${completenessWindow?.complete ? 'text-emerald-400' : 'text-zinc-500'}`}>
                    {completenessWindow?.complete ? '窗口已建立' : '等待建立窗口'}
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
              ) : !hasEnabledFeedTypes ? (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-300">
                  请至少选择一种类型
                </div>
              ) : matchedFeed.length === 0 && hasActiveLocalFilters ? (
                <div className="space-y-3">
                  <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/50 p-4 text-sm text-zinc-400">
                    {searchFilters.keyword.trim()
                      ? '没有匹配的人物、推文内容、CA 或地址'
                      : '当前筛选条件下没有结果'}
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
              ) : filteredFeed.length > 0 ? (
                <div className="space-y-3">
                  <div className="overflow-hidden rounded-xl border border-zinc-800/70 bg-zinc-950/70">
                  <div className="divide-y divide-zinc-800/70">
                  {filteredFeed.map(({ user, activity }) => (
                    <ActivityCard
                      key={getActivityRenderKey(
                        user.id,
                        activity.id,
                        buildActivityScopedDedupKey(activity, user.id)
                      )}
                      activity={activity}
                      user={user}
                      timeDisplayMode={timeDisplayMode}
                      tradeValueDisplayMode={tradeValueDisplayMode}
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
                        {historyComplete === false && !hasActiveLocalFilters
                          ? `${selectedUser.name} 本地动态不足，正在继续补历史...`
                          : `${selectedUser.name} 暂无动态`}
                      </p>
                      {selectedUserId && !hasActiveLocalFilters && (
                        <p className="mt-2 text-xs text-zinc-600">
                          本地已收录 {localQualifiedCount} 条合格动态
                          {historyComplete === true ? '，历史已补完' : '，历史仍在补齐中'}
                        </p>
                      )}
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
      <FeedDebugPanel
        totalInDatabase={summary?.transactionCount || 0}
        apiFeedLength={feed.length}
        lastUpdate={lastUpdate}
      />
    </div>
  );
}
