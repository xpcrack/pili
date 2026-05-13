'use client';

import { useEffect } from 'react';

const REFRESH_TRIGGER_INTERVAL_MS = 60 * 60 * 1000;

export function useFeedRefreshScheduler(tick: () => Promise<unknown> | void) {
  useEffect(() => {
    const id = setInterval(() => {
      void tick();
    }, REFRESH_TRIGGER_INTERVAL_MS);

    return () => {
      clearInterval(id);
    };
  }, [tick]);
}
