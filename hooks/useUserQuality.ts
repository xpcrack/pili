'use client';

import { useEffect, useState } from 'react';

import { buildQualityIndex, type UserQualitySnapshot } from '@/lib/feedQuality';

const QUALITY_CACHE_TTL_MS = 30 * 60 * 1000;
type QualityIndex = ReturnType<typeof buildQualityIndex>;
let qualityCache: { index: QualityIndex; expiresAt: number } | null = null;
let qualityInFlight: Promise<QualityIndex | null> | null = null;

async function fetchQualityIndex(): Promise<QualityIndex | null> {
  const response = await fetch('/api/ranking', { cache: 'no-store' });
  const payload = await response.json();
  if (!payload?.ok || !Array.isArray(payload.rows)) return null;
  return buildQualityIndex(payload.rows as UserQualitySnapshot[]);
}

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

    const now = Date.now();
    if (qualityCache && qualityCache.expiresAt > now) {
      setIndex(qualityCache.index);
    } else {
      if (!qualityInFlight) {
        qualityInFlight = fetchQualityIndex()
          .then((next) => {
            if (next) qualityCache = { index: next, expiresAt: Date.now() + QUALITY_CACHE_TTL_MS };
            return next;
          })
          .catch(() => null)
          .finally(() => {
            qualityInFlight = null;
          });
      }
      void qualityInFlight.then((next) => {
        if (!cancelled && next) setIndex(next);
      });
    }

    return () => {
      cancelled = true;
    };
  }, []);

  return index;
}
