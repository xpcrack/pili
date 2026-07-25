'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useMainPageSession } from '@/components/MainPageSessionProvider';
import { User, Activity } from '@/types';
import {
  fetchAllActivities,
  type ActivityBreakdown,
  type ActivityFeedResponse,
  type CompletenessWindow,
} from '@/lib/activitiesApi';
import { FeedRequestArbiter } from '@/lib/feed/requestArbiter';
import { resolveFeedSyncStrategy, type FeedSyncStrategy } from '@/lib/feed/fetchPolicy';
import {
  DEFAULT_FEED_SEARCH_FILTERS,
  type FeedSearchFilters,
  matchesFeedSearchFilters,
} from '@/lib/smartSearch';
import {
  type ActivityFeedSummary,
  type AddressDiagnostic,
} from '@/lib/activityFeed';
import {
  buildActivitiesByUser,
} from '@/lib/feed/feedItemMerge';
import {
  applyServerFeedSnapshot,
  buildCollectedActivityFeedResult,
  resolveFeedUsers,
} from '@/lib/feed/feedClientSnapshot';
import {
  FEED_LOAD_MORE_BATCH_SIZE,
  FEED_PAGE_BATCH_SIZE,
  FEED_POLL_MAX_TARGET,
  collectItemsUntilCount,
  shouldSearchEntireFeed,
} from '@/lib/feed/feedQueryMode';
import { useUserStore } from '@/store/userStore';
import { useUsersDataStore } from '@/store/usersDataStore';
import { useFeedDebugBridge } from './useFeedDebugBridge';
import { useActiveContextRefs } from './useActiveContextRefs';
import { useFeedPrewarmTrigger } from './useFeedPrewarmTrigger';
import { useFeedJudgmentStream } from './useFeedJudgmentStream';
import { useFeedSnapshotPolling } from './useFeedSnapshotPolling';
import { useFeedRefreshScheduler } from './useFeedRefreshScheduler';
import { useFeedServerBackfill } from './useFeedServerBackfill';
import { toLatestActivityAtByUserMap, toLatestActivityAtByUserRecord } from '@/lib/mainPageSession';

interface UseActivityPollingReturn {
  feed: { user: User; activity: Activity }[];
  userActivities: Map<string, Activity[]>;
  latestActivityAtByUser: Map<string, number>;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  historyComplete: boolean | null;
  localQualifiedCount: number;
  activityBreakdown: ActivityBreakdown | null;
  completenessWindow: CompletenessWindow | null;
  refetch: (options?: {
    targetCount?: number;
    selectedUserId?: string | null;
    searchQuery?: string;
    syncStrategy?: FeedSyncStrategy;
    backfillScope?: 'global' | 'user';
    append?: boolean;
  }) => Promise<{
    feedLength: number;
    selectedFeedLength: number;
    totalAvailable: number;
    success: boolean;
    error?: string;
    partialSyncWarning?: boolean;
    autoBackfillRounds?: number;
    hasMore?: boolean;
    historyComplete?: boolean | null;
    localQualifiedCount?: number;
  }>;
  lastUpdate: Date | null;
  summary: ActivityFeedSummary | null;
  diagnostics: AddressDiagnostic[];
  prewarmLabel: string | null;
}

interface FetchActivitiesOptions {
  targetCount?: number;
  selectedUserId?: string | null;
  searchQuery?: string;
  source?: Activity['source'] | null;
  replace?: boolean;
  /** 从 feedNextCursor 追加一页，而不是从顶部重拉 */
  append?: boolean;
  silent?: boolean;
  poll?: boolean;
  revision?: string;
  syncStrategy?: FeedSyncStrategy;
  backfillScope?: 'global' | 'user';
}

function buildFeedFetchReason(params: {
  syncStrategy: FeedSyncStrategy;
  selectedUserId: string | null;
}) {
  const { syncStrategy, selectedUserId } = params;
  if (syncStrategy === 'backfill') {
    return selectedUserId ? 'expand-user-backfill-7d' : 'expand-global-backfill-7d';
  }
  return syncStrategy === 'refresh' ? 'feed-refresh' : 'feed-local-read';
}

