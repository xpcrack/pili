import assert from 'node:assert/strict';

import {
  buildAddressAliasMap,
  hasActiveFeedLocalFilters,
  selectFeedPageState,
} from '@/lib/feed/feedPageState';
import { DEFAULT_FEED_SEARCH_FILTERS, type FeedSearchFilters } from '@/lib/smartSearch';
import type { Activity, User } from '@/types';

function makeUser(id: string, name: string): User {
  return {
    id,
    name,
    handle: id,
    avatar: '',
    addresses: [{ address: `${id}Wallet`, name: 'main', chain: 'solana', totalAssetUsd: null, assetUpdatedAt: null }],
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
  };
}

function makeActivity(id: string, userId: string, timestamp: number, source: Activity['source'] = 'twitter'): Activity {
  const importance = {
    version: 1 as const,
    score: 60,
    sourceKind: source === 'blockchain' ? ('wallet' as const) : ('social' as const),
    sourceCount7d: 1,
    socialCount7d: source === 'blockchain' ? 0 : 1,
    walletCount7d: source === 'blockchain' ? 1 : 0,
    totalCount7d: 1,
    historicalMaxAssetUsd: 250_000,
    sourceRarity: 1,
    assetWeight: 0.7,
    totalFrequencyFactor: 1,
    dataConfidenceFactor: 1,
  };
  return {
    id,
    userId,
    source,
    type: source === 'twitter' ? 'post' : 'transfer',
    content: id,
    title: id,
    timestamp,
    metadata:
      source === 'twitter'
        ? { tweetId: id, importance }
        : { txHash: id, chain: 'solana', trackedAddress: `${userId}Wallet`, importance },
  };
}

function run() {
  const alice = makeUser('alice', 'Alice');
  const bob = makeUser('bob', 'Bob');
  const base = 1_700_000_000_000;
  const feed = [
    { user: alice, activity: makeActivity('old-alice', alice.id, base - 10_000) },
    { user: bob, activity: makeActivity('new-bob', bob.id, base) },
    { user: alice, activity: makeActivity('new-alice', alice.id, base - 1000) },
  ];

  const globalState = selectFeedPageState({
    feed,
    selectedUserId: null,
    searchFilters: DEFAULT_FEED_SEARCH_FILTERS,
    globalVisibleCount: 2,
    selectedUserVisibleCount: 50,
  });

  assert.deepEqual(
    globalState.filteredFeed.map((item) => item.activity.id),
    ['new-bob', 'new-alice'],
    'global state should order by timestamp and apply global visible count'
  );
  assert.deepEqual(Array.from(globalState.visibleUserIds).sort(), ['alice', 'bob']);
  assert.equal(globalState.hasActiveLocalFilters, false);
  assert.equal(globalState.hasEnabledFeedTypes, true);

  const selectedState = selectFeedPageState({
    feed,
    selectedUserId: alice.id,
    searchFilters: DEFAULT_FEED_SEARCH_FILTERS,
    globalVisibleCount: 200,
    selectedUserVisibleCount: 1,
  });
  assert.deepEqual(
    selectedState.filteredFeed.map((item) => item.activity.id),
    ['new-alice'],
    'selected state should scope to one user and apply selected visible count'
  );

  const filteredSearch: FeedSearchFilters = {
    ...DEFAULT_FEED_SEARCH_FILTERS,
    typeFilters: { ...DEFAULT_FEED_SEARCH_FILTERS.typeFilters, twitter: false },
  };
  assert.equal(hasActiveFeedLocalFilters(filteredSearch), true);
  assert.equal(
    selectFeedPageState({
      feed,
      selectedUserId: null,
      searchFilters: filteredSearch,
      globalVisibleCount: 200,
      selectedUserVisibleCount: 50,
    }).matchedFeed.length,
    0,
    'type filters should be applied inside page state selection'
  );

  const aliasMap = buildAddressAliasMap([alice, { ...bob, addresses: [{ ...bob.addresses[0]!, name: '#cold' }] }]);
  assert.equal(aliasMap.get('alicewallet'), 'Alice#main');
  assert.equal(aliasMap.get('bobwallet'), 'Bob#cold');

  console.log('feed page state tests: ok');
}

run();
