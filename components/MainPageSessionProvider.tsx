'use client';

import { createContext, useContext, useMemo, useState } from 'react';

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

  const value = useMemo<MainPageSessionContextValue>(
    () => ({
      state,
      setFeedSnapshot: (snapshot) => {
        setState((current) => ({ ...current, feed: snapshot }));
      },
      setManageSnapshot: (snapshot) => {
        setState((current) => ({ ...current, manage: snapshot }));
      },
      setAddressesSnapshot: (snapshot) => {
        setState((current) => ({ ...current, addresses: snapshot }));
      },
      invalidateFeed: () => {
        setState((current) => ({ ...current, feed: null }));
      },
      invalidateManage: () => {
        setState((current) => ({ ...current, manage: null }));
      },
      invalidateAddresses: () => {
        setState((current) => ({ ...current, addresses: null }));
      },
    }),
    [state]
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
