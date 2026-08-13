'use client';

import { useEffect, useCallback, useMemo, useRef, useReducer } from 'react';
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
import { useFeedSnapshotPolling } from './useFeedSnapshotPolling';
import { useFeedRefreshScheduler } from './useFeedRefreshScheduler';
import { useFeedServerBackfill } from './useFeedServerBackfill';
import { toLatestActivityAtByUserMap, toLatestActivityAtByUserRecord } from '@/lib/mainPageSession';
import { captureGlobalFeedCache, restoreGlobalFeedCache } from './feedPollingCache';
import type { FetchActivitiesOptions, GlobalFeedCache } from './feedPollingTypes';
import {
  createInitialFeedPollingState,
  feedPollingReducer,
  type FeedPollingAction,
} from './feedPollingState';

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
  const { state: sessionState, setFeedSnapshot } = useMainPageSession();
  const cachedFeedSnapshot = sessionState.feed;
  const [state, dispatch] = useReducer(
    feedPollingReducer,
    undefined,
    () =>
      createInitialFeedPollingState({
        feed: cachedFeedSnapshot?.feed || [],
        latestActivityAtByUser: toLatestActivityAtByUserMap(
          cachedFeedSnapshot?.latestActivityAtByUser
        ),
        hasMore: cachedFeedSnapshot?.hasMore || false,
        historyComplete: cachedFeedSnapshot?.historyComplete ?? null,
        localQualifiedCount: cachedFeedSnapshot?.localQualifiedCount || 0,
        activityBreakdown: cachedFeedSnapshot?.activityBreakdown || null,
        completenessWindow: cachedFeedSnapshot?.completenessWindow || null,
        summary: cachedFeedSnapshot?.summary || null,
        diagnostics: cachedFeedSnapshot?.diagnostics || [],
        prewarmLabel: cachedFeedSnapshot?.prewarmLabel || null,
      })
  );
  const {
    loading,
    error,
    feed,
    userActivities,
    latestActivityAtByUser,
    lastUpdate,
    summary,
    diagnostics,
    hasMore,
    historyComplete,
    localQualifiedCount,
    activityBreakdown,
    completenessWindow,
    prewarmLabel,
  } = state;

  const { checkAndUpdateNewStatus } = useUserStore();
  const { users, mergeUsersFromServer, upsertUserAssetSnapshot } = useUsersDataStore();
  const isMountedRef = useRef(false);
  const requestIdRef = useRef(0);
  const pendingRefetchRef = useRef(false);
  const pendingRefetchOptionsRef = useRef<FetchActivitiesOptions | undefined>(undefined);
  const arbiterRef = useRef(new FeedRequestArbiter());
  const hydratedFromCacheRef = useRef(false);
  const feedRef = useRef<{ user: User; activity: Activity }[]>(feed);
  const feedRevisionRef = useRef<string | undefined>(undefined);
  /** 已加载窗口末端 cursor，load-more append 用 */
  const feedNextCursorRef = useRef<string | null>(null);
  // 单一 state 镜像：async 回调里读最新值，不用把 state 放进 useCallback deps
  // （否则 callback 身份变化 → mount effect 重跑 → 顶窗 replace 闪烁）。
  const stateRef = useRef(state);
  stateRef.current = state;
  feedRef.current = feed;
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
      hasMore,
      historyComplete,
      localQualifiedCount,
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

  // 进人物页前缓存全局 feed；回「全部动态」先秒开缓存，再 silent 刷新。
  // 公网 pageSize=200 ~2MB / ~20s，硬重拉会贴 25s 超时。
  const globalFeedCacheRef = useRef<GlobalFeedCache | null>(null);

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

    const previousSelectedUserId = activeSelectedUserIdRef.current ?? null;
    // 从全局切到人物：先 stash 当前全局窗口
    if (
      selectedUserId &&
      !previousSelectedUserId &&
      !options?.append &&
      !options?.silent &&
      !options?.poll &&
      feedRef.current.length > 0
    ) {
      globalFeedCacheRef.current = captureGlobalFeedCache({
        feed: feedRef.current.slice(),
        nextCursor: feedNextCursorRef.current,
        hasMore: stateRef.current.hasMore,
        historyComplete: stateRef.current.historyComplete,
        localQualifiedCount: stateRef.current.localQualifiedCount,
        activityBreakdown: stateRef.current.activityBreakdown,
        completenessWindow: stateRef.current.completenessWindow,
        summary: stateRef.current.summary,
        diagnostics: stateRef.current.diagnostics,
        prewarmLabel: stateRef.current.prewarmLabel,
        latestActivityAtByUser: new Map(stateRef.current.latestActivityAtByUser),
        userActivities: new Map(stateRef.current.userActivities),
        revision: feedRevisionRef.current ?? null,
      });
    }

    // 从人物回全局：有缓存则立刻还原，再走 silent 顶窗刷新（不阻塞 UI）
    if (
      !selectedUserId &&
      previousSelectedUserId &&
      !options?.append &&
      !options?.silent &&
      !options?.poll &&
      globalFeedCacheRef.current &&
      globalFeedCacheRef.current.feed.length > 0
    ) {
      const cached = globalFeedCacheRef.current;
      feedRef.current = cached.feed;
      feedNextCursorRef.current = cached.nextCursor;
      if (cached.revision) {
        feedRevisionRef.current = cached.revision;
      }
      dispatch(restoreGlobalFeedCache(cached));
      // 后台 silent 刷新顶窗；失败也不影响已还原的全局视图
      void fetchActivities({
        silent: true,
        poll: true,
        targetCount: FEED_POLL_MAX_TARGET,
        selectedUserId: null,
        syncStrategy: 'local',
      }).catch(() => undefined);
      return {
        feedLength: cached.feed.length,
        selectedFeedLength: cached.feed.length,
        totalAvailable: Math.max(
          cached.feed.length,
          cached.summary?.transactionCount ?? 0,
          cached.localQualifiedCount
        ),
        success: true,
        partialSyncWarning: false,
        autoBackfillRounds: 0,
        hasMore: cached.hasMore,
        historyComplete: cached.historyComplete,
        localQualifiedCount: cached.localQualifiedCount,
      };
    }
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
        totalAvailable: Math.max(feedRef.current.length, (stateRef.current.summary?.transactionCount ?? 0)),
        success: false,
        error: ticket.reason === 'foreground_inflight' ? '请求进行中' : '后台请求跳过',
        partialSyncWarning: false,
        autoBackfillRounds: 0,
        hasMore: stateRef.current.hasMore,
        historyComplete: stateRef.current.historyComplete,
        localQualifiedCount: stateRef.current.localQualifiedCount,
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
        totalAvailable: Math.max(feedRef.current.length, (stateRef.current.summary?.transactionCount ?? 0)),
        success: false,
        error: '请求信号不可用',
        partialSyncWarning: false,
        autoBackfillRounds: 0,
        hasMore: stateRef.current.hasMore,
        historyComplete: stateRef.current.historyComplete,
        localQualifiedCount: stateRef.current.localQualifiedCount,
      };
    }

    try {
      if (isMountedRef.current && !options?.silent) {
        dispatch({ type: 'set_loading', loading: true });
      }

      // 注意：不要用 currentUsers.length === 0 短路返回。全新浏览器（无 zustand
      // persist 缓存）users 为空，短路会让页面永远不发请求、永久空白；服务端
      // /api/feed 响应自带 users 并会通过 mergeUsersFromServer 填充 store。

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
        dispatch({ type: 'set_has_more', hasMore: false });
        return {
          feedLength: feedRef.current.length,
          selectedFeedLength: currentSelectedFeedLength,
          totalAvailable: Math.max(feedRef.current.length, (stateRef.current.summary?.transactionCount ?? 0)),
          success: true,
          partialSyncWarning: false,
          autoBackfillRounds: 0,
          hasMore: false,
          historyComplete: stateRef.current.historyComplete,
          localQualifiedCount: stateRef.current.localQualifiedCount,
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
        // 服务端确认无变化也算一次成功握势：新鲜度指示器要的是「最后联通时间」，
        // 不是「最后变化时间」，否则行情安静时会误报数据过期。
        if (isMountedRef.current && requestId === requestIdRef.current) {
          dispatch({ type: 'touch_ok' });
        }
        return {
          feedLength: feedRef.current.length,
          selectedFeedLength: currentSelectedFeedLength,
          totalAvailable: Math.max(feedRef.current.length, (stateRef.current.summary?.transactionCount ?? 0)),
          success: true,
          partialSyncWarning: false,
          autoBackfillRounds: 0,
          hasMore: stateRef.current.hasMore,
          historyComplete: stateRef.current.historyComplete,
          localQualifiedCount: stateRef.current.localQualifiedCount,
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
          totalAvailable: Math.max(feedRef.current.length, (stateRef.current.summary?.transactionCount ?? 0)),
          success: false,
          error: '请求状态已过期',
          partialSyncWarning: false,
          autoBackfillRounds: 0,
          hasMore: stateRef.current.hasMore,
          historyComplete: stateRef.current.historyComplete,
          localQualifiedCount: stateRef.current.localQualifiedCount,
        };
      }

      usersRef.current = effectiveUsers;
      mergeUsersFromServer(result.users ?? effectiveUsers);
      feedRef.current = mergedFeed;
      // Background poll only merges the top window — never rewind end-of-list pagination.
      if (!isBackgroundRefresh) {
        // 记住下一页起点：append 用 collected.nextCursor；全量重拉也用 collected.nextCursor
        feedNextCursorRef.current = collected.nextCursor ?? result.nextCursor ?? null;
      }

      // Group address assets once instead of re-filtering the full list per user.
      // Poll mode skips addressAssets/userAssets — guard against undefined.
      if (result.addressAssets || result.userAssets) {
        const addressAssetsByUser = new Map<string, typeof result.addressAssets>();
        for (const addressAsset of (result.addressAssets ?? [])) {
          const list = addressAssetsByUser.get(addressAsset.userId);
          if (list) list.push(addressAsset);
          else addressAssetsByUser.set(addressAsset.userId, [addressAsset]);
        }
        for (const userAsset of (result.userAssets ?? [])) {
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
        }
      }

      // 聚合每个用户的活动
      const activitiesByUser = buildActivitiesByUser(mergedFeed);
      let latestMap: Map<string, number> | null = null;
      const latestEntries = Object.entries(result.latestActivityAtByUser || {}).filter(
        ([, ts]) => typeof ts === 'number' && Number.isFinite(ts) && ts > 0
      );
      if (!append && latestEntries.length > 0) {
        latestMap = new Map<string, number>();
        latestEntries.forEach(([userId, ts]) => latestMap!.set(userId, ts as number));
      }

      // 更新每个用户的红点状态
      applyNewStatusForActivities(activitiesByUser);

      const clearLoading = !options?.silent;
      const successPatch: Extract<FeedPollingAction, { type: 'apply_success' }> = {
        type: 'apply_success',
        feed: mergedFeed,
        userActivities: activitiesByUser,
        latestActivityAtByUser: latestMap,
        clearLoading,
      };
      if (!isBackgroundRefresh) {
        successPatch.hasMore = result.hasMore;
        successPatch.localQualifiedCount = append ? mergedFeed.length : result.localQualifiedCount;
      }
      if (!append) {
        successPatch.summary = result.summary;
        successPatch.diagnostics = result.diagnostics;
        successPatch.activityBreakdown = result.activityBreakdown;
        successPatch.completenessWindow = result.completenessWindow;
        successPatch.prewarmLabel =
          typeof result.prewarm?.label === 'string' && result.prewarm.label.trim()
            ? result.prewarm.label
            : null;
        if (!isBackgroundRefresh) {
          successPatch.historyComplete = result.historyComplete;
        }
      }
      dispatch(successPatch);
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
        result.summary?.addressCount === 0 &&
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
          totalAvailable: Math.max(feedRef.current.length, (stateRef.current.summary?.transactionCount ?? 0)),
          success: false,
          error: '请求状态已过期',
          partialSyncWarning: false,
          autoBackfillRounds: 0,
          hasMore: stateRef.current.hasMore,
          historyComplete: stateRef.current.historyComplete,
          localQualifiedCount: stateRef.current.localQualifiedCount,
        };
      }

      const message = err instanceof Error ? err.message : '获取数据失败';
      // Keep last-good feed on transient failures so the trading UI does not blank out.
      dispatch({ type: 'apply_error', error: message, clearLoading: !options?.silent });
      console.warn('拉取失败（保留上次成功数据）:', err);
      return {
        feedLength: feedRef.current.length,
        selectedFeedLength: currentSelectedFeedLength,
        totalAvailable: Math.max(feedRef.current.length, (stateRef.current.summary?.transactionCount ?? 0)),
        success: false,
        error: message,
        partialSyncWarning: false,
        autoBackfillRounds: 0,
        hasMore: stateRef.current.hasMore,
        historyComplete: stateRef.current.historyComplete,
        localQualifiedCount: stateRef.current.localQualifiedCount,
      };
    } finally {
      // loading 已在 apply_success / apply_error 里清掉；这里只兜底 silent=false 的过期路径
      if (
        isMountedRef.current &&
        requestId === requestIdRef.current &&
        !options?.silent &&
        stateRef.current.loading
      ) {
        dispatch({ type: 'set_loading', loading: false });
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

  const setPrewarmLabel = useCallback((label: string) => {
    dispatch({ type: 'set_prewarm_label', prewarmLabel: label });
  }, []);
  useFeedPrewarmTrigger(setPrewarmLabel);

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
