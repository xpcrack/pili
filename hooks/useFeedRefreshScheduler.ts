'use client';

import { useEffect, useRef } from 'react';

const REFRESH_TRIGGER_INTERVAL_MS = 60 * 60 * 1000;

export function useFeedRefreshScheduler(tick: () => Promise<unknown> | void) {
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    let running = false;
    let lastRunAt = 0;
    const run = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (running) return;
      running = true;
      lastRunAt = Date.now();
      try {
        await tickRef.current();
      } finally {
        running = false;
      }
    };
    const id = setInterval(() => {
      void run();
    }, REFRESH_TRIGGER_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (document.hidden) return;
      if (Date.now() - lastRunAt >= REFRESH_TRIGGER_INTERVAL_MS) void run();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);
}
