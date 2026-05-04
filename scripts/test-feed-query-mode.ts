import assert from 'node:assert/strict';

import { collectItemsUntilCount, FEED_PAGE_BATCH_SIZE, shouldSearchEntireFeed } from '@/lib/feed/feedQueryMode';
import { DEFAULT_FEED_SEARCH_FILTERS } from '@/lib/smartSearch';

async function run() {
  assert.equal(
    shouldSearchEntireFeed({
      selectedUserId: null,
      searchFilters: DEFAULT_FEED_SEARCH_FILTERS,
    }),
    false,
    'default all-feed view should not force a full-database scan'
  );

  assert.equal(
    shouldSearchEntireFeed({
      selectedUserId: 'alice',
      searchFilters: DEFAULT_FEED_SEARCH_FILTERS,
    }),
    true,
    'selecting a person should force a full-database scan'
  );

  assert.equal(
    shouldSearchEntireFeed({
      selectedUserId: null,
      searchFilters: {
        ...DEFAULT_FEED_SEARCH_FILTERS,
        keyword: 'asteroid',
      },
    }),
    true,
    'keyword search should force a full-database scan'
  );

  const unfilteredPages = [
    {
      items: Array.from({ length: FEED_PAGE_BATCH_SIZE }, (_, index) => `page-1-${index}`),
      hasMore: true,
      nextCursor: 'cursor-1',
    },
    {
      items: Array.from({ length: FEED_PAGE_BATCH_SIZE }, (_, index) => `page-2-${index}`),
      hasMore: true,
      nextCursor: 'cursor-2',
    },
  ];
  let unfilteredCalls = 0;
  const unfiltered = await collectItemsUntilCount({
    desiredCount: FEED_PAGE_BATCH_SIZE * 2,
    fetchPage: async (cursor) => {
      const expectedCursor = unfilteredCalls === 0 ? null : `cursor-${unfilteredCalls}`;
      assert.equal(cursor, expectedCursor, 'unfiltered pagination should advance by next cursor');
      return unfilteredPages[unfilteredCalls++]!;
    },
  });
  assert.equal(unfiltered.items.length, FEED_PAGE_BATCH_SIZE * 2);
  assert.equal(unfiltered.pageCount, 2);
  assert.equal(unfiltered.hasMore, true, 'exactly filling the requested window should still report more pages');

  const filteredPages = [
    {
      items: [
        { id: 'a', keep: true },
        { id: 'b', keep: false },
      ],
      hasMore: true,
      nextCursor: 'cursor-a',
    },
    {
      items: [
        { id: 'c', keep: true },
        { id: 'd', keep: true },
      ],
      hasMore: false,
      nextCursor: null,
    },
  ];
  let filteredCalls = 0;
  const filtered = await collectItemsUntilCount({
    desiredCount: 2,
    matcher: (item) => item.keep,
    fetchPage: async () => filteredPages[filteredCalls++]!,
  });
  assert.deepEqual(
    filtered.items.map((item) => item.id),
    ['a', 'c'],
    'filtered accumulation should keep scanning pages until enough matches are found'
  );
  assert.equal(filtered.pageCount, 2);
  assert.equal(
    filtered.hasMore,
    true,
    'stopping in the middle of a matched page should still allow more results to load'
  );

  console.log('feed query mode tests: ok');
}

void run();
