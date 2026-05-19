import type { FeedSearchFilters } from '@/lib/smartSearch';
import { hasActiveFeedLocalFilters } from '@/lib/feed/feedPageState';

export const FEED_PAGE_BATCH_SIZE = 200;

export function shouldSearchEntireFeed(params: {
  selectedUserId: string | null;
  searchFilters: FeedSearchFilters;
}) {
  return Boolean(params.selectedUserId) || hasActiveFeedLocalFilters(params.searchFilters);
}

export interface CursorPageResult<T> {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

export async function collectItemsUntilCount<T>(params: {
  desiredCount: number;
  fetchPage: (cursor: string | null) => Promise<CursorPageResult<T>>;
  matcher?: (item: T) => boolean;
}) {
  const desiredCount = Math.max(0, Math.floor(params.desiredCount));
  if (desiredCount === 0) {
    return {
      items: [] as T[],
      hasMore: false,
      pageCount: 0,
    };
  }

  const items: T[] = [];
  let cursor: string | null = null;
  let hasMore = true;
  let pageCount = 0;

  while (hasMore && items.length < desiredCount) {
    const page = await params.fetchPage(cursor);
    pageCount += 1;

    const pageItems = params.matcher ? page.items.filter(params.matcher) : page.items;
    const remaining = desiredCount - items.length;
    const truncated = pageItems.length > remaining;
    items.push(...pageItems.slice(0, remaining));

    if (truncated) {
      return {
        items,
        hasMore: true,
        pageCount,
      };
    }

    hasMore = page.hasMore;
    cursor = page.nextCursor;

    if (!cursor) {
      hasMore = false;
    }
  }

  return {
    items,
    hasMore,
    pageCount,
  };
}
