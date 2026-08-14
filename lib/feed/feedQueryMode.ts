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
    // 整页消费，绝不截断：截断分支会丢掉本页未消费的匹配项，而游标只能
    // 从「下一页」继续，load-more 时那些匹配项会被永久跳过。
    // desiredCount 是取数预算，超出一点点（最多一页）由调用方窗口裁剪。
    items.push(...pageItems);

    lastPageNextCursor = page.nextCursor;
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
    nextCursor: hasMore ? lastPageNextCursor : null,
  };
}
