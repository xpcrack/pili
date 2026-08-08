import type { ActivityBreakdown, CompletenessWindow } from '@/lib/activitiesApi';
import type { ActivityFeedSummary, AddressDiagnostic } from '@/lib/activityFeed';
import type { FeedItem } from './feedPollingState';
import type { FeedSyncStrategy } from '@/lib/feed/fetchPolicy';
import type { Activity } from '@/types';

export interface FetchActivitiesOptions {
  targetCount?: number;
  selectedUserId?: string | null;
  searchQuery?: string;
  source?: Activity['source'] | null;
  replace?: boolean;
  /** 从 feedNextCursor 追加一页，而不是从顶部重拉 */
  append?: boolean;
  silent?: boolean;
  poll?: boolean;
  revision?: string;
  syncStrategy?: FeedSyncStrategy;
  backfillScope?: 'global' | 'user';
}

export interface GlobalFeedCache {
  feed: FeedItem[];
  nextCursor: string | null;
  hasMore: boolean;
  historyComplete: boolean | null;
  localQualifiedCount: number;
  activityBreakdown: ActivityBreakdown | null;
  completenessWindow: CompletenessWindow | null;
  summary: ActivityFeedSummary | null;
  diagnostics: AddressDiagnostic[];
  prewarmLabel: string | null;
  latestActivityAtByUser: Map<string, number>;
  userActivities: Map<string, Activity[]>;
  revision: string | null;
}

export type GlobalFeedCacheInput = Omit<GlobalFeedCache, 'feed' | 'latestActivityAtByUser' | 'userActivities'> & {
  feed: FeedItem[];
  latestActivityAtByUser: ReadonlyMap<string, number>;
  userActivities: ReadonlyMap<string, Activity[]>;
};
