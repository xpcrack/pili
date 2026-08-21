'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

import {
  createEmptyMainPageSessionState,
  type FeedSessionSnapshot,
  type MainPageSessionState,
} from '@/lib/mainPageSession';

interface MainPageSessionContextValue {
  state: MainPageSessionState;
  setFeedSnapshot: (snapshot: FeedSessionSnapshot | null) => void;
  invalidateFeed: () => void;
}

const MainPageSessionContext = createContext<MainPageSessionContextValue | null>(null);

export function MainPageSessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<MainPageSessionState>(() => createEmptyMainPageSessionState());

  const setFeedSnapshot = useCallback((snapshot: FeedSessionSnapshot | null) => {
    setState({ feed: snapshot });
  }, []);

  const invalidateFeed = useCallback(() => {
    setState({ feed: null });
  }, []);

  const value = useMemo<MainPageSessionContextValue>(
    () => ({ state, setFeedSnapshot, invalidateFeed }),
    [state, setFeedSnapshot, invalidateFeed],
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
