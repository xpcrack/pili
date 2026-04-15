'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { User, Activity } from '@/types';
import { fetchAllActivities } from '@/lib/activitiesApi';
import { type ActivityFeedSummary, type AddressDiagnostic } from '@/lib/activityFeed';
import { useUserStore } from '@/store/userStore';
import { useUsersDataStore } from '@/store/usersDataStore';

const POLLING_INTERVAL = 60 * 60 * 1000; // 1小时
const RETRY_INTERVAL = 10 * 1000; // 10秒失败重试

interface UseActivityPollingReturn {
  feed: { user: User; activity: Activity }[];
  userActivities: Map<string, Activity[]>;
  loading: boolean;
  error: string | null;
  refetch: () => void;
  lastUpdate: Date | null;
  summary: ActivityFeedSummary | null;
  diagnostics: AddressDiagnostic[];
}

export function useActivityPolling(): UseActivityPollingReturn {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<{ user: User; activity: Activity }[]>([]);
  const [userActivities, setUserActivities] = useState<Map<string, Activity[]>>(new Map());
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [summary, setSummary] = useState<ActivityFeedSummary | null>(null);
  const [diagnostics, setDiagnostics] = useState<AddressDiagnostic[]>([]);
  
  const { checkAndUpdateNewStatus } = useUserStore();
  const { users } = useUsersDataStore();
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const retryRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(false);
  const requestIdRef = useRef(0);
  const isFetchingRef = useRef(false);
  const pendingRefetchRef = useRef(false);
  const usersRef = useRef(users);
  const usersFingerprintRef = useRef('');
  const usersFingerprint = useMemo(
    () => users.map((user) => `${user.id}:${user.addresses.length}`).join('|'),
    [users]
  );

  useEffect(() => {
    usersRef.current = users;
  }, [users]);

  // 获取并处理活动数据
  const fetchActivities = useCallback(async () => {
    if (isFetchingRef.current) {
      pendingRefetchRef.current = true;
      return;
    }

    isFetchingRef.current = true;
    pendingRefetchRef.current = false;
    const requestId = ++requestIdRef.current;
    const currentUsers = usersRef.current;

    if (retryRef.current) {
      clearTimeout(retryRef.current);
      retryRef.current = null;
    }

    try {
      if (isMountedRef.current) {
        setLoading(true);
      }

      if (currentUsers.length === 0) {
        if (!isMountedRef.current || requestId !== requestIdRef.current) {
          return;
        }

        setFeed([]);
        setUserActivities(new Map());
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
        setLastUpdate(new Date());
        setError(null);
        return;
      }

      const result = await fetchAllActivities(currentUsers);
      const newFeed = result.feed;

      if (!isMountedRef.current || requestId !== requestIdRef.current) {
        return;
      }

      setFeed(newFeed);
      setSummary(result.summary);
      setDiagnostics(result.diagnostics);
      
      // 聚合每个用户的活动
      const activitiesByUser = new Map<string, Activity[]>();
      newFeed.forEach(({ user, activity }) => {
        const existing = activitiesByUser.get(user.id) || [];
        activitiesByUser.set(user.id, [...existing, activity]);
      });
      setUserActivities(activitiesByUser);
      
      // 更新每个用户的红点状态
      activitiesByUser.forEach((activities, userId) => {
        const sorted = [...activities].sort((a, b) => b.timestamp - a.timestamp);
        const latestTime = sorted[0]?.timestamp || 0;
        checkAndUpdateNewStatus(userId, latestTime);
      });
      
      setLastUpdate(new Date());
      setError(null);
    } catch (err) {
      if (!isMountedRef.current || requestId !== requestIdRef.current) {
        return;
      }

      setError(err instanceof Error ? err.message : '获取数据失败');
      console.warn('轮询重试:', err);

      retryRef.current = setTimeout(() => {
        if (isMountedRef.current) {
          void fetchActivities();
        }
      }, RETRY_INTERVAL);
    } finally {
      isFetchingRef.current = false;
      if (isMountedRef.current && requestId === requestIdRef.current) {
        setLoading(false);
      }

      if (pendingRefetchRef.current && isMountedRef.current) {
        pendingRefetchRef.current = false;
        void fetchActivities();
      }
    }
  }, [checkAndUpdateNewStatus]);

  // 初始获取
  useEffect(() => {
    isMountedRef.current = true;
    usersFingerprintRef.current = usersRef.current
      .map((user) => `${user.id}:${user.addresses.length}`)
      .join('|');
    void fetchActivities();

    return () => {
      isMountedRef.current = false;
      requestIdRef.current += 1;
      if (retryRef.current) {
        clearTimeout(retryRef.current);
        retryRef.current = null;
      }
    };
  }, [fetchActivities]);

  useEffect(() => {
    if (!isMountedRef.current) {
      return;
    }

    if (usersFingerprint === usersFingerprintRef.current) {
      return;
    }

    usersFingerprintRef.current = usersFingerprint;
    void fetchActivities();
  }, [usersFingerprint, fetchActivities]);

  // 设置轮询
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      void fetchActivities();
    }, POLLING_INTERVAL);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchActivities]);

  return {
    feed,
    userActivities,
    loading,
    error,
    refetch: () => {
      if (retryRef.current) {
        clearTimeout(retryRef.current);
        retryRef.current = null;
      }
      void fetchActivities();
    },
    lastUpdate,
    summary,
    diagnostics,
  };
}
