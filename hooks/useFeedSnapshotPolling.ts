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
    let lastSuccessfulTickAt = 0;

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
        lastSuccessfulTickAt = Date.now();
        scheduleNext(BASE_INTERVAL_MS);
      } catch {
        failCount += 1;
        scheduleNext(backoffWithJitter(failCount));
      }
    }

    function onVisibilityChange() {
      if (!cancelled && typeof document !== 'undefined' && !document.hidden) {
        // A short tab switch should not create an extra request; a stale tab
        // gets exactly one catch-up poll and then returns to the normal cadence.
        const stale = lastSuccessfulTickAt === 0 || Date.now() - lastSuccessfulTickAt >= BASE_INTERVAL_MS;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (stale) void runTick();
        else scheduleNext(Math.max(0, BASE_INTERVAL_MS - (Date.now() - lastSuccessfulTickAt)));
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
