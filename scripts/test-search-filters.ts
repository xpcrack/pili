import assert from 'node:assert/strict';

import {
  DEFAULT_FEED_SEARCH_FILTERS,
  getFeedItemCategory,
  hasAnyEnabledFeedType,
  matchesFeedSearchFilters,
  type FeedSearchFilters,
} from '@/lib/smartSearch';
import type { Activity, User } from '@/types';

function makeUser(id: string, name: string): User {
  return {
    id,
    name,
    handle: id,
    avatar: '',
    twitter: undefined,
    telegram: undefined,
    addresses: [],
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
  };
}

function makeItem(
  user: User,
  overrides: Partial<Activity> = {},
  metadata: Partial<Activity['metadata']> = {}
) {
  const source = overrides.source ?? 'blockchain';

  return {
    user,
    activity: {
      id: overrides.id ?? `${user.id}-activity`,
      userId: overrides.userId ?? user.id,
      source,
      type: overrides.type ?? (source === 'twitter' ? 'post' : 'transfer'),
      content: overrides.content ?? '',
      title: overrides.title,
      timestamp: overrides.timestamp ?? 1_700_000_000_000,
      metadata: {
        ...metadata,
      },
    },
  };
}

function run() {
  const alice = makeUser('alice', 'Alice Wonder');

  const tradeItem = makeItem(alice, {}, {
    txAction: 'buy',
    tokenAddress: '0xABCDEF',
    tradeAmountUsdAtTx: 2_500,
    marketCapAtTxUsd: 750_000,
  });
  const transferItem = makeItem(alice, {}, {
    txAction: 'send',
    fromAddress: '0xFROM',
    toAddress: '0xTO',
  });
  const twitterItem = makeItem(
    alice,
    {
      source: 'twitter',
      content: 'The market is waking up fast',
    },
    {}
  );
  const enrichedTwitterItem = makeItem(
    alice,
    {
      source: 'twitter',
      content: '我看好 ABC',
    },
    {
      tweetId: '1',
      mentionedTickers: ['ABC'],
      mentionedTokenAddresses: ['0xabc'],
      tokenSentiments: [
        {
          tokenSymbol: 'ABC',
          tokenAddress: '0xabc',
          sentiment: 'positive',
          matchSource: 'both',
        },
      ],
    }
  );
  const noisyBlockchainItem = makeItem(
    alice,
    {
      content: 'hidden alpha in content should not match',
    },
    {}
  );

  assert.equal(getFeedItemCategory(tradeItem), 'trade');
  assert.equal(getFeedItemCategory(transferItem), 'transfer');
  assert.equal(getFeedItemCategory(twitterItem), 'twitter');

  assert.equal(
    matchesFeedSearchFilters(tradeItem, {
      ...DEFAULT_FEED_SEARCH_FILTERS,
      keyword: 'alice 0xabcdef',
    }),
    true,
    'keyword search should match user name or token address'
  );
  assert.equal(
    matchesFeedSearchFilters(noisyBlockchainItem, {
      ...DEFAULT_FEED_SEARCH_FILTERS,
      keyword: 'hidden',
    }),
    false,
    'keyword search should not match blockchain content text'
  );
  assert.equal(
    matchesFeedSearchFilters(twitterItem, {
      ...DEFAULT_FEED_SEARCH_FILTERS,
      keyword: 'waking',
    }),
    true,
    'twitter keyword search should match tweet content'
  );
  assert.equal(
    matchesFeedSearchFilters(enrichedTwitterItem, {
      ...DEFAULT_FEED_SEARCH_FILTERS,
      keyword: 'ticker:abc',
    }),
    true,
    'ticker-prefixed keyword search should match mentioned tickers'
  );
  assert.equal(
    matchesFeedSearchFilters(enrichedTwitterItem, {
      ...DEFAULT_FEED_SEARCH_FILTERS,
      keyword: 'ca:0xabc',
    }),
    true,
    'ca-prefixed keyword search should match mentioned token addresses'
  );

  assert.equal(
    matchesFeedSearchFilters(tradeItem, {
      ...DEFAULT_FEED_SEARCH_FILTERS,
      minTradeAmountUsd: '3000',
    }),
    false,
    'trade amount filter should block smaller trade amounts'
  );
  assert.equal(
    matchesFeedSearchFilters(
      makeItem(alice, {}, {
        txAction: 'sell',
      }),
      {
        ...DEFAULT_FEED_SEARCH_FILTERS,
        minTradeAmountUsd: '100',
      }
    ),
    false,
    'trade amount filter should block unknown trade amounts'
  );
  assert.equal(
    matchesFeedSearchFilters(transferItem, {
      ...DEFAULT_FEED_SEARCH_FILTERS,
      minTradeAmountUsd: '999999',
      minTradeMarketCapUsd: '999999',
    }),
    true,
    'non-trade categories should ignore trade thresholds'
  );
  assert.equal(
    matchesFeedSearchFilters(tradeItem, {
      ...DEFAULT_FEED_SEARCH_FILTERS,
      minTradeAmountUsd: '1,000',
      minTradeMarketCapUsd: '700,000',
    }),
    true,
    'comma-formatted thresholds should still apply as numeric filters'
  );
  assert.equal(
    matchesFeedSearchFilters(tradeItem, {
      ...DEFAULT_FEED_SEARCH_FILTERS,
      minTradeAmountUsd: '3,000',
    }),
    false,
    'comma-formatted thresholds should still block smaller trade amounts'
  );

  const disabledTypes: FeedSearchFilters['typeFilters'] = {
    trade: false,
    transfer: false,
    twitter: false,
  };
  assert.equal(hasAnyEnabledFeedType(disabledTypes), false);

  console.log('search filter tests: ok');
}

run();
