'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { User } from '@/types';
import { UserBar } from '@/components/UserBar';
import { ActivityCard } from '@/components/ActivityCard';
import { FeedDebugPanel } from '@/components/FeedDebugPanel';
import {
  SelectedUserDetailsPanel,
  type SelectedUserDetailsPanelProps,
} from '@/components/SelectedUserDetailsPanel';
import { TopNav } from '@/components/TopNav';
import { useActivityPolling } from '@/hooks/useActivityPolling';
import { useIsClient } from '@/hooks/useIsClient';
import { useSelectedUserDetails } from '@/hooks/useSelectedUserDetails';
import { useUserStore } from '@/store/userStore';
import { useUsersDataStore } from '@/store/usersDataStore';
import { User as UserIcon } from 'lucide-react';
import { buildActivityScopedDedupKey } from '@/lib/activityIdentity';
import { shouldShowGlobalCompletenessWindow } from '@/lib/feedCompletenessVisibility';
import { Input } from '@/components/ui/input';
import {
  type FeedSearchFilters,
  DEFAULT_FEED_SEARCH_FILTERS,
  getRemoteFeedSearchKeyword,
  getRemoteFeedSource,
} from '@/lib/smartSearch';
import { buildAddressAliasMap, selectFeedPageState } from '@/lib/feed/feedPageState';
import { FEED_PAGE_BATCH_SIZE } from '@/lib/feed/feedQueryMode';
import {
  normalizeTradeValueDisplayMode,
  type TradeValueDisplayMode,
} from '@/lib/tradeDisplay';
import {
  type FeedTimeDisplayMode,
  normalizeFeedTimeDisplayMode,
} from '@/lib/timeFormat';

const MAX_GLOBAL_FEED_ITEMS = FEED_PAGE_BATCH_SIZE;
const MIN_SELECTED_USER_FEED_ITEMS = FEED_PAGE_BATCH_SIZE;
const FEED_TIME_DISPLAY_MODE_STORAGE_KEY = 'pilipili:feed-time-display-mode';
const TRADE_VALUE_DISPLAY_MODE_STORAGE_KEY = 'pilipili:trade-value-display-mode';

function getActivityRenderKey(userId: string, activityId: string, scopedKey: string) {
  return scopedKey ? `${scopedKey}::${activityId}` : `${userId}:${activityId}`;
}

interface BuildSelectedUserDetailsPanelPropsArgs {
  selectedUser: User | null;
  onBack: () => void;
  matchedFeedCount: number;
  hasMore: boolean;
  activityBreakdown: {
    twitterCount: number;
    tradeCount: number;
  } | null;
  selectedUserDetails: SelectedUserDetailsPanelProps['details'];
  selectedUserDetailsLoading: boolean;
  selectedUserDetailsRefreshing: boolean;
  selectedUserDetailsError: string | null;
  retrySelectedUserDetails: () => void;
}

