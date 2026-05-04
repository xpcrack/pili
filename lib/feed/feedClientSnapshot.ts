import { mergeManageUsersWithServer } from '@/lib/manageUsers';
import {
  filterFeedByExistingUsers,
  mergeFeedItems,
  type FeedItem,
} from '@/lib/feed/feedItemMerge';
import type { ActivityFeedResponse } from '@/lib/activitiesApi';
import type { User } from '@/types';

function buildFallbackSummary(users: User[]) {
  return {
    userCount: users.length,
    addressCount: users.reduce((sum, user) => sum + user.addresses.length, 0),
    transactionCount: 0,
    successfulAddressCount: 0,
    failedAddressCount: 0,
    emptyAddressCount: 0,
    completedAt: 0,
  };
}

export function buildCollectedActivityFeedResult(params: {
  firstPageResult: ActivityFeedResponse | null;
  collectedFeed: FeedItem[];
  currentUsers: User[];
  fullDatabaseSearch: boolean;
  hasMore: boolean;
}): ActivityFeedResponse {
  const { firstPageResult, collectedFeed, currentUsers, fullDatabaseSearch, hasMore } = params;

  if (!firstPageResult) {
    return {
      ok: true,
      feed: [],
      users: currentUsers,
      total: 0,
      page: 1,
      pageSize: 200,
      hasMore: false,
      nextCursor: null,
      historyComplete: null,
      localQualifiedCount: 0,
      activityBreakdown: null,
      completenessWindow: null,
      latestActivityAtByUser: {},
      diagnostics: [],
      summary: buildFallbackSummary(currentUsers),
      addressAssets: [],
      userAssets: [],
    };
  }

  return {
    ok: firstPageResult.ok,
    feed: collectedFeed,
    users: firstPageResult.users,
    total: firstPageResult.total,
    page: firstPageResult.page,
    pageSize: firstPageResult.pageSize,
    hasMore,
    nextCursor: firstPageResult.nextCursor ?? null,
    historyComplete: fullDatabaseSearch ? null : firstPageResult.historyComplete,
    localQualifiedCount: collectedFeed.length,
    activityBreakdown: firstPageResult.activityBreakdown,
    completenessWindow: firstPageResult.completenessWindow,
    latestActivityAtByUser: firstPageResult.latestActivityAtByUser,
    diagnostics: firstPageResult.diagnostics,
    summary: firstPageResult.summary,
    addressAssets: firstPageResult.addressAssets,
    userAssets: firstPageResult.userAssets,
    prewarm: firstPageResult.prewarm,
    sync: firstPageResult.sync,
    syncTrigger: firstPageResult.syncTrigger,
  };
}

export function resolveFeedUsers(currentUsers: User[], resultUsers: User[] | undefined) {
  if (!Array.isArray(resultUsers) || resultUsers.length === 0) {
    return currentUsers;
  }

  return mergeManageUsersWithServer(currentUsers, resultUsers);
}

export function applyServerFeedSnapshot(params: {
  replace: boolean;
  resultFeed: FeedItem[];
  effectiveUsers: User[];
}) {
  const { replace, resultFeed, effectiveUsers } = params;
  const serverSnapshot = replace ? resultFeed : mergeFeedItems([], resultFeed);
  return filterFeedByExistingUsers(serverSnapshot, effectiveUsers);
}
