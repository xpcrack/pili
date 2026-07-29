'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { User } from '@/types';
import { UserBar } from '@/components/UserBar';
import { ActivityCard } from '@/components/ActivityCard';
import {
  SelectedUserDetailsPanel,
  type SelectedUserDetailsPanelProps,
} from '@/components/SelectedUserDetailsPanel';
import { TopNav } from '@/components/TopNav';
import { FeedFreshnessIndicator } from '@/components/FeedFreshnessIndicator';
import { useActivityPolling } from '@/hooks/useActivityPolling';
import { useIsClient } from '@/hooks/useIsClient';
import { useSelectedUserDetails } from '@/hooks/useSelectedUserDetails';
import { useTokenInfoPrefetch } from '@/hooks/useTokenInfoPrefetch';
import { useUserStore } from '@/store/userStore';
import { useUsersDataStore } from '@/store/usersDataStore';
import { User as UserIcon } from 'lucide-react';
import { buildActivityScopedDedupKey } from '@/lib/activityIdentity';
import { Input } from '@/components/ui/input';
import {
  type FeedSearchFilters,
  DEFAULT_FEED_SEARCH_FILTERS,
  getRemoteFeedSearchKeyword,
  getRemoteFeedSource,
} from '@/lib/smartSearch';
import { buildAddressAliasMap, selectMatchedFeed } from '@/lib/feed/feedPageState';
import { filterHighQualityOnly, sortFeedByQuality, type FeedSortMode } from '@/lib/feedQuality';
import { useUserQuality } from '@/hooks/useUserQuality';
import { FEED_LOAD_MORE_BATCH_SIZE, FEED_PAGE_BATCH_SIZE } from '@/lib/feed/feedQueryMode';
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
  selectedUserDetails: SelectedUserDetailsPanelProps['details'];
  selectedUserDetailsLoading: boolean;
  selectedUserDetailsRefreshing: boolean;
  selectedUserDetailsError: string | null;
  retrySelectedUserDetails: () => void;
}

