'use client';

import { useEffect, useRef } from 'react';

const SNAPSHOT_POLL_INTERVAL_MS = 5 * 1000;

export function useFeedSnapshotPolling(tick: () => Promise<unknown> | void) {
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    const id = setInterval(() => {
      void tickRef.current();
    }, SNAPSHOT_POLL_INTERVAL_MS);

    return () => {
      clearInterval(id);
    };
  }, []);
}
