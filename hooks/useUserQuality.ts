'use client';

import { useEffect, useState } from 'react';

import { buildQualityIndex, type UserQualitySnapshot } from '@/lib/feedQuality';

/**
 * Per-person win rate, fetched once per mount from the leaderboard endpoint.
 *
 * Deliberately NOT bundled into the feed payload: the feed poll path was cut to
 * ~1KB on this branch and these numbers only change when the background PnL
 * task runs (every 30min), so re-sending them on every poll would be pure waste.
 */
export function useUserQuality() {
  const [index, setIndex] = useState(() => buildQualityIndex(null));

  useEffect(() => {
    let cancelled = false;

    void fetch('/api/ranking', { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled || !payload?.ok || !Array.isArray(payload.rows)) return;
        setIndex(buildQualityIndex(payload.rows as UserQualitySnapshot[]));
      })
      // A missing leaderboard must never break the feed — it just means no
      // quality sort is available yet.
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  return index;
}
