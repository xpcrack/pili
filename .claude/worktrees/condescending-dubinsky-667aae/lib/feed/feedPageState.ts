import type { Activity, User } from '@/types';
import {
  type FeedSearchFilters,
  hasAnyEnabledFeedType,
  matchesFeedSearchFilters,
} from '@/lib/smartSearch';
import { prepareGlobalFeed, prepareUserFeed } from '@/lib/feedOrdering';

export interface FeedPageItem {
  user: User;
  activity: Activity;
}

export function hasActiveFeedLocalFilters(searchFilters: FeedSearchFilters) {
  return (
    searchFilters.keyword.trim().length > 0 ||
    !searchFilters.typeFilters.trade ||
    !searchFilters.typeFilters.transfer ||
    !searchFilters.typeFilters.twitter ||
    !searchFilters.typeFilters.telegram ||
    searchFilters.typeFilters.news ||
    searchFilters.minTradeAmountUsd.trim().length > 0 ||
    searchFilters.minTradeMarketCapUsd.trim().length > 0
  );
}

export function buildAddressAliasMap(users: User[]) {
  const map = new Map<string, string>();
  for (const trackedUser of users) {
    for (const address of trackedUser.addresses) {
      const key = address.address.toLowerCase();
      if (map.has(key)) continue;
      const alias = address.name.startsWith('#')
        ? `${trackedUser.name}${address.name}`
        : `${trackedUser.name}#${address.name}`;
      map.set(key, alias);
    }
  }
  return map;
}

export function selectFeedPageState(params: {
  feed: FeedPageItem[];
  selectedUserId: string | null;
  searchFilters: FeedSearchFilters;
  globalVisibleCount: number;
  selectedUserVisibleCount: number;
}) {
  const selectedUserFeed = params.selectedUserId
    ? params.feed.filter((item) => item.user.id === params.selectedUserId)
    : params.feed;
  const orderedFeed = params.selectedUserId
    ? prepareUserFeed(selectedUserFeed)
    : prepareGlobalFeed(selectedUserFeed);
  const matchedFeed = orderedFeed.filter((item) => matchesFeedSearchFilters(item, params.searchFilters));
  const filteredFeed = params.selectedUserId
    ? matchedFeed.slice(0, params.selectedUserVisibleCount)
    : matchedFeed.slice(0, params.globalVisibleCount);
  const visibleUserIds = new Set(matchedFeed.map((item) => item.user.id));

  return {
    selectedUserFeed,
    orderedFeed,
    matchedFeed,
    filteredFeed,
    visibleUserIds,
    hasActiveLocalFilters: hasActiveFeedLocalFilters(params.searchFilters),
    hasEnabledFeedTypes: hasAnyEnabledFeedType(params.searchFilters.typeFilters),
  };
}
