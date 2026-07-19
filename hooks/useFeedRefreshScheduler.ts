'use client';

import { useEffect, useRef } from 'react';

const REFRESH_TRIGGER_INTERVAL_MS = 60 * 60 * 1000;

export function useFeedRefreshScheduler(tick: () => Promise<unknown> | void) {
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    const id = setInterval(() => {
      void tickRef.current();
    }, REFRESH_TRIGGER_INTERVAL_MS);

    return () => {
      clearInterval(id);
    };
  }, []);
}
