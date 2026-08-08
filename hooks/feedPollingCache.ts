import type { FeedPollingAction } from './feedPollingState';
import type { GlobalFeedCache, GlobalFeedCacheInput } from './feedPollingTypes';

export function captureGlobalFeedCache(params: GlobalFeedCacheInput): GlobalFeedCache {
  return {
    ...params,
    feed: params.feed.slice(),
    latestActivityAtByUser: new Map(params.latestActivityAtByUser),
    userActivities: new Map(params.userActivities),
  };
}

export function restoreGlobalFeedCache(cache: GlobalFeedCache): Extract<FeedPollingAction, { type: 'apply_success' }> {
  return {
    type: 'apply_success',
    feed: cache.feed,
    userActivities: cache.userActivities,
    latestActivityAtByUser: cache.latestActivityAtByUser,
    hasMore: cache.hasMore,
    historyComplete: cache.historyComplete,
    localQualifiedCount: cache.localQualifiedCount,
    activityBreakdown: cache.activityBreakdown,
    completenessWindow: cache.completenessWindow,
    summary: cache.summary,
    diagnostics: cache.diagnostics,
    prewarmLabel: cache.prewarmLabel,
    clearLoading: true,
  };
}
