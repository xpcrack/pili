'use client';

import { useEffect, useRef } from 'react';

const BASE_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
const BACKOFF_MULTIPLIER = 2;
const JITTER_RATIO = 0.3;

function backoffWithJitter(failCount: number): number {
  const base = Math.min(BASE_INTERVAL_MS * BACKOFF_MULTIPLIER ** failCount, MAX_BACKOFF_MS);
  const jitter = base * JITTER_RATIO * Math.random();
  return base + jitter;
}

export function useFeedSnapshotPolling(tick: () => Promise<unknown> | void) {
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failCount = 0;

    function scheduleNext(delay: number) {
      if (cancelled) return;
      timer = setTimeout(runTick, delay);
      timer.unref?.();
    }

    async function runTick() {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.hidden) {
        // page hidden: wait for visibilitychange instead of polling
        return;
      }
      try {
        await tickRef.current();
        failCount = 0;
        scheduleNext(BASE_INTERVAL_MS);
      } catch {
        failCount += 1;
        scheduleNext(backoffWithJitter(failCount));
      }
    }

    function onVisibilityChange() {
      if (!cancelled && typeof document !== 'undefined' && !document.hidden) {
        // page just came back: run immediately
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        void runTick();
      }
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    // kick off
    void runTick();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, []);
}