async function collectRequestedActivityFeed(params: {
  currentUsers: User[];
  ticketSignal: AbortSignal;
  requestLimit: number;
  selectedUserId: string | null;
  searchQuery: string;
  source: Activity['source'] | null;
  syncStrategy: FeedSyncStrategy;
  backfillScope: 'global' | 'user';
  fullDatabaseSearch: boolean;
  effectiveSearchFilters: FeedSearchFilters;
  poll?: boolean;
  revision?: string;
  startCursor?: string | null;
}) {
  let pageIndex = 0;
  let firstPageResult: ActivityFeedResponse | null = null;
  const {
    currentUsers,
    ticketSignal,
    requestLimit,
    selectedUserId,
    searchQuery,
    source,
    syncStrategy,
    backfillScope,
    fullDatabaseSearch,
    effectiveSearchFilters,
    poll,
    revision,
    startCursor,
  } = params;

  const collected = await collectItemsUntilCount<{ user: User; activity: Activity }>({
    desiredCount: requestLimit,
    startCursor: startCursor ?? null,
    matcher: fullDatabaseSearch
      ? (item) => matchesFeedSearchFilters(item, effectiveSearchFilters)
      : undefined,
    fetchPage: async (cursor) => {
      const pageResult = await fetchAllActivities(currentUsers, {
        page: 1,
        pageSize: requestLimit,
        cursor,
        userId: selectedUserId,
        search: searchQuery,
        source,
        syncStrategy: pageIndex === 0 ? syncStrategy : 'local',
        backfillScope: pageIndex === 0 && syncStrategy === 'backfill' ? backfillScope : undefined,
        backfillUserId: pageIndex === 0 ? selectedUserId : null,
        signal: ticketSignal,
        reason: buildFeedFetchReason({ syncStrategy, selectedUserId }),
        poll: pageIndex === 0 ? poll : false,
        revision: pageIndex === 0 ? revision : undefined,
      });
      pageIndex += 1;
      if (!firstPageResult) {
        firstPageResult = pageResult;
      }
      return {
        items: pageResult.feed,
        hasMore: pageResult.hasMore,
        nextCursor: pageResult.nextCursor ?? null,
      };
    },
  });

  return {
    collected,
    firstPageResult,
  };
}

