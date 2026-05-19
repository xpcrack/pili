import assert from 'node:assert/strict';

import {
  DEFAULT_FEED_SEARCH_FILTERS,
  getFeedItemCategory,
  getRemoteFeedSearchKeyword,
  getRemoteFeedSource,
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
  const closeTradeRoutedAsSendItem = makeItem(alice, {}, {
    txAction: 'send',
    txActionVariant: 'close',
    tradeAmountUsdAtTx: 12_000,
    marketCapAtTxUsd: 8_500,
  });
  const twitterItem = makeItem(
    alice,
    {
      source: 'twitter',
      content: 'The market is waking up fast',
    },
    {}
  );
  const telegramItem = makeItem(
    alice,
    {
      source: 'telegram',
      type: 'post',
      content: '频道里发了一个新 CA',
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
  const openTradeActionItem = makeItem(alice, {}, {
    txAction: 'buy',
    txActionLabel: '建仓',
    txActionVariant: 'open',
    tradeAmountUsdAtTx: 1_000,
    marketCapAtTxUsd: 500_000,
  });
  const addTradeActionItem = makeItem(alice, {}, {
    txAction: 'buy',
    txActionLabel: '加仓',
    txActionVariant: 'add',
    tradeAmountUsdAtTx: 1_000,
    marketCapAtTxUsd: 500_000,
  });
  const tradeActionSocialItem = makeItem(
    alice,
    {
      source: 'twitter',
      content: '我刚刚决定建仓 SOL',
    },
    {}
  );

  assert.equal(getFeedItemCategory(tradeItem), 'trade');
  assert.equal(getFeedItemCategory(transferItem), 'transfer');
  assert.equal(
    getFeedItemCategory(closeTradeRoutedAsSendItem),
    'trade',
    'trade-like variants should be categorized as trades even when txAction is send'
  );
  assert.equal(getFeedItemCategory(twitterItem), 'twitter');
  assert.equal(getFeedItemCategory(telegramItem), 'telegram');

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
    matchesFeedSearchFilters(telegramItem, {
      ...DEFAULT_FEED_SEARCH_FILTERS,
      keyword: '频道',
    }),
    true,
    'telegram keyword search should match telegram post content'
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
    matchesFeedSearchFilters(openTradeActionItem, {
      ...DEFAULT_FEED_SEARCH_FILTERS,
      keyword: '建仓',
    }),
    true,
    'trade action keyword should match trades whose txActionLabel equals the term'
  );
  assert.equal(
    matchesFeedSearchFilters(addTradeActionItem, {
      ...DEFAULT_FEED_SEARCH_FILTERS,
      keyword: '建仓',
    }),
    false,
    'trade action keyword should not match a different action label'
  );
  assert.equal(
    matchesFeedSearchFilters(addTradeActionItem, {
      ...DEFAULT_FEED_SEARCH_FILTERS,
      keyword: '加仓',
    }),
    true,
    'each trade action keyword should match its own txActionLabel'
  );
  assert.equal(
    matchesFeedSearchFilters(tradeActionSocialItem, {
      ...DEFAULT_FEED_SEARCH_FILTERS,
      keyword: '建仓',
    }),
    true,
    'trade action keyword should still match social posts whose content contains the word'
  );

  assert.equal(
    getRemoteFeedSearchKeyword(' Finn '),
    'finn',
    'single plain keywords should be forwarded to server-side feed search'
  );
  assert.equal(
    getRemoteFeedSearchKeyword('alice 0xabcdef'),
    '',
    'multi-term keyword searches should stay client-side to preserve OR-style matching semantics'
  );
  assert.equal(
    getRemoteFeedSearchKeyword('ticker:abc'),
    '',
    'ticker-prefixed searches should stay client-side to preserve enriched mention matching'
  );
  assert.equal(
    getRemoteFeedSearchKeyword('ca:0xabc'),
    '',
    'ca-prefixed searches should stay client-side to preserve token-address matching semantics'
  );
  for (const actionTerm of ['建仓', '加仓', '减仓', '清仓', '发送']) {
    assert.equal(
      getRemoteFeedSearchKeyword(actionTerm),
      actionTerm,
      `trade action keyword "${actionTerm}" should be forwarded to remote search so the server can apply its LIKE-based action filter`
    );
  }
  assert.equal(
    getRemoteFeedSource({
      trade: false,
      transfer: false,
      twitter: false,
      telegram: true,
      news: false,
    }),
    'telegram',
    'telegram-only filter should request the telegram source remotely'
  );
  assert.equal(
    getRemoteFeedSource({
      trade: true,
      transfer: false,
      twitter: false,
      telegram: false,
      news: false,
    }),
    'blockchain',
    'chain-only filter should narrow remote reads to blockchain events'
  );
  assert.equal(
    getRemoteFeedSource({
      trade: false,
      transfer: false,
      twitter: true,
      telegram: true,
      news: false,
    }),
    null,
    'mixed social filters should stay broad when they cannot be expressed as one remote source'
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
    matchesFeedSearchFilters(closeTradeRoutedAsSendItem, {
      ...DEFAULT_FEED_SEARCH_FILTERS,
      minTradeMarketCapUsd: '100000',
    }),
    false,
    'trade-like variants should still respect trade market-cap thresholds'
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
    telegram: false,
    news: false,
  };
  assert.equal(hasAnyEnabledFeedType(disabledTypes), false);

  assert.equal(
    matchesFeedSearchFilters(telegramItem, {
      ...DEFAULT_FEED_SEARCH_FILTERS,
      typeFilters: {
        ...DEFAULT_FEED_SEARCH_FILTERS.typeFilters,
        telegram: false,
      },
    }),
    false,
    'telegram type filter should be able to hide telegram posts'
  );

  console.log('search filter tests: ok');
}

run();
