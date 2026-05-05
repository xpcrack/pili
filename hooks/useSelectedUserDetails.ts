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

interface SelectedUserDetailsState {
  details: UserDetailsSuccessPayload | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
}

export function createSelectedUserDetailsClearedState(): SelectedUserDetailsState {
  return {
    details: null,
    loading: false,
    refreshing: false,
    error: null,
  };
}

export function createSelectedUserDetailsPendingState(
  cached: UserDetailsSuccessPayload | null
): SelectedUserDetailsState {
  return {
    details: cached,
    loading: !cached,
    refreshing: Boolean(cached),
    error: null,
  };
}

export function createSelectedUserDetailsSuccessState(
  payload: UserDetailsSuccessPayload
): SelectedUserDetailsState {
  return {
    details: payload,
    loading: false,
    refreshing: false,
    error: null,
  };
}

export function createSelectedUserDetailsErrorState(
  cached: UserDetailsSuccessPayload | null,
  error: string
): SelectedUserDetailsState {
  return {
    details: cached,
    loading: false,
    refreshing: false,
    error,
  };
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
      const clearedState = createSelectedUserDetailsClearedState();
      setDetails(clearedState.details);
      setLoading(clearedState.loading);
      setRefreshing(clearedState.refreshing);
      setError(clearedState.error);
      return;
    }

    const userId = selectedUserId;
    const cached = cacheRef.current.get(userId);
    let cancelled = false;

    const pendingState = createSelectedUserDetailsPendingState(cached ?? null);
    setDetails(pendingState.details);
    setLoading(pendingState.loading);
    setRefreshing(Boolean(cached));
    setError(pendingState.error);

    void (async () => {
      try {
        const payload = await fetchUserDetails(userId);

        if (cancelled) {
          return;
        }

        cacheRef.current.set(userId, payload);
        const successState = createSelectedUserDetailsSuccessState(payload);
        setDetails(successState.details);
        setLoading(successState.loading);
        setRefreshing(successState.refreshing);
        setError(successState.error);
      } catch (caughtError) {
        if (cancelled) {
          return;
        }

        const errorState = createSelectedUserDetailsErrorState(
          cached ?? null,
          caughtError instanceof Error ? caughtError.message : '读取用户详情失败'
        );
        setDetails(errorState.details);
        setLoading(errorState.loading);
        setRefreshing(errorState.refreshing);
        setError(errorState.error);
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
