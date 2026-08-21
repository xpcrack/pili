import type { Activity } from '@/types';
import type { ActivityBreakdown, CompletenessWindow } from '@/lib/activitiesApi';
import type { AddressDiagnostic, ActivityFeedSummary } from '@/lib/activityFeed';
import type { User } from '@/types';

export const MAIN_PAGE_ROUTE_PATHS = ['/'] as const;

export type MainPageRoutePath = (typeof MAIN_PAGE_ROUTE_PATHS)[number];

export interface FeedSessionSnapshot {
  feed: Array<{ user: User; activity: Activity }>;
  latestActivityAtByUser: Record<string, number>;
  hasMore: boolean;
  historyComplete: boolean | null;
  localQualifiedCount: number;
  activityBreakdown: ActivityBreakdown | null;
  completenessWindow: CompletenessWindow | null;
  summary: ActivityFeedSummary | null;
  diagnostics: AddressDiagnostic[];
  prewarmLabel: string | null;
  cachedAt: number;
}

export interface MainPageSessionState {
  feed: FeedSessionSnapshot | null;
}

export function isMainPageRoutePath(value: string): value is MainPageRoutePath {
  return (MAIN_PAGE_ROUTE_PATHS as readonly string[]).includes(value);
}

export function createEmptyMainPageSessionState(): MainPageSessionState {
  return {
    feed: null,
  };
}

export function toLatestActivityAtByUserRecord(map: ReadonlyMap<string, number>) {
  const record: Record<string, number> = {};
  for (const [userId, value] of map.entries()) {
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    record[userId] = value;
  }
  return record;
}

export function toLatestActivityAtByUserMap(record: Record<string, number> | null | undefined) {
  const map = new Map<string, number>();
  if (!record || typeof record !== 'object') {
    return map;
  }

  for (const [userId, value] of Object.entries(record)) {
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    map.set(userId, value);
  }
  return map;
}
