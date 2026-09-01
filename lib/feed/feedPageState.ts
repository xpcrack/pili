import type { Activity, User } from '@/types';
import {
  DEFAULT_FEED_SEARCH_FILTERS,
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
  const defaults = DEFAULT_FEED_SEARCH_FILTERS;
  return (
    searchFilters.keyword.trim().length > 0 ||
    searchFilters.typeFilters.trade !== defaults.typeFilters.trade ||
    searchFilters.typeFilters.transfer !== defaults.typeFilters.transfer ||
    searchFilters.typeFilters.twitter !== defaults.typeFilters.twitter ||
    searchFilters.typeFilters.telegram !== defaults.typeFilters.telegram ||
    searchFilters.typeFilters.fomo !== defaults.typeFilters.fomo ||
    searchFilters.typeFilters.news !== defaults.typeFilters.news ||
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

/**
 * 重活：过滤人物 → 仓位推算/合并排序 → 搜索匹配。
 * 故意不接受 visibleCount，这样滚动加载（只改 visibleCount）不会重跑全量排序合并。
 */
export function selectMatchedFeed(params: {
  feed: FeedPageItem[];
  selectedUserId: string | null;
  searchFilters: FeedSearchFilters;
  /** 只看标星交易员（客户端持久化的手动标星集合） */
  starredOnly?: boolean;
  starredUserIds?: Record<string, boolean>;
}) {
  // 作用域：选中某人→只看该人；否则全局（可选叠加「只看标星」）。
  // 搜索/类型筛选在作用域之上再做，且只在窗口内生效。
  const starredUserIds = params.starredUserIds ?? {};
  let scope = params.feed;
  if (params.selectedUserId) {
    scope = params.feed.filter((item) => item.user.id === params.selectedUserId);
  } else if (params.starredOnly) {
    scope = params.feed.filter((item) => starredUserIds[item.user.id] === true);
  }
  const orderedFeed = params.selectedUserId ? prepareUserFeed(scope) : prepareGlobalFeed(scope);
  const matchedFeed = orderedFeed.filter((item) => matchesFeedSearchFilters(item, params.searchFilters));

  return {
    selectedUserFeed: scope,
    orderedFeed,
    matchedFeed,
    visibleUserIds: new Set(matchedFeed.map((item) => item.user.id)),
    hasActiveLocalFilters: hasActiveFeedLocalFilters(params.searchFilters),
    hasEnabledFeedTypes: hasAnyEnabledFeedType(params.searchFilters.typeFilters),
  };
}

export function selectFeedPageState(params: {
  feed: FeedPageItem[];
  selectedUserId: string | null;
  searchFilters: FeedSearchFilters;
  globalVisibleCount: number;
  selectedUserVisibleCount: number;
  starredOnly?: boolean;
  starredUserIds?: Record<string, boolean>;
}) {
  const matched = selectMatchedFeed(params);
  const visibleCount = params.selectedUserId
    ? params.selectedUserVisibleCount
    : params.globalVisibleCount;

  return {
    ...matched,
    filteredFeed: matched.matchedFeed.slice(0, visibleCount),
  };
}