export function useActivityPolling(
  activeSelectedUserId?: string | null,
  activeSearchQuery?: string,
  activeSource?: Activity['source'] | null,
  activeSearchFilters?: FeedSearchFilters
): UseActivityPollingReturn {
  const { state, setFeedSnapshot } = useMainPageSession();
  const cachedFeedSnapshot = state.feed;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<{ user: User; activity: Activity }[]>(() => cachedFeedSnapshot?.feed || []);
  const [userActivities, setUserActivities] = useState<Map<string, Activity[]>>(() => new Map());
  const [latestActivityAtByUser, setLatestActivityAtByUser] = useState<Map<string, number>>(() =>
    toLatestActivityAtByUserMap(cachedFeedSnapshot?.latestActivityAtByUser)
  );
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [summary, setSummary] = useState<ActivityFeedSummary | null>(() => cachedFeedSnapshot?.summary || null);
  const [diagnostics, setDiagnostics] = useState<AddressDiagnostic[]>(() => cachedFeedSnapshot?.diagnostics || []);
  const [hasMore, setHasMore] = useState(() => cachedFeedSnapshot?.hasMore || false);
  const [historyComplete, setHistoryComplete] = useState<boolean | null>(() => cachedFeedSnapshot?.historyComplete ?? null);
  const [localQualifiedCount, setLocalQualifiedCount] = useState(() => cachedFeedSnapshot?.localQualifiedCount || 0);
  const [activityBreakdown, setActivityBreakdown] = useState<ActivityBreakdown | null>(() => cachedFeedSnapshot?.activityBreakdown || null);
  const [completenessWindow, setCompletenessWindow] = useState<CompletenessWindow | null>(() => cachedFeedSnapshot?.completenessWindow || null);
  const [prewarmLabel, setPrewarmLabel] = useState<string | null>(() => cachedFeedSnapshot?.prewarmLabel || null);
  
  const { checkAndUpdateNewStatus } = useUserStore();
  const { users, mergeUsersFromServer, upsertUserAssetSnapshot } = useUsersDataStore();
  const isMountedRef = useRef(false);
  const requestIdRef = useRef(0);
  const pendingRefetchRef = useRef(false);
  const pendingRefetchOptionsRef = useRef<FetchActivitiesOptions | undefined>(undefined);
  const arbiterRef = useRef(new FeedRequestArbiter());
  const hydratedFromCacheRef = useRef(false);
  const feedRef = useRef<{ user: User; activity: Activity }[]>([]);
  const feedRevisionRef = useRef<string | undefined>(undefined);
  /** 已加载窗口末端 cursor，load-more append 用 */
  const feedNextCursorRef = useRef<string | null>(null);
  // Mirror pagination state for fetchActivities without putting it in useCallback deps
  // (deps on hasMore etc. recreated the callback → remount effect → top-window replace loop).
  const hasMoreRef = useRef(hasMore);
  const historyCompleteRef = useRef(historyComplete);
  const localQualifiedCountRef = useRef(localQualifiedCount);
  const summaryTransactionCountRef = useRef(summary?.transactionCount ?? 0);
  hasMoreRef.current = hasMore;
  historyCompleteRef.current = historyComplete;
  localQualifiedCountRef.current = localQualifiedCount;
  summaryTransactionCountRef.current = summary?.transactionCount ?? 0;
  const usersRef = useRef(users);
  // Stable invoker so mount/poll/query effects do not depend on fetchActivities identity.
  const fetchActivitiesRef = useRef<(options?: FetchActivitiesOptions) => Promise<unknown>>(
    async () => undefined
  );
  const {
    selectedUserIdRef: activeSelectedUserIdRef,
    searchQueryRef: activeSearchQueryRef,
    sourceRef: activeSourceRef,
    searchFiltersRef: activeSearchFiltersRef,
  } = useActiveContextRefs({
    selectedUserId: activeSelectedUserId,
    searchQuery: activeSearchQuery,
    source: activeSource,
    searchFilters: activeSearchFilters,
  });
  const usersFingerprintRef = useRef('');
  const queryFingerprintRef = useRef('');
  const usersFingerprint = useMemo(
    () => users.map((user) => `${user.id}:${user.addresses.length}`).join('|'),
    [users]
  );
  const queryFingerprint = useMemo(
    () =>
      JSON.stringify({
        searchQuery: (activeSearchQuery || '').trim(),
        source: activeSource ?? null,
        searchFilters: activeSearchFilters ?? null,
      }),
    [activeSearchFilters, activeSearchQuery, activeSource]
  );

  useEffect(() => {
    usersRef.current = users;
  }, [users]);

  useEffect(() => {
    if (feed.length === 0) {
      return;
    }

    setFeedSnapshot({
      feed,
      latestActivityAtByUser: toLatestActivityAtByUserRecord(latestActivityAtByUser),
      hasMore: hasMoreRef.current,
      historyComplete: historyCompleteRef.current,
      localQualifiedCount: localQualifiedCountRef.current,
      activityBreakdown,
      completenessWindow,
      summary,
      diagnostics,
      prewarmLabel,
      cachedAt: Date.now(),
    });
  }, [
    activityBreakdown,
    completenessWindow,
    diagnostics,
    feed,
    hasMore,
    historyComplete,
    latestActivityAtByUser,
    localQualifiedCount,
    prewarmLabel,
    setFeedSnapshot,
    summary,
  ]);

  useFeedDebugBridge(feedRef);

  const applyNewStatusForActivities = useCallback(
    (activitiesByUser: Map<string, Activity[]>) => {
      activitiesByUser.forEach((activities, userId) => {
        checkAndUpdateNewStatus(userId, activities[0]?.timestamp || 0);
      });
    },
    [checkAndUpdateNewStatus]
  );

  const {
    backfill: backfillLocalUsersToServer,
    markAttempted: markServerBackfillAttempted,
    resetAttempted: resetServerBackfillAttempted,
    isAttempted: isServerBackfillAttempted,
  } = useFeedServerBackfill();

  // 获取并处理活动数据
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const fetchActivities = useCallback(async (
    options?: FetchActivitiesOptions
  ): Promise<{
    feedLength: number;
    selectedFeedLength: number;
    totalAvailable: number;
    success: boolean;
    error?: string;
    partialSyncWarning?: boolean;
    autoBackfillRounds?: number;
    hasMore?: boolean;
    historyComplete?: boolean | null;
    localQualifiedCount?: number;
    revision?: string;
    unchanged?: boolean;
  }> => {
    const targetCount = options?.targetCount;
    const hasSelectedUserOption =
      options && Object.prototype.hasOwnProperty.call(options, 'selectedUserId');
    const selectedUserId = hasSelectedUserOption
      ? options?.selectedUserId ?? null
      : activeSelectedUserIdRef.current ?? null;
    const searchQuery =
      typeof options?.searchQuery === 'string' ? options.searchQuery.trim() : activeSearchQueryRef.current;
    const source =
      options && Object.prototype.hasOwnProperty.call(options, 'source')
        ? options.source ?? null
        : activeSourceRef.current;
    const replace = options?.replace === true;
    const append = options?.append === true && !replace;
    const syncStrategy = resolveFeedSyncStrategy(options?.syncStrategy);
    const backfillScope = options?.backfillScope ?? (selectedUserId ? 'user' : 'global');
    // silent poll / 后台刷新不抢 load-more、选人、搜索
    const priority =
      options?.silent || options?.poll
        ? 'background'
        : syncStrategy === 'local'
          ? 'foreground'
          : 'background';
    const currentSelectedFeedLength = selectedUserId
      ? feedRef.current.filter((item) => item.user.id === selectedUserId).length
      : feedRef.current.length;
    const ticket = arbiterRef.current.start(priority);
    if (!ticket.accepted) {
      if (ticket.reason === 'foreground_inflight' && priority === 'foreground') {
        const nextOptions: FetchActivitiesOptions = options
          ? { ...options }
          : {
              selectedUserId: activeSelectedUserIdRef.current,
              searchQuery: activeSearchQueryRef.current,
              syncStrategy: 'local',
            };
        const prevOptions = pendingRefetchOptionsRef.current;
        // silent/poll 不覆盖已排队的用户操作（load-more / 选人）
        if (!(pendingRefetchRef.current && (nextOptions.silent || nextOptions.poll))) {
          if (prevOptions?.targetCount != null || nextOptions.targetCount != null) {
            nextOptions.targetCount = Math.max(
              prevOptions?.targetCount ?? 0,
              nextOptions.targetCount ?? 0,
              FEED_PAGE_BATCH_SIZE
            );
          }
          pendingRefetchRef.current = true;
          pendingRefetchOptionsRef.current = nextOptions;
        }
      }

      return {
        feedLength: feedRef.current.length,
        selectedFeedLength: currentSelectedFeedLength,
        totalAvailable: Math.max(feedRef.current.length, summaryTransactionCountRef.current),
        success: false,
        error: ticket.reason === 'foreground_inflight' ? '请求进行中' : '后台请求跳过',
        partialSyncWarning: false,
        autoBackfillRounds: 0,
        hasMore: hasMoreRef.current,
        historyComplete: historyCompleteRef.current,
        localQualifiedCount: localQualifiedCountRef.current,
      };
    }

    pendingRefetchRef.current = false;
    const requestId = ++requestIdRef.current;
    const currentUsers = usersRef.current;
    const ticketSignal = ticket.signal;

    if (!ticketSignal) {
      return {
        feedLength: feedRef.current.length,
        selectedFeedLength: currentSelectedFeedLength,
        totalAvailable: Math.max(feedRef.current.length, summaryTransactionCountRef.current),
        success: false,
        error: '请求信号不可用',
        partialSyncWarning: false,
        autoBackfillRounds: 0,
        hasMore: hasMoreRef.current,
        historyComplete: historyCompleteRef.current,
        localQualifiedCount: localQualifiedCountRef.current,
      };
    }

    try {
      if (isMountedRef.current && !options?.silent) {
        setLoading(true);
      }

      if (currentUsers.length === 0) {
        if (!isMountedRef.current || requestId !== requestIdRef.current) {
          return {
            feedLength: feedRef.current.length,
            selectedFeedLength: currentSelectedFeedLength,
            totalAvailable: Math.max(feedRef.current.length, summaryTransactionCountRef.current),
            success: false,
            error: '请求状态已过期',
            partialSyncWarning: false,
            autoBackfillRounds: 0,
          };
        }

        feedRef.current = [];
        feedNextCursorRef.current = null;
        setFeed([]);
        setUserActivities(new Map());
        setLatestActivityAtByUser(new Map());
        setSummary({
          userCount: 0,
          addressCount: 0,
          transactionCount: 0,
          successfulAddressCount: 0,
          failedAddressCount: 0,
          emptyAddressCount: 0,
          completedAt: Date.now(),
        });
        setDiagnostics([]);
        setHasMore(false);
        setHistoryComplete(null);
        setLocalQualifiedCount(0);
        setActivityBreakdown(null);
        setCompletenessWindow(null);
        setLastUpdate(new Date());
        setError(null);
        return {
          feedLength: 0,
          selectedFeedLength: 0,
          totalAvailable: 0,
          success: true,
          autoBackfillRounds: 0,
          hasMore: false,
          historyComplete: null,
          localQualifiedCount: 0,
        };
      }

      // append：再拉一页（400）；silent/poll：只重拉顶窗；其余：从顶攒到 targetCount
      const isBackgroundRefresh = Boolean(options?.silent || options?.poll) && !replace && !append;
      const requestLimit = append
        ? FEED_LOAD_MORE_BATCH_SIZE
        : isBackgroundRefresh
          ? FEED_POLL_MAX_TARGET
          : Math.max(targetCount ?? 0, FEED_PAGE_BATCH_SIZE);
      const startCursor = append ? feedNextCursorRef.current : null;
      if (append && !startCursor) {
        // 没有下一页 cursor 就不要空转；同步关掉 hasMore，避免 sentinel 死循环
        setHasMore(false);
        return {
          feedLength: feedRef.current.length,
          selectedFeedLength: currentSelectedFeedLength,
          totalAvailable: Math.max(feedRef.current.length, summaryTransactionCountRef.current),
          success: true,
          partialSyncWarning: false,
          autoBackfillRounds: 0,
          hasMore: false,
          historyComplete: historyCompleteRef.current,
          localQualifiedCount: localQualifiedCountRef.current,
        };
      }
      const effectiveSearchFilters = activeSearchFiltersRef.current || DEFAULT_FEED_SEARCH_FILTERS;
      const fullDatabaseSearch = shouldSearchEntireFeed({
        selectedUserId,
        searchFilters: effectiveSearchFilters,
      });
      const { collected, firstPageResult } = await collectRequestedActivityFeed({
        currentUsers,
        ticketSignal,
        requestLimit,
        selectedUserId,
        searchQuery,
        source,
        syncStrategy,
        backfillScope,
        fullDatabaseSearch,
        effectiveSearchFilters,
        poll: options?.poll,
        revision: options?.revision,
        startCursor,
      });
      const pageResponse = firstPageResult as ActivityFeedResponse | null;
      if (pageResponse?.revision) {
        feedRevisionRef.current = pageResponse.revision;
      }
      if (pageResponse?.unchanged) {
        return {
          feedLength: feedRef.current.length,
          selectedFeedLength: currentSelectedFeedLength,
          totalAvailable: Math.max(feedRef.current.length, summaryTransactionCountRef.current),
          success: true,
          partialSyncWarning: false,
          autoBackfillRounds: 0,
          hasMore: hasMoreRef.current,
          historyComplete: historyCompleteRef.current,
          localQualifiedCount: localQualifiedCountRef.current,
        };
      }
      const result = buildCollectedActivityFeedResult({
        firstPageResult,
        collectedFeed: collected.items,
        currentUsers,
        fullDatabaseSearch,
        hasMore: collected.hasMore,
      });
      const autoBackfillRounds = 0;
      const effectiveUsers = resolveFeedUsers(currentUsers, result.users);
      const mergedFeed = applyServerFeedSnapshot({
        // append / silent poll: merge into existing window; normal top load: replace
        replace: !append && !isBackgroundRefresh,
        previousFeed: append || isBackgroundRefresh ? feedRef.current : undefined,
        resultFeed: result.feed,
        effectiveUsers,
      });

      if (!isMountedRef.current || requestId !== requestIdRef.current) {
        return {
          feedLength: feedRef.current.length,
          selectedFeedLength: currentSelectedFeedLength,
          totalAvailable: Math.max(feedRef.current.length, summaryTransactionCountRef.current),
          success: false,
          error: '请求状态已过期',
          partialSyncWarning: false,
          autoBackfillRounds: 0,
          hasMore: hasMoreRef.current,
          historyComplete: historyCompleteRef.current,
          localQualifiedCount: localQualifiedCountRef.current,
        };
      }

      usersRef.current = effectiveUsers;
      mergeUsersFromServer(result.users ?? effectiveUsers);
      feedRef.current = mergedFeed;
      // Background poll only merges the top window — never rewind end-of-list pagination.
      if (!isBackgroundRefresh) {
        // 记住下一页起点：append 用 collected.nextCursor；全量重拉也用 collected.nextCursor
        feedNextCursorRef.current = collected.nextCursor ?? result.nextCursor ?? null;
        setHasMore(result.hasMore);
        setLocalQualifiedCount(append ? mergedFeed.length : result.localQualifiedCount);
      }
      setFeed(mergedFeed);
      if (!append && !isBackgroundRefresh) {
        setSummary(result.summary);
        setDiagnostics(result.diagnostics);
        setHistoryComplete(result.historyComplete);
        setActivityBreakdown(result.activityBreakdown);
        setCompletenessWindow(result.completenessWindow);
      } else if (!append && isBackgroundRefresh) {
        // Top-window poll may still refresh non-pagination meta.
        setSummary(result.summary);
        setDiagnostics(result.diagnostics);
        setActivityBreakdown(result.activityBreakdown);
        setCompletenessWindow(result.completenessWindow);
      }

      // Group address assets once instead of re-filtering the full list per user.
      const addressAssetsByUser = new Map<string, typeof result.addressAssets>();
      for (const addressAsset of result.addressAssets) {
        const list = addressAssetsByUser.get(addressAsset.userId);
        if (list) list.push(addressAsset);
        else addressAssetsByUser.set(addressAsset.userId, [addressAsset]);
      }
      result.userAssets.forEach((userAsset) => {
        const addresses = addressAssetsByUser.get(userAsset.userId) || [];
        upsertUserAssetSnapshot(userAsset.userId, {
          totalAssetUsd: userAsset.totalAssetUsd,
          updatedAt: userAsset.updatedAt,
          addresses: addresses.map((addressAsset) => ({
            address: addressAsset.address,
            totalAssetUsd: addressAsset.totalAssetUsd,
            updatedAt: addressAsset.updatedAt,
          })),
        });
      });

      // 聚合每个用户的活动
      const activitiesByUser = buildActivitiesByUser(mergedFeed);
      setUserActivities(activitiesByUser);
      if (!append) {
        const latestMap = new Map<string, number>();
        if (result.latestActivityAtByUser) {
          Object.entries(result.latestActivityAtByUser).forEach(([userId, ts]) => {
            if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
              latestMap.set(userId, ts);
            }
          });
        }
        setLatestActivityAtByUser(latestMap);
      }

      // 更新每个用户的红点状态
      applyNewStatusForActivities(activitiesByUser);

      const now = new Date();
      setLastUpdate(now);
      setError(null);
      if (!append) {
        setPrewarmLabel(
          typeof result.prewarm?.label === 'string' && result.prewarm.label.trim()
            ? result.prewarm.label
            : null
        );
      }
      const mergedSelectedFeedLength = selectedUserId
        ? mergedFeed.filter((item) => item.user.id === selectedUserId).length
        : mergedFeed.length;
      const partialSyncWarning = Boolean(
        result.sync?.latestRun &&
          typeof result.sync.latestRun.failedAddresses === 'number' &&
          result.sync.latestRun.failedAddresses > 0
      );

      const localAddressCount = currentUsers.reduce((sum, user) => sum + user.addresses.length, 0);
      if (
        result.summary.addressCount === 0 &&
        localAddressCount > 0 &&
        !isServerBackfillAttempted()
      ) {
        try {
          const restored = await backfillLocalUsersToServer(currentUsers, ticket.signal);
          if (restored && isMountedRef.current && requestId === requestIdRef.current) {
            markServerBackfillAttempted();
            pendingRefetchRef.current = true;
            pendingRefetchOptionsRef.current = {
              replace: true,
              syncStrategy: 'local',
              selectedUserId,
              searchQuery,
              source,
            };
          }
        } catch (backfillError) {
          console.warn(
            '[useActivityPolling] 本地地址回灌服务端失败:',
            backfillError instanceof Error ? backfillError.message : backfillError
          );
        }
      }

      return {
        feedLength: mergedFeed.length,
        selectedFeedLength: mergedSelectedFeedLength,
        totalAvailable: mergedFeed.length,
        success: true,
        partialSyncWarning,
        autoBackfillRounds,
        hasMore: result.hasMore,
        historyComplete: result.historyComplete,
        localQualifiedCount: result.localQualifiedCount,
      };
    } catch (err) {
      if (!isMountedRef.current || requestId !== requestIdRef.current) {
        return {
          feedLength: feedRef.current.length,
          selectedFeedLength: currentSelectedFeedLength,
          totalAvailable: Math.max(feedRef.current.length, summaryTransactionCountRef.current),
          success: false,
          error: '请求状态已过期',
          partialSyncWarning: false,
          autoBackfillRounds: 0,
          hasMore: hasMoreRef.current,
          historyComplete: historyCompleteRef.current,
          localQualifiedCount: localQualifiedCountRef.current,
        };
      }

      const message = err instanceof Error ? err.message : '获取数据失败';
      // Keep last-good feed on transient failures so the trading UI does not blank out.
      setError(message);
      console.warn('拉取失败（保留上次成功数据）:', err);
      return {
        feedLength: feedRef.current.length,
        selectedFeedLength: currentSelectedFeedLength,
        totalAvailable: Math.max(feedRef.current.length, summaryTransactionCountRef.current),
        success: false,
        error: message,
        partialSyncWarning: false,
        autoBackfillRounds: 0,
        hasMore: hasMoreRef.current,
        historyComplete: historyCompleteRef.current,
        localQualifiedCount: localQualifiedCountRef.current,
      };
    } finally {
      if (isMountedRef.current && requestId === requestIdRef.current && !options?.silent) {
        setLoading(false);
      }

      ticket.finish();

      if (pendingRefetchRef.current && isMountedRef.current) {
        pendingRefetchRef.current = false;
        const pendingOptions = pendingRefetchOptionsRef.current;
        pendingRefetchOptionsRef.current = undefined;
        void fetchActivities(
          pendingOptions ?? {
            selectedUserId: activeSelectedUserIdRef.current,
            searchQuery: activeSearchQueryRef.current,
          }
        );
      }
    }
  }, [
    applyNewStatusForActivities,
    backfillLocalUsersToServer,
    isServerBackfillAttempted,
    markServerBackfillAttempted,
    mergeUsersFromServer,
    upsertUserAssetSnapshot,
  ]);

  fetchActivitiesRef.current = fetchActivities;

  // 初始获取：只在 mount 跑一次。后续查询/用户变化走下面的 fingerprint effects。
  // 不要依赖 fetchActivities 身份，否则 load-more 更新 state → callback 重建 → 顶窗 replace 闪烁。
  useEffect(() => {
    isMountedRef.current = true;

    hydratedFromCacheRef.current = true;
    feedRef.current = cachedFeedSnapshot?.feed || [];

    usersFingerprintRef.current = usersRef.current
      .map((user) => `${user.id}:${user.addresses.length}`)
      .join('|');
    queryFingerprintRef.current = queryFingerprint;
    void fetchActivitiesRef.current({
      selectedUserId: activeSelectedUserIdRef.current,
      searchQuery: activeSearchQueryRef.current,
      source: activeSourceRef.current,
      syncStrategy: 'local',
    });

    return () => {
      isMountedRef.current = false;
      requestIdRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only init
  }, []);

  useEffect(() => {
    if (!isMountedRef.current) {
      return;
    }

    if (usersFingerprint === usersFingerprintRef.current) {
      return;
    }

    usersFingerprintRef.current = usersFingerprint;
    resetServerBackfillAttempted();
    feedNextCursorRef.current = null;
    void fetchActivitiesRef.current({
      replace: true,
      selectedUserId: activeSelectedUserIdRef.current,
      searchQuery: activeSearchQueryRef.current,
      source: activeSourceRef.current,
      syncStrategy: 'local',
    });
  }, [usersFingerprint, resetServerBackfillAttempted]);

  useEffect(() => {
    if (!isMountedRef.current) {
      return;
    }

    if (queryFingerprintRef.current === queryFingerprint) {
      return;
    }

    queryFingerprintRef.current = queryFingerprint;
    feedNextCursorRef.current = null;
    void fetchActivitiesRef.current({
      replace: true,
      selectedUserId: activeSelectedUserIdRef.current,
      searchQuery: activeSearchQueryRef.current,
      source: activeSourceRef.current,
      syncStrategy: 'local',
    });
  }, [queryFingerprint]);

  useFeedSnapshotPolling(() =>
    fetchActivities({
      silent: true,
      poll: true,
      revision: feedRevisionRef.current,
      targetCount: FEED_POLL_MAX_TARGET,
      syncStrategy: 'local',
      selectedUserId: activeSelectedUserIdRef.current,
      searchQuery: activeSearchQueryRef.current,
      source: activeSourceRef.current,
    })
  );

  // 低频后台刷新触发：维持原有周期性全量同步能力。
  useFeedRefreshScheduler(() =>
    fetchActivities({
      silent: true,
      targetCount: FEED_POLL_MAX_TARGET,
      syncStrategy: 'refresh',
      selectedUserId: activeSelectedUserIdRef.current,
      searchQuery: activeSearchQueryRef.current,
      source: activeSourceRef.current,
    })
  );

  useFeedPrewarmTrigger(setPrewarmLabel);

  useFeedJudgmentStream(() =>
    fetchActivities({
      silent: true,
      targetCount: FEED_POLL_MAX_TARGET,
      selectedUserId: activeSelectedUserIdRef.current,
      searchQuery: activeSearchQueryRef.current,
      source: activeSourceRef.current,
      syncStrategy: 'local',
    })
  );

  return {
    feed,
    userActivities,
    latestActivityAtByUser,
    loading,
    error,
    hasMore,
    historyComplete,
    localQualifiedCount,
    activityBreakdown,
    completenessWindow,
    refetch: (options?: {
      targetCount?: number;
      selectedUserId?: string | null;
      searchQuery?: string;
      syncStrategy?: FeedSyncStrategy;
      backfillScope?: 'global' | 'user';
      append?: boolean;
    }) => {
      if (options?.append) {
        return fetchActivities({ ...options, append: true, replace: false });
      }
      return fetchActivities({ ...options, replace: true });
    },
    lastUpdate,
    summary,
    diagnostics,
    prewarmLabel,
  };
}
