import type { Activity } from '@/types';
import type { ActivityBreakdown, CompletenessWindow } from '@/lib/activitiesApi';
import type { AddressDiagnostic, ActivityFeedSummary } from '@/lib/activityFeed';
import type { User } from '@/types';
import type { AddressManagementRow } from '@/lib/addressManagement';

export const MAIN_PAGE_ROUTE_PATHS = ['/', '/manage', '/addresses'] as const;

export type MainPageRoutePath = (typeof MAIN_PAGE_ROUTE_PATHS)[number];

export interface ManageActivityStatsSnapshot {
  socialCount7d: number;
  walletCount7d: number;
  totalCount7d: number;
  totalCountAll: number;
  avgBuyMarketCap7d: number | null;
}

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

export interface ManageSessionSnapshot {
  users: User[];
  relayCoverageByHandle: Record<string, {
    latestTweetId: string;
    latestLastSeenAtMs: number;
    tweetCount: number;
  }>;
  activityStatsByUserId: Record<string, ManageActivityStatsSnapshot>;
  cachedAt: number;
}

export interface AddressesSessionSnapshot {
  rows: AddressManagementRow[];
  cachedAt: number;
}

export interface MainPageSessionState {
  feed: FeedSessionSnapshot | null;
  manage: ManageSessionSnapshot | null;
  addresses: AddressesSessionSnapshot | null;
}

export function isMainPageRoutePath(value: string): value is MainPageRoutePath {
  return (MAIN_PAGE_ROUTE_PATHS as readonly string[]).includes(value);
}

export function createEmptyMainPageSessionState(): MainPageSessionState {
  return {
    feed: null,
    manage: null,
    addresses: null,
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
