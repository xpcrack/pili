'use client';

import { useEffect, useRef, useState } from 'react';

import type { UserDetailsSuccessPayload } from '@/lib/userDetails';
import { fetchUserDetails } from '@/lib/userDetailsApi';

interface UseSelectedUserDetailsResult {
  details: UserDetailsSuccessPayload | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  retry: () => void;
}

export function useSelectedUserDetails(selectedUserId: string | null): UseSelectedUserDetailsResult {
  const cacheRef = useRef(new Map<string, UserDetailsSuccessPayload>());
  const [details, setDetails] = useState<UserDetailsSuccessPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (selectedUserId === null) {
      setDetails(null);
      setLoading(false);
      setRefreshing(false);
      setError(null);
      return;
    }

    const userId = selectedUserId;
    const cached = cacheRef.current.get(userId);
    let cancelled = false;

    setDetails(cached ?? null);
    setLoading(!cached);
    setRefreshing(Boolean(cached));
    setError(null);

    void (async () => {
      try {
        const payload = await fetchUserDetails(userId);

        if (cancelled) {
          return;
        }

        cacheRef.current.set(userId, payload);
        setDetails(payload);
        setLoading(false);
        setRefreshing(false);
        setError(null);
      } catch (caughtError) {
        if (cancelled) {
          return;
        }

        setDetails(cached ?? null);
        setLoading(false);
        setRefreshing(false);
        setError(caughtError instanceof Error ? caughtError.message : '读取用户详情失败');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedUserId, retryCount]);

  function retry() {
    setRetryCount((count) => count + 1);
  }

  return {
    details,
    loading,
    refreshing,
    error,
    retry,
  };
}