export function buildSelectedUserDetailsPanelProps({
  selectedUser,
  onBack,
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
  const [globalVisibleCount, setGlobalVisibleCount] = useState(MAX_GLOBAL_FEED_ITEMS);
  const [selectedUserVisibleCount, setSelectedUserVisibleCount] = useState(MIN_SELECTED_USER_FEED_ITEMS);
  const [isExpanding, setIsExpanding] = useState(false);
  const [expandFeedback, setExpandFeedback] = useState<string | null>(null);
  const [searchFilters, setSearchFilters] = useState<FeedSearchFilters>(DEFAULT_FEED_SEARCH_FILTERS);
  const [timeDisplayMode, setTimeDisplayMode] = useState<FeedTimeDisplayMode>('relative');
  const [tradeValueDisplayMode, setTradeValueDisplayMode] = useState<TradeValueDisplayMode>('usd');
  // 'latest' stays the default — realtime is what this feed is for.
  const [feedSortMode, setFeedSortMode] = useState<FeedSortMode>('latest');
  const [highQualityOnly, setHighQualityOnly] = useState(false);
  const isClient = useIsClient();
  
  const { users } = useUsersDataStore();
  const {
    feed,
    latestActivityAtByUser,
    loading,
    error,
    hasMore,
    activityBreakdown,
    refetch,
    summary,
    lastUpdate,
  } = useActivityPolling(
    selectedUserId,
    getRemoteFeedSearchKeyword(searchFilters.keyword),
    getRemoteFeedSource(searchFilters.typeFilters),
    searchFilters
  );
  const { dismissNewForUser } = useUserStore();
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreInFlightRef = useRef(false);
  const handleLoadMoreRef = useRef<() => void>(() => {});

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
        setTradeValueDisplayMode('usd');
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

  // 排序/合并/仓位推算只依赖数据与筛选条件，滚动加载不触发重算。
  const {
    matchedFeed,
    visibleUserIds,
    hasActiveLocalFilters,
    hasEnabledFeedTypes,
  } = useMemo(
    () => selectMatchedFeed({ feed, selectedUserId, searchFilters }),
    [feed, selectedUserId, searchFilters]
  );
  // Quality ranking runs here, on the window already loaded — the server feed
  // query is index-pinned and must not grow a computed ORDER BY.
  const qualityIndex = useUserQuality();
  const rankedFeed = useMemo(() => {
    if (feedSortMode === 'latest' && !highQualityOnly) return matchedFeed;
    const base = highQualityOnly ? filterHighQualityOnly(matchedFeed, qualityIndex) : matchedFeed;
    return feedSortMode === 'quality' ? sortFeedByQuality(base, qualityIndex) : base;
  }, [matchedFeed, feedSortMode, highQualityOnly, qualityIndex]);

  const visibleCount = selectedUserId ? selectedUserVisibleCount : globalVisibleCount;
  const filteredFeed = useMemo(
    () => rankedFeed.slice(0, visibleCount),
    [rankedFeed, visibleCount]
  );
  // 可见交易批量预取 token logo / 市值，避免每张卡各自打接口
  useTokenInfoPrefetch(filteredFeed);
  const isInitialLoading = loading && feed.length === 0;
  const hasAnyActiveFilter = Boolean(selectedUserId) || hasActiveLocalFilters;

  const sidebarUsers = useMemo(() => {
    // 停用的聪明钱默认隐藏；但当前已选中的保留显示，避免选中后突然消失、切不回来。
    const visible = users.filter(
      (user) => user.monitoringEnabled !== false || user.id === selectedUserId
    );

    const sorted = [...visible];

    sorted.sort((a, b) => {
      if (sidebarSortMode === 'asset') {
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
  }, [users, selectedUserId, sidebarSortMode, latestActivityAtByUser, hasActiveLocalFilters, visibleUserIds]);

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
    selectedUserDetails,
    selectedUserDetailsLoading,
    selectedUserDetailsRefreshing,
    selectedUserDetailsError,
    retrySelectedUserDetails,
  });

  const handleLoadMore = useCallback(async () => {
    if (loadMoreInFlightRef.current || isExpanding || loading || !hasMore) {
      return;
    }

    const isSelectedMode = Boolean(selectedUserId);
    const nextVisibleCount = isSelectedMode
      ? selectedUserVisibleCount + FEED_LOAD_MORE_BATCH_SIZE
      : globalVisibleCount + FEED_LOAD_MORE_BATCH_SIZE;

    if (isSelectedMode) {
      setSelectedUserVisibleCount(nextVisibleCount);
      if (rankedFeed.length >= nextVisibleCount) {
        setExpandFeedback(`已加载 ${Math.min(nextVisibleCount, rankedFeed.length)} 条动态`);
        return;
      }
    } else {
      setGlobalVisibleCount(nextVisibleCount);
      if (rankedFeed.length >= nextVisibleCount) {
        setExpandFeedback(`已加载 ${Math.min(nextVisibleCount, rankedFeed.length)} 条动态`);
        return;
      }
    }

    loadMoreInFlightRef.current = true;
    setIsExpanding(true);
    setExpandFeedback(hasAnyActiveFilter ? '正在检索更多结果...' : '正在加载更多动态...');
    try {
      const result = await refetch({
        targetCount: nextVisibleCount,
        selectedUserId,
        syncStrategy: 'local',
        append: true,
      });

      if (!result.success) {
        if (result.error === '请求进行中') {
          // 与选人路径一致：排队不算硬失败；pending 会带上更大的 targetCount
          setExpandFeedback('请求排队中，完成后会自动继续加载');
          return;
        }
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
    } finally {
      setIsExpanding(false);
      loadMoreInFlightRef.current = false;
    }
  }, [
    globalVisibleCount,
    hasAnyActiveFilter,
    hasMore,
    isExpanding,
    loading,
    rankedFeed.length,
    refetch,
    selectedUserId,
    selectedUserVisibleCount,
  ]);

  handleLoadMoreRef.current = () => {
    void handleLoadMore();
  };

  useEffect(() => {
    const node = loadMoreSentinelRef.current;
    if (!node || !hasMore || isInitialLoading) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          handleLoadMoreRef.current();
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
  }, [hasMore, isInitialLoading]);

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
          <div className="flex min-w-0 items-center gap-2">
            {summary ? (
              <div className="truncate text-[11px] tabular-nums text-zinc-500">
                <span className="text-zinc-300">{summary.userCount}</span> 人
                <span className="mx-1.5 text-zinc-700">·</span>
                <span className="text-zinc-300">{summary.addressCount}</span> 地址
                <span className="mx-1.5 text-zinc-700">·</span>
                <span className="text-zinc-300">{summary.transactionCount}</span> 动态
              </div>
            ) : null}
            <FeedFreshnessIndicator lastUpdate={lastUpdate} />
          </div>
        }
      />

      <div className="mx-auto w-full max-w-7xl px-4 py-6">
        <div className="flex flex-col gap-6 md:flex-row md:items-start">
          <aside className="w-full md:sticky md:top-20 md:w-[230px] md:shrink-0">
            <div className="mb-2 grid grid-cols-2 gap-0.5 rounded-[9px] border border-white/[0.07] bg-black/20 p-0.5">
              <button
                onClick={() => setSidebarSortMode('asset')}
                className={`rounded-[7px] px-1.5 py-1.5 text-[11.5px] transition-colors ${
                  sidebarSortMode === 'asset'
                    ? 'bg-white/[0.08] text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                当前资产
              </button>
              <button
                onClick={() => setSidebarSortMode('recent')}
                className={`rounded-[7px] px-1.5 py-1.5 text-[11.5px] transition-colors ${
                  sidebarSortMode === 'recent'
                    ? 'bg-white/[0.08] text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                最近活跃
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
              ) : rankedFeed.length === 0 && (hasActiveLocalFilters || highQualityOnly) ? (
                <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/50 p-4 text-sm text-zinc-400">
                  {searchFilters.keyword.trim()
                    ? '没有匹配的人物、推文内容、CA 或地址'
                    : highQualityOnly
                      ? '当前窗口内没有高胜率人物的动态，可关掉「只看高手」或去「排行」页看统计口径'
                      : '当前筛选条件下没有结果'}
                </div>
              ) : filteredFeed.length > 0 ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setFeedSortMode((mode) => (mode === 'latest' ? 'quality' : 'latest'))}
                      title={
                        feedSortMode === 'latest'
                          ? '当前按时间倒序，点击改为按人物胜率与交易质量排序'
                          : '当前按质量排序，点击改回时间倒序'
                      }
                      className={`rounded-md px-2 py-1 transition-colors ${
                        feedSortMode === 'quality'
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {feedSortMode === 'quality' ? '按质量' : '最新'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setHighQualityOnly((value) => !value)}
                      title="只保留胜率达标且样本足够的人物动态"
                      className={`rounded-md px-2 py-1 transition-colors ${
                        highQualityOnly
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      只看高手
                    </button>
                    {feedSortMode === 'quality' || highQualityOnly ? (
                      <span className="text-zinc-600">仅对已加载的动态生效</span>
                    ) : null}
                  </div>
                  <div id="feed-list" className="rounded-xl border border-zinc-800/70 bg-zinc-950/70">
                    <div className={searchFilters.typeFilters.trade ? 'min-w-[700px]' : undefined}>
                      {searchFilters.typeFilters.trade ? (
                        <div
                          className="sticky top-14 z-20 grid min-h-[30px] items-center gap-x-1.5 border-b border-white/[0.07] bg-zinc-950 px-3 text-[11px] text-zinc-500 shadow-[0_1px_0_0_rgba(255,255,255,0.06)]"
                          style={{
                            gridTemplateColumns:
                              '28px 100px 120px 48px 68px minmax(72px,1fr) 80px',
                          }}
                        >
                          <div />
                          <div>人物 / 钱包</div>
                          <div>Ticker</div>
                          <div className="text-right">MC</div>
                          <div className="text-right">幅度</div>
                          <button
                            type="button"
                            className="text-left transition-colors hover:text-zinc-300"
                            title={
                              tradeValueDisplayMode === 'usd'
                                ? '当前 USD，点击切换为代币金额'
                                : '当前代币金额，点击切换为 USD'
                            }
                            onClick={() =>
                              setTradeValueDisplayMode((mode) => (mode === 'usd' ? 'native' : 'usd'))
                            }
                          >
                            {tradeValueDisplayMode === 'usd' ? 'USD' : '成交'}
                          </button>
                          <button
                            type="button"
                            className="text-right transition-colors hover:text-zinc-300"
                            title={
                              timeDisplayMode === 'relative'
                                ? '当前相对时间，点击切换为精确时间'
                                : '当前精确时间，点击切换为相对时间'
                            }
                            onClick={() =>
                              setTimeDisplayMode((mode) => (mode === 'relative' ? 'absolute' : 'relative'))
                            }
                          >
                            时间
                          </button>
                        </div>
                      ) : null}
                      <div>
                        {filteredFeed.map(({ user, activity }) => (
                          <div
                            key={getActivityRenderKey(
                              user.id,
                              activity.id,
                              buildActivityScopedDedupKey(activity, user.id)
                            )}
                            className="[content-visibility:auto] [contain-intrinsic-size:auto_44px]"
                          >
                            <ActivityCard
                              activity={activity}
                              user={user}
                              timeDisplayMode={timeDisplayMode}
                              tradeValueDisplayMode={tradeValueDisplayMode}
                              addressAliasMap={addressAliasMap}
                            />
                          </div>
                        ))}
                      </div>
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
                          : `已显示全部 ${rankedFeed.length} 条`}
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
    </div>
  );
}
