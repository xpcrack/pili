'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { UserDetailsSuccessPayload } from '@/lib/userDetails';
import { fetchUserDetails } from '@/lib/userDetailsApi';

/** Poll interval while a user is selected so trade-triggered holdings updates show up. */
export const SELECTED_USER_DETAILS_POLL_MS = 20_000;

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
  const selectedUserIdRef = useRef(selectedUserId);
  selectedUserIdRef.current = selectedUserId;

  const loadUser = useCallback(async (userId: string, mode: 'initial' | 'poll') => {
    const cached = cacheRef.current.get(userId) ?? null;

    if (mode === 'initial') {
      const pendingState = createSelectedUserDetailsPendingState(cached);
      setDetails(pendingState.details);
      setLoading(pendingState.loading);
      setRefreshing(Boolean(cached));
      setError(pendingState.error);
    } else {
      // Soft poll: keep showing cache, mark refreshing, don't flash empty.
      setRefreshing(true);
    }

    try {
      const payload = await fetchUserDetails(userId);
      if (selectedUserIdRef.current !== userId) {
        return;
      }
      cacheRef.current.set(userId, payload);
      const successState = createSelectedUserDetailsSuccessState(payload);
      setDetails(successState.details);
      setLoading(successState.loading);
      setRefreshing(successState.refreshing);
      setError(successState.error);
    } catch (caughtError) {
      if (selectedUserIdRef.current !== userId) {
        return;
      }
      const errorState = createSelectedUserDetailsErrorState(
        cached,
        caughtError instanceof Error ? caughtError.message : '读取用户详情失败'
      );
      setDetails(errorState.details);
      setLoading(errorState.loading);
      setRefreshing(errorState.refreshing);
      // Soft-poll failures should not clobber a good cache with a sticky error banner.
      if (mode === 'initial' || !cached) {
        setError(errorState.error);
      }
    }
  }, []);

  useEffect(() => {
    if (selectedUserId === null) {
      const clearedState = createSelectedUserDetailsClearedState();
      setDetails(clearedState.details);
      setLoading(clearedState.loading);
      setRefreshing(clearedState.refreshing);
      setError(clearedState.error);
      return;
    }

    void loadUser(selectedUserId, 'initial');
  }, [selectedUserId, retryCount, loadUser]);

  // Soft-poll while selected so trade-triggered holdings land without re-select.
  useEffect(() => {
    if (selectedUserId === null) {
      return;
    }

    const userId = selectedUserId;
    const timer = setInterval(() => {
      void loadUser(userId, 'poll');
    }, SELECTED_USER_DETAILS_POLL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [selectedUserId, loadUser]);

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
