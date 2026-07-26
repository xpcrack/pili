import type { FeedSearchFilters } from '@/lib/smartSearch';
import { hasActiveFeedLocalFilters } from '@/lib/feed/feedPageState';

/** 首屏 / 常规分页 */
export const FEED_PAGE_BATCH_SIZE = 200;
/** 滚到底追加量（服务端 pageSize 上限 200） */
export const FEED_LOAD_MORE_BATCH_SIZE = 200;
/** silent poll 只重拉顶窗，避免随 scrolled depth 线性放大 */
export const FEED_POLL_MAX_TARGET = FEED_PAGE_BATCH_SIZE;

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
  startCursor?: string | null;
}) {
  const desiredCount = Math.max(0, Math.floor(params.desiredCount));
  if (desiredCount === 0) {
    return {
      items: [] as T[],
      hasMore: false,
      pageCount: 0,
      nextCursor: null as string | null,
    };
  }

  const items: T[] = [];
  let cursor: string | null = params.startCursor ?? null;
  let hasMore = true;
  let pageCount = 0;
  let lastPageNextCursor: string | null = null;

  while (hasMore && items.length < desiredCount) {
    const page = await params.fetchPage(cursor);
    pageCount += 1;

    const pageItems = params.matcher ? page.items.filter(params.matcher) : page.items;
    const remaining = desiredCount - items.length;
    const truncated = pageItems.length > remaining;
    items.push(...pageItems.slice(0, remaining));

    lastPageNextCursor = page.nextCursor;
    hasMore = page.hasMore;
    cursor = page.nextCursor;

    if (truncated) {
      // 本页还有未消费条目，下一轮应从本页 nextCursor 之前的位置继续；
      // 当前 load-more 按整页追加，截断时仍标记 hasMore。
      return {
        items,
        hasMore: true,
        pageCount,
        nextCursor: lastPageNextCursor,
      };
    }

    if (!cursor) {
      hasMore = false;
    }
  }

  return {
    items,
    hasMore,
    pageCount,
    nextCursor: hasMore ? lastPageNextCursor : null,
  };
}
