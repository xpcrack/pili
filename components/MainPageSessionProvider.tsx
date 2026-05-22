'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

import {
  createEmptyMainPageSessionState,
  type AddressesSessionSnapshot,
  type FeedSessionSnapshot,
  type MainPageSessionState,
  type ManageSessionSnapshot,
} from '@/lib/mainPageSession';

interface MainPageSessionContextValue {
  state: MainPageSessionState;
  setFeedSnapshot: (snapshot: FeedSessionSnapshot | null) => void;
  setManageSnapshot: (snapshot: ManageSessionSnapshot | null) => void;
  setAddressesSnapshot: (snapshot: AddressesSessionSnapshot | null) => void;
  invalidateFeed: () => void;
  invalidateManage: () => void;
  invalidateAddresses: () => void;
}

const MainPageSessionContext = createContext<MainPageSessionContextValue | null>(null);

export function MainPageSessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<MainPageSessionState>(() => createEmptyMainPageSessionState());

  const setFeedSnapshot = useCallback((snapshot: FeedSessionSnapshot | null) => {
    setState((current) => {
      if (current.feed === snapshot) {
        return current;
      }
      return { ...current, feed: snapshot };
    });
  }, []);

  const setManageSnapshot = useCallback((snapshot: ManageSessionSnapshot | null) => {
    setState((current) => {
      if (current.manage === snapshot) {
        return current;
      }
      return { ...current, manage: snapshot };
    });
  }, []);

  const setAddressesSnapshot = useCallback((snapshot: AddressesSessionSnapshot | null) => {
    setState((current) => {
      if (current.addresses === snapshot) {
        return current;
      }
      return { ...current, addresses: snapshot };
    });
  }, []);

  const invalidateFeed = useCallback(() => {
    setState((current) => {
      if (!current.feed) {
        return current;
      }
      return { ...current, feed: null };
    });
  }, []);

  const invalidateManage = useCallback(() => {
    setState((current) => {
      if (!current.manage) {
        return current;
      }
      return { ...current, manage: null };
    });
  }, []);

  const invalidateAddresses = useCallback(() => {
    setState((current) => {
      if (!current.addresses) {
        return current;
      }
      return { ...current, addresses: null };
    });
  }, []);

  const value = useMemo<MainPageSessionContextValue>(
    () => ({
      state,
      setFeedSnapshot,
      setManageSnapshot,
      setAddressesSnapshot,
      invalidateFeed,
      invalidateManage,
      invalidateAddresses,
    }),
    [
      invalidateAddresses,
      invalidateFeed,
      invalidateManage,
      setAddressesSnapshot,
      setFeedSnapshot,
      setManageSnapshot,
      state,
    ]
  );

  return <MainPageSessionContext.Provider value={value}>{children}</MainPageSessionContext.Provider>;
}

export function useMainPageSession() {
  const context = useContext(MainPageSessionContext);
  if (!context) {
    throw new Error('useMainPageSession must be used within MainPageSessionProvider');
  }
  return context;
}
