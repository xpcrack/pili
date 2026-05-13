'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
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
  filterPoisonFromFeed,
} from '@/lib/feed/feedPoisonFilter';
import { FEED_PAGE_BATCH_SIZE, collectItemsUntilCount, shouldSearchEntireFeed } from '@/lib/feed/feedQueryMode';
import { useUserStore } from '@/store/userStore';
import { useUsersDataStore } from '@/store/usersDataStore';
import { useFeedDebugBridge } from './useFeedDebugBridge';
import { useActiveContextRefs } from './useActiveContextRefs';
import { useFeedPrewarmTrigger } from './useFeedPrewarmTrigger';
import { useFeedJudgmentStream } from './useFeedJudgmentStream';
import { useFeedSnapshotPolling } from './useFeedSnapshotPolling';
import { useFeedRefreshScheduler } from './useFeedRefreshScheduler';

const SERVER_BACKFILL_ENDPOINT = '/api/users/import';
const SERVER_BACKFILL_TIMEOUT_MS = 10000;

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
  } = params;

  const collected = await collectItemsUntilCount<{ user: User; activity: Activity }>({
    desiredCount: requestLimit,
    matcher: fullDatabaseSearch
      ? (item) => matchesFeedSearchFilters(item, effectiveSearchFilters)
      : undefined,
    fetchPage: async (cursor) => {
      const pageResult = await fetchAllActivities(currentUsers, {
        page: 1,
        pageSize: FEED_PAGE_BATCH_SIZE,
        cursor,
        userId: selectedUserId,
        search: searchQuery,
        source,
        syncStrategy: pageIndex === 0 ? syncStrategy : 'local',
        backfillScope: pageIndex === 0 && syncStrategy === 'backfill' ? backfillScope : undefined,
        backfillUserId: pageIndex === 0 ? selectedUserId : null,
        signal: ticketSignal,
        reason: buildFeedFetchReason({ syncStrategy, selectedUserId }),
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<{ user: User; activity: Activity }[]>([]);
  const [userActivities, setUserActivities] = useState<Map<string, Activity[]>>(new Map());
  const [latestActivityAtByUser, setLatestActivityAtByUser] = useState<Map<string, number>>(new Map());
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [summary, setSummary] = useState<ActivityFeedSummary | null>(null);
  const [diagnostics, setDiagnostics] = useState<AddressDiagnostic[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [historyComplete, setHistoryComplete] = useState<boolean | null>(null);
  const [localQualifiedCount, setLocalQualifiedCount] = useState(0);
  const [activityBreakdown, setActivityBreakdown] = useState<ActivityBreakdown | null>(null);
  const [completenessWindow, setCompletenessWindow] = useState<CompletenessWindow | null>(null);
  const [prewarmLabel, setPrewarmLabel] = useState<string | null>(null);
  
  const { checkAndUpdateNewStatus } = useUserStore();
  const { users, mergeUsersFromServer, upsertUserAssetSnapshot } = useUsersDataStore();
  const isMountedRef = useRef(false);
  const requestIdRef = useRef(0);
  const pendingRefetchRef = useRef(false);
  const pendingRefetchOptionsRef = useRef<FetchActivitiesOptions | undefined>(undefined);
  const arbiterRef = useRef(new FeedRequestArbiter());
  const hydratedFromCacheRef = useRef(false);
  const serverBackfillAttemptedRef = useRef(false);
  const serverBackfillInFlightRef = useRef(false);
  const feedRef = useRef<{ user: User; activity: Activity }[]>([]);
  const usersRef = useRef(users);
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

  useFeedDebugBridge(feedRef);

  const applyNewStatusForActivities = useCallback(
    (activitiesByUser: Map<string, Activity[]>) => {
      activitiesByUser.forEach((activities, userId) => {
        const sorted = [...activities].sort((a, b) => b.timestamp - a.timestamp);
        const latestTime = sorted[0]?.timestamp || 0;
        checkAndUpdateNewStatus(userId, latestTime);
      });
    },
    [checkAndUpdateNewStatus]
  );

  const backfillLocalUsersToServer = useCallback(async (localUsers: User[], signal?: AbortSignal) => {
    if (serverBackfillInFlightRef.current) {
      return false;
    }

    const usersWithAddresses = localUsers.filter((user) => user.addresses.length > 0);
    if (usersWithAddresses.length === 0) {
      return false;
    }

    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    serverBackfillInFlightRef.current = true;
    const controller = new AbortController();
    let abortedByExternalSignal = false;
    let detachExternalAbortListener: (() => void) | null = null;
    if (signal) {
      if (signal.aborted) {
        abortedByExternalSignal = true;
        controller.abort();
      } else {
        const handleExternalAbort = () => {
          abortedByExternalSignal = true;
          controller.abort();
        };
        signal.addEventListener('abort', handleExternalAbort, { once: true });
        detachExternalAbortListener = () => {
          signal.removeEventListener('abort', handleExternalAbort);
        };
      }
    }
    const timer = setTimeout(() => {
      controller.abort();
    }, SERVER_BACKFILL_TIMEOUT_MS);

    try {
      let response: Response;
      try {
        response = await fetch(SERVER_BACKFILL_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            users: usersWithAddresses,
            replaceExisting: false,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          if (abortedByExternalSignal) {
            throw error;
          }
          throw new Error(`回灌超时（>${SERVER_BACKFILL_TIMEOUT_MS}ms）`);
        }
        throw new Error(error instanceof Error ? error.message : '回灌失败');
      }

      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || `回灌失败（HTTP ${response.status}）`);
      }

      console.info(
        `[useActivityPolling] 已将本地用户回灌到服务端 users=${usersWithAddresses.length}`
      );
      return true;
    } finally {
      clearTimeout(timer);
      detachExternalAbortListener?.();
      serverBackfillInFlightRef.current = false;
    }
  }, []);

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
    const syncStrategy = resolveFeedSyncStrategy(options?.syncStrategy);
    const backfillScope = options?.backfillScope ?? (selectedUserId ? 'user' : 'global');
    const priority = syncStrategy === 'local' ? 'foreground' : 'background';
    const currentSelectedFeedLength = selectedUserId
      ? feedRef.current.filter((item) => item.user.id === selectedUserId).length
      : feedRef.current.length;
    const ticket = arbiterRef.current.start(priority);
    if (!ticket.accepted) {
      if (ticket.reason === 'foreground_inflight' && priority === 'foreground') {
        pendingRefetchRef.current = true;
        pendingRefetchOptionsRef.current = options
          ? { ...options }
          : {
              selectedUserId: activeSelectedUserIdRef.current,
              searchQuery: activeSearchQueryRef.current,
              syncStrategy: 'local',
            };
      }

      return {
        feedLength: feedRef.current.length,
        selectedFeedLength: currentSelectedFeedLength,
        totalAvailable: Math.max(feedRef.current.length, summary?.transactionCount ?? 0),
        success: false,
        error: ticket.reason === 'foreground_inflight' ? '请求进行中' : '后台请求跳过',
        partialSyncWarning: false,
        autoBackfillRounds: 0,
        hasMore,
        historyComplete,
        localQualifiedCount,
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
        totalAvailable: Math.max(feedRef.current.length, summary?.transactionCount ?? 0),
        success: false,
        error: '请求信号不可用',
        partialSyncWarning: false,
        autoBackfillRounds: 0,
        hasMore,
        historyComplete,
        localQualifiedCount,
      };
    }

    try {
      if (isMountedRef.current) {
        setLoading(true);
      }

      if (currentUsers.length === 0) {
        if (!isMountedRef.current || requestId !== requestIdRef.current) {
          return {
            feedLength: feedRef.current.length,
            selectedFeedLength: currentSelectedFeedLength,
            totalAvailable: Math.max(feedRef.current.length, summary?.transactionCount ?? 0),
            success: false,
            error: '请求状态已过期',
            partialSyncWarning: false,
            autoBackfillRounds: 0,
          };
        }

        feedRef.current = [];
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

      const requestLimit = Math.max(targetCount ?? FEED_PAGE_BATCH_SIZE, FEED_PAGE_BATCH_SIZE);
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
      });
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
        replace,
        resultFeed: result.feed,
        effectiveUsers,
      });

      if (!isMountedRef.current || requestId !== requestIdRef.current) {
        return {
          feedLength: feedRef.current.length,
          selectedFeedLength: currentSelectedFeedLength,
          totalAvailable: Math.max(feedRef.current.length, summary?.transactionCount ?? 0),
          success: false,
          error: '请求状态已过期',
          partialSyncWarning: false,
          autoBackfillRounds: 0,
          hasMore,
          historyComplete,
          localQualifiedCount,
        };
      }

      usersRef.current = effectiveUsers;
      mergeUsersFromServer(result.users ?? effectiveUsers);
      feedRef.current = mergedFeed;
      setFeed(mergedFeed);
      setSummary(result.summary);
      setDiagnostics(result.diagnostics);
      setHasMore(result.hasMore);
      setHistoryComplete(result.historyComplete);
      setLocalQualifiedCount(result.localQualifiedCount);
      setActivityBreakdown(result.activityBreakdown);
      setCompletenessWindow(result.completenessWindow);

      // Debug: Check if feed is being filtered by client-side poison detection
      const poisonFilteredFeed = filterPoisonFromFeed(mergedFeed);
      if (poisonFilteredFeed.length !== mergedFeed.length) {
        console.warn('[fetchActivities] 客户端投毒过滤统计:', {
          feedBeforeFilter: mergedFeed.length,
          feedAfterFilter: poisonFilteredFeed.length,
          filteredCount: mergedFeed.length - poisonFilteredFeed.length,
        });
      }
      result.userAssets.forEach((userAsset) => {
        upsertUserAssetSnapshot(userAsset.userId, {
          updatedAt: userAsset.updatedAt,
          addresses: result.addressAssets
            .filter((addressAsset) => addressAsset.userId === userAsset.userId)
            .map((addressAsset) => ({
              address: addressAsset.address,
              totalAssetUsd: addressAsset.totalAssetUsd,
              updatedAt: addressAsset.updatedAt,
            })),
        });
      });

      // 聚合每个用户的活动
      const activitiesByUser = buildActivitiesByUser(mergedFeed);
      setUserActivities(activitiesByUser);
      const latestMap = new Map<string, number>();
      if (result.latestActivityAtByUser) {
        Object.entries(result.latestActivityAtByUser).forEach(([userId, ts]) => {
          if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
            latestMap.set(userId, ts);
          }
        });
      }
      setLatestActivityAtByUser(latestMap);

      // 更新每个用户的红点状态
      applyNewStatusForActivities(activitiesByUser);

      const now = new Date();
      setLastUpdate(now);
      setError(null);
      setPrewarmLabel(
        typeof result.prewarm?.label === 'string' && result.prewarm.label.trim()
          ? result.prewarm.label
          : null
      );
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
        !serverBackfillAttemptedRef.current
      ) {
        try {
          const restored = await backfillLocalUsersToServer(currentUsers, ticket.signal);
          if (restored && isMountedRef.current && requestId === requestIdRef.current) {
            serverBackfillAttemptedRef.current = true;
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
          totalAvailable: Math.max(feedRef.current.length, summary?.transactionCount ?? 0),
          success: false,
          error: '请求状态已过期',
          partialSyncWarning: false,
          autoBackfillRounds: 0,
          hasMore,
          historyComplete,
          localQualifiedCount,
        };
      }

      const message = err instanceof Error ? err.message : '获取数据失败';
      setError(message);
      feedRef.current = [];
      setFeed([]);
      setUserActivities(new Map());
      setLatestActivityAtByUser(new Map());
      setSummary(null);
      setDiagnostics([]);
      setHasMore(false);
      setHistoryComplete(null);
      setLocalQualifiedCount(0);
      console.warn('拉取失败（严格模式，未兜底）:', err);
      return {
        feedLength: feedRef.current.length,
        selectedFeedLength: currentSelectedFeedLength,
        totalAvailable: Math.max(feedRef.current.length, summary?.transactionCount ?? 0),
        success: false,
        error: message,
        partialSyncWarning: false,
        autoBackfillRounds: 0,
        hasMore: false,
        historyComplete: null,
        localQualifiedCount: 0,
      };
    } finally {
      if (isMountedRef.current && requestId === requestIdRef.current) {
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
    hasMore,
    historyComplete,
    localQualifiedCount,
    mergeUsersFromServer,
    summary?.transactionCount,
    upsertUserAssetSnapshot,
  ]);

  // 初始获取 - 先从缓存恢复，再发起请求
  useEffect(() => {
    isMountedRef.current = true;

    hydratedFromCacheRef.current = true;

    usersFingerprintRef.current = usersRef.current
      .map((user) => `${user.id}:${user.addresses.length}`)
      .join('|');
    queryFingerprintRef.current = queryFingerprint;
    void fetchActivities({
      selectedUserId: activeSelectedUserIdRef.current,
      searchQuery: activeSearchQueryRef.current,
      source: activeSourceRef.current,
      syncStrategy: 'local',
    });

    return () => {
      isMountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, [fetchActivities, applyNewStatusForActivities, upsertUserAssetSnapshot]);

  useEffect(() => {
    if (!isMountedRef.current) {
      return;
    }

    if (usersFingerprint === usersFingerprintRef.current) {
      return;
    }

    usersFingerprintRef.current = usersFingerprint;
    serverBackfillAttemptedRef.current = false;
    void fetchActivities({
      replace: true,
      selectedUserId: activeSelectedUserIdRef.current,
      searchQuery: activeSearchQueryRef.current,
      source: activeSourceRef.current,
      syncStrategy: 'local',
    });
  }, [usersFingerprint, fetchActivities]);

  useEffect(() => {
    if (!isMountedRef.current) {
      return;
    }

    if (queryFingerprintRef.current === queryFingerprint) {
      return;
    }

    queryFingerprintRef.current = queryFingerprint;
    void fetchActivities({
      replace: true,
      selectedUserId: activeSelectedUserIdRef.current,
      searchQuery: activeSearchQueryRef.current,
      source: activeSourceRef.current,
      syncStrategy: 'local',
    });
  }, [fetchActivities, queryFingerprint]);

  useFeedSnapshotPolling(() =>
    fetchActivities({
      syncStrategy: 'local',
      selectedUserId: activeSelectedUserIdRef.current,
      searchQuery: activeSearchQueryRef.current,
      source: activeSourceRef.current,
    })
  );

  // 低频后台刷新触发：维持原有周期性全量同步能力。
  useFeedRefreshScheduler(() =>
    fetchActivities({
      syncStrategy: 'refresh',
      selectedUserId: activeSelectedUserIdRef.current,
      searchQuery: activeSearchQueryRef.current,
      source: activeSourceRef.current,
    })
  );

  useFeedPrewarmTrigger(setPrewarmLabel);

  useFeedJudgmentStream(() =>
    fetchActivities({
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
    }) => {
      return fetchActivities({ ...options, replace: true });
    },
    lastUpdate,
    summary,
    diagnostics,
    prewarmLabel,
  };
}