export function buildSelectedUserDetailsPanelProps({
  selectedUser,
  onBack,
  matchedFeedCount,
  hasMore,
  activityBreakdown,
  selectedUserDetails,
  selectedUserDetailsLoading,
  selectedUserDetailsRefreshing,
  selectedUserDetailsError,
  retrySelectedUserDetails,
}: BuildSelectedUserDetailsPanelPropsArgs): SelectedUserDetailsPanelProps | null {
  if (!selectedUser) {
    return null;
  }

  return {
    selectedUser,
    onBack,
    matchedFeedCount,
    hasMore,
    activityBreakdown,
    details: selectedUserDetails,
    detailsLoading: selectedUserDetailsLoading,
    detailsRefreshing: selectedUserDetailsRefreshing,
    detailsError: selectedUserDetailsError,
    onRetryDetails: retrySelectedUserDetails,
  };
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
  } = useActivityPolling(
    selectedUserId,
    getRemoteFeedSearchKeyword(searchFilters.keyword),
    getRemoteFeedSource(searchFilters.typeFilters),
    searchFilters
  );
  const { dismissNewForUser } = useUserStore();
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);

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
  const {
    details: selectedUserDetails,
    loading: selectedUserDetailsLoading,
    refreshing: selectedUserDetailsRefreshing,
    error: selectedUserDetailsError,
    retry: retrySelectedUserDetails,
  } = useSelectedUserDetails(selectedUserId);

  const {
    matchedFeed,
    filteredFeed,
    visibleUserIds,
    hasActiveLocalFilters,
    hasEnabledFeedTypes,
  } = useMemo(
    () => selectFeedPageState({
      feed,
      selectedUserId,
      searchFilters,
      globalVisibleCount,
      selectedUserVisibleCount,
    }),
    [feed, selectedUserId, searchFilters, globalVisibleCount, selectedUserVisibleCount]
  );
  const isInitialLoading = loading && feed.length === 0;
  const hasAnyActiveFilter = Boolean(selectedUserId) || hasActiveLocalFilters;
  const showGlobalCompletenessWindow = shouldShowGlobalCompletenessWindow({
    selectedUserId,
    completenessWindow,
  });

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

  const addressAliasMap = useMemo(() => buildAddressAliasMap(users), [users]);

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
      setExpandFeedback('正在全库检索该人物动态...');
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
      setExpandFeedback(
        `已加载该人物 ${result.selectedFeedLength} 条动态${partialSuffix}`
      );
      return;
    }

    setSelectedUserVisibleCount(MIN_SELECTED_USER_FEED_ITEMS);
    setIsExpanding(true);
    setExpandFeedback('正在恢复全部动态...');
    const result = await refetch({
      targetCount: MAX_GLOBAL_FEED_ITEMS,
      selectedUserId: null,
      syncStrategy: 'local',
    });
    setIsExpanding(false);
    if (!result.success) {
      setExpandFeedback(result.error ? `读取失败：${result.error}` : '读取失败');
      return;
    }
    setExpandFeedback(result.hasMore ? `已加载 ${result.feedLength} 条动态` : `已显示全部 ${result.feedLength} 条动态`);
  };

  // 返回全部动态
  const handleBackToAll = () => {
    void handleSelectUser(null);
  };

  const selectedUserDetailsPanelProps = buildSelectedUserDetailsPanelProps({
    selectedUser,
    onBack: handleBackToAll,
    matchedFeedCount: matchedFeed.length,
    hasMore,
    activityBreakdown,
    selectedUserDetails,
    selectedUserDetailsLoading,
    selectedUserDetailsRefreshing,
    selectedUserDetailsError,
    retrySelectedUserDetails,
  });

  const handleLoadMore = useCallback(async () => {
    if (isExpanding || loading || !hasMore) {
      return;
    }

    const isSelectedMode = Boolean(selectedUserId);
    const nextVisibleCount = isSelectedMode
      ? selectedUserVisibleCount + FEED_PAGE_BATCH_SIZE
      : globalVisibleCount + FEED_PAGE_BATCH_SIZE;

    if (isSelectedMode) {
      setSelectedUserVisibleCount(nextVisibleCount);
      if (matchedFeed.length >= nextVisibleCount) {
        setExpandFeedback(`已加载 ${Math.min(nextVisibleCount, matchedFeed.length)} 条动态`);
        return;
      }
    } else {
      setGlobalVisibleCount(nextVisibleCount);
      if (matchedFeed.length >= nextVisibleCount) {
        setExpandFeedback(`已加载 ${Math.min(nextVisibleCount, matchedFeed.length)} 条动态`);
        return;
      }
    }

    setIsExpanding(true);
    setExpandFeedback(hasAnyActiveFilter ? '正在检索更多结果...' : '正在加载更多动态...');
    const result = await refetch({
      targetCount: nextVisibleCount,
      selectedUserId,
      syncStrategy: 'local',
    });
    setIsExpanding(false);

    if (!result.success) {
      setExpandFeedback(result.error ? `读取失败：${result.error}` : '读取失败');
      return;
    }
    const loadedCount = isSelectedMode ? result.selectedFeedLength : result.feedLength;
    const partialSuffix = result.partialSyncWarning ? '（部分地址失败，数据可能未完全对齐）' : '';
    setExpandFeedback(
      result.hasMore
        ? `已加载 ${loadedCount} 条动态${partialSuffix}`
        : `已显示全部 ${loadedCount} 条动态${partialSuffix}`
    );
  }, [
    globalVisibleCount,
    hasAnyActiveFilter,
    hasMore,
    isExpanding,
    loading,
    matchedFeed.length,
    refetch,
    selectedUserId,
    selectedUserVisibleCount,
  ]);

  useEffect(() => {
    const node = loadMoreSentinelRef.current;
    if (!node || !hasMore || isInitialLoading) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void handleLoadMore();
        }
      },
      {
        rootMargin: '320px 0px',
      }
    );

    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [handleLoadMore, hasMore, isInitialLoading]);

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
                  ['telegram', 'TG'],
                  ['news', '新闻'],
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

            {selectedUserDetailsPanelProps ? <SelectedUserDetailsPanel {...selectedUserDetailsPanelProps} /> : null}

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
                <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/50 p-4 text-sm text-zinc-400">
                  {searchFilters.keyword.trim()
                    ? '没有匹配的人物、推文内容、CA 或地址'
                    : '当前筛选条件下没有结果'}
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
                  <div ref={loadMoreSentinelRef} className="h-2" />
                  <div className="flex items-center justify-end rounded-lg border border-zinc-800/70 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-400">
                    {expandFeedback && (
                      <span className="mr-3 text-zinc-500">{expandFeedback}</span>
                    )}
                    <span>
                      {isExpanding
                        ? '正在加载更多...'
                        : hasMore
                          ? '滚动到底部继续加载更多'
                          : `已显示全部 ${matchedFeed.length} 条`}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="py-20 text-center">
                  {selectedUser ? (
                    <div>
                      <UserIcon className="mx-auto mb-3 h-12 w-12 text-zinc-600" />
                      <p className="text-zinc-500">{`${selectedUser.name} 暂无动态`}</p>
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
