/**
 * Quality ranking for the feed, applied on the client over the window already
 * loaded.
 *
 * Deliberately NOT a server-side ORDER BY: `lib/server/eventsRepo.ts` pins the
 * feed query to `idx_events_timestamp` / `idx_events_user_timestamp` with an
 * explicit warning that letting the planner choose costs >25s on the home page.
 * A computed score in ORDER BY would defeat that pin.
 *
 * Recency stays the default sort — realtime is the point of this product.
 * Quality sort is an opt-in view over the same data.
 */

import type { Activity, User } from '@/types';

export interface UserQualitySnapshot {
  userId: string;
  winRate: number | null;
  roundTrips: number;
  realizedPnlUsd: number;
  medianMultiple: number | null;
}

export type FeedSortMode = 'latest' | 'quality';

/** Matches the leaderboard's floor: below this, a win rate is noise. */
export const QUALITY_MIN_ROUND_TRIPS = 10;
/** A person at or above this win rate earns the 高手 badge. */
export const QUALITY_GOOD_WIN_RATE = 0.5;

export function buildQualityIndex(snapshots: UserQualitySnapshot[] | null | undefined) {
  const index = new Map<string, UserQualitySnapshot>();
  for (const snapshot of snapshots || []) {
    if (snapshot?.userId) index.set(snapshot.userId, snapshot);
  }
  return index;
}

/** True when this person has a measured, trustworthy, above-bar win rate. */
export function isHighQualityUser(
  quality: UserQualitySnapshot | undefined,
  minWinRate = QUALITY_GOOD_WIN_RATE
): boolean {
  if (!quality) return false;
  if (quality.roundTrips < QUALITY_MIN_ROUND_TRIPS) return false;
  return quality.winRate != null && quality.winRate >= minWinRate;
}

/**
 * Score one feed row. Higher is better.
 *
 * Entries from proven people with real size, in a sane market-cap range, rank
 * above everything else; rows with no measured trader behind them fall to the
 * bottom rather than being hidden.
 */
export function scoreFeedItem(
  item: { user: User; activity: Activity },
  qualityIndex: Map<string, UserQualitySnapshot>
): number {
  const quality = qualityIndex.get(item.user.id);
  const metadata = item.activity.metadata;

  // Win rate contributes the most; unmeasured people sit at a neutral-low base.
  const winRateScore =
    quality && quality.roundTrips >= QUALITY_MIN_ROUND_TRIPS && quality.winRate != null
      ? quality.winRate
      : 0.2;

  // Sample size damps a lucky streak without letting volume dominate.
  const sampleScore = quality ? Math.min(1, Math.log10(quality.roundTrips + 1) / 2) : 0;

  const usd = typeof metadata.tradeAmountUsdAtTx === 'number' ? metadata.tradeAmountUsdAtTx : 0;
  const sizeScore = usd > 0 ? Math.min(1, Math.log10(usd + 1) / 5) : 0;

  const variant = (metadata.txActionVariant || '').toLowerCase();
  const entryScore = variant === 'open' ? 1 : variant === 'add' ? 0.6 : 0;

  return winRateScore * 3 + sampleScore + sizeScore + entryScore;
}

/**
 * Sort a feed window by quality, keeping recency as the tie-breaker so two
 * equally-scored rows still read newest-first.
 */
export function sortFeedByQuality<T extends { user: User; activity: Activity }>(
  items: T[],
  qualityIndex: Map<string, UserQualitySnapshot>
): T[] {
  return [...items]
    .map((item, index) => ({ item, index, score: scoreFeedItem(item, qualityIndex) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const timeDelta = b.item.activity.timestamp - a.item.activity.timestamp;
      if (timeDelta !== 0) return timeDelta;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

/** Keep only rows from people whose measured win rate clears the bar. */
export function filterHighQualityOnly<T extends { user: User }>(
  items: T[],
  qualityIndex: Map<string, UserQualitySnapshot>
): T[] {
  return items.filter((item) => isHighQualityUser(qualityIndex.get(item.user.id)));
}
