'use client';

import { useEffect } from 'react';

const SNAPSHOT_POLL_INTERVAL_MS = 5 * 1000;

export function useFeedSnapshotPolling(tick: () => Promise<unknown> | void) {
  useEffect(() => {
    const id = setInterval(() => {
      void tick();
    }, SNAPSHOT_POLL_INTERVAL_MS);

    return () => {
      clearInterval(id);
    };
  }, [tick]);
}
