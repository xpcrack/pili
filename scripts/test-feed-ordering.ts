import assert from 'node:assert/strict';

import { prepareGlobalFeed, prepareUserFeed } from '@/lib/feedOrdering';
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

function makeActivity(
  id: string,
  userId: string,
  source: Activity['source'],
  timestamp: number,
  metadata: Partial<Activity['metadata']> = {}
): Activity {
  return {
    id,
    userId,
    source,
    type: source === 'twitter' ? 'post' : 'transfer',
    content: id,
    title: id,
    timestamp,
    metadata,
  };
}

function makeTradeItem(
  user: User,
  id: string,
  timestamp: number,
  metadata: Partial<Activity['metadata']> = {}
) {
  return {
    user,
    activity: makeActivity(id, user.id, 'blockchain', timestamp, {
      txHash: `${id}-tx`,
      chain: 'bsc',
      trackedAddress: '0xwallet',
      token: 'ASTEROID',
      tokenAddress: '0xasteroid',
      txAction: 'sell',
      txActionLabel: '减仓',
      txActionVariant: 'reduce',
      quoteToken: 'ETH',
      quoteAmount: '1',
      marketCapAtTxUsd: 120_000_000,
      ...metadata,
    }),
  };
}

function makeTransferItem(
  user: User,
  id: string,
  timestamp: number,
  metadata: Partial<Activity['metadata']> = {}
) {
  return {
    user,
    activity: makeActivity(id, user.id, 'blockchain', timestamp, {
      txHash: `${id}-tx`,
      chain: 'solana',
      trackedAddress: 'TrackedWallet111',
      fromAddress: 'TrackedWallet111',
      toAddress: 'Counterparty111',
      token: 'USDC',
      tokenAddress: 'USDCMint111',
      txAction: 'send',
      txActionLabel: '发送',
      txActionVariant: 'send',
      value: '1000',
      displayTradeAmountText: '1000 USDC',
      ...metadata,
    }),
  };
}

function run() {
  const base = 1_700_000_000_000;
  const alice = makeUser('alice', 'Alice');
  const bob = makeUser('bob', 'Bob');
  const carol = makeUser('carol', 'Carol');

  const ordered = prepareGlobalFeed([
    {
      user: alice,
      activity: makeActivity('chain-42m', 'alice', 'blockchain', base - 42 * 60_000, {
        txHash: '0x42',
        chain: 'bsc',
        trackedAddress: '0xalice',
        token: 'AAA',
      }),
    },
    {
      user: bob,
      activity: makeActivity('tweet-20m', 'bob', 'twitter', base - 20 * 60_000, {
        tweetId: 'tweet-20m',
      }),
    },
    {
      user: carol,
      activity: makeActivity('chain-28m', 'carol', 'blockchain', base - 28 * 60_000, {
        txHash: '0x28',
        chain: 'bsc',
        trackedAddress: '0xcarol',
        token: 'CCC',
      }),
    },
    {
      user: bob,
      activity: makeActivity('chain-25m', 'bob', 'blockchain', base - 25 * 60_000, {
        txHash: '0x25',
        chain: 'bsc',
        trackedAddress: '0xbob',
        token: 'BBB',
      }),
    },
  ]);

  assert.deepEqual(
    ordered.map((item) => item.activity.id),
    ['tweet-20m', 'chain-25m', 'chain-28m', 'chain-42m'],
    'global feed should stay strictly sorted by timestamp desc'
  );

  const dedupedThenMerged = prepareGlobalFeed([
    {
      user: alice,
      activity: makeActivity('dup-old', 'alice', 'blockchain', base - 50_000, {
        txHash: '0xdup',
        chain: 'bsc',
        trackedAddress: '0xalice',
        token: 'ASTEROID',
        tokenAddress: '0xasteroid',
        txAction: 'sell',
        txActionLabel: '减仓',
        txActionVariant: 'reduce',
        quoteToken: 'ETH',
        quoteAmount: '0.8',
        marketCapAtTxUsd: 111_000_000,
      }),
    },
    {
      user: bob,
      activity: makeActivity('dup-new', 'bob', 'blockchain', base - 40_000, {
        txHash: '0xdup',
        chain: 'bsc',
        trackedAddress: '0xbob',
        token: 'ASTEROID',
        tokenAddress: '0xasteroid',
        txAction: 'sell',
        txActionLabel: '减仓',
        txActionVariant: 'reduce',
        quoteToken: 'ETH',
        quoteAmount: '0.8',
        marketCapAtTxUsd: 112_000_000,
      }),
    },
    makeTradeItem(bob, 'follow-up', base - 20_000, {
      trackedAddress: '0xbob',
      quoteAmount: '0.8',
      marketCapAtTxUsd: 118_000_000,
    }),
  ]);

  assert.equal(dedupedThenMerged.length, 1, 'global dedup should happen before short-window merge');
  assert.equal(dedupedThenMerged[0]?.activity.id, 'follow-up', 'latest compatible trade should represent the merged card');
  assert.deepEqual(
    dedupedThenMerged[0]?.activity.metadata.coHitUserNames,
    ['Bob', 'Alice'],
    'merged activity should retain all matched user names from global dedup'
  );
  assert.equal(dedupedThenMerged[0]?.activity.metadata.coHitUserCount, 2);
  assert.equal(dedupedThenMerged[0]?.activity.metadata.mergedTradeCount, 2);

  const mergedTrades = prepareUserFeed([
    makeTradeItem(alice, 'merge-1', base - 5_000, {
      quoteAmount: '0.5',
      marketCapAtTxUsd: 110_000_000,
    }),
    makeTradeItem(alice, 'merge-2', base - 30_000, {
      quoteAmount: '1',
      marketCapAtTxUsd: 120_000_000,
    }),
    makeTradeItem(alice, 'merge-3', base - 55_000, {
      quoteAmount: '1.5',
      marketCapAtTxUsd: 130_000_000,
    }),
  ]);

  assert.equal(mergedTrades.length, 1, 'same user trades within one minute should merge');
  assert.equal(mergedTrades[0]?.activity.metadata.mergedTradeCount, 3);
  assert.equal(mergedTrades[0]?.activity.metadata.mergedTradeWindowMs, 60_000);
  assert.equal(mergedTrades[0]?.activity.metadata.displayTradeAmountText, '3 ETH');
  assert.ok(
    Math.abs((mergedTrades[0]?.activity.metadata.mergedTradeAverageMarketCapUsd || 0) - 123_333_333.33333333) < 0.001,
    'merged market cap should be weighted by merged trade amount'
  );

  const splitBySignature = prepareUserFeed([
    makeTradeItem(alice, 'reduce-a', base - 5_000),
    makeTradeItem(alice, 'open-b', base - 15_000, {
      txAction: 'buy',
      txActionLabel: '建仓',
      txActionVariant: 'open',
    }),
    makeTradeItem(alice, 'other-token', base - 25_000, {
      token: 'MOON',
      tokenAddress: '0xmoon',
    }),
    makeTradeItem(alice, 'other-quote', base - 35_000, {
      quoteToken: 'USDT',
      quoteAmount: '1200',
    }),
    makeTradeItem(alice, 'other-wallet', base - 45_000, {
      trackedAddress: '0xwallet-2',
    }),
    makeTradeItem(alice, 'other-chain', base - 55_000, {
      chain: 'ethereum',
    }),
    makeTradeItem(alice, 'too-old', base - 80_000),
  ]);

  assert.equal(splitBySignature.length, 7, 'different direction, asset, unit, wallet, chain, or window must not merge');

  const mergedWithoutMarketCap = prepareUserFeed([
    makeTradeItem(alice, 'null-cap-1', base - 5_000, {
      quoteAmount: '0.25',
      marketCapAtTxUsd: undefined,
    }),
    makeTradeItem(alice, 'null-cap-2', base - 25_000, {
      quoteAmount: '0.75',
      marketCapAtTxUsd: undefined,
    }),
  ]);

  assert.equal(mergedWithoutMarketCap.length, 1, 'missing market cap should still allow amount merge');
  assert.equal(mergedWithoutMarketCap[0]?.activity.metadata.displayTradeAmountText, '1 ETH');
  assert.equal(mergedWithoutMarketCap[0]?.activity.metadata.mergedTradeAverageMarketCapUsd, null);
  assert.equal(mergedWithoutMarketCap[0]?.activity.metadata.displayMarketCapText, undefined);

  const mergedTransfers = prepareUserFeed([
    makeTransferItem(bob, 'send-1', base - 5_000),
    makeTransferItem(bob, 'send-2', base - 25_000),
    makeTransferItem(bob, 'send-3', base - 55_000),
  ]);

  assert.equal(mergedTransfers.length, 1, 'same transfer target within one minute should merge');
  assert.equal(mergedTransfers[0]?.activity.metadata.mergedTradeCount, 3);
  assert.equal(mergedTransfers[0]?.activity.metadata.displayTradeAmountText, '3000 USDC');
  assert.equal(mergedTransfers[0]?.activity.metadata.toAddress, 'Counterparty111');
  assert.equal(mergedTransfers[0]?.activity.metadata.txAction, 'send');

  const splitTransfers = prepareUserFeed([
    makeTransferItem(bob, 'send-target-a', base - 5_000, {
      toAddress: 'CounterpartyAAA',
    }),
    makeTransferItem(bob, 'send-target-b', base - 15_000, {
      toAddress: 'CounterpartyBBB',
    }),
    makeTransferItem(bob, 'receive-same-counterparty', base - 25_000, {
      txAction: 'receive',
      fromAddress: 'CounterpartyAAA',
      toAddress: 'TrackedWallet111',
      txActionLabel: undefined,
      txActionVariant: undefined,
      displayTradeAmountText: '1000 USDC',
    }),
    makeTransferItem(bob, 'send-other-token', base - 35_000, {
      token: 'USDT',
      tokenAddress: 'USDTMint111',
      displayTradeAmountText: '1000 USDT',
    }),
    makeTransferItem(bob, 'send-too-old', base - 90_000),
  ]);

  assert.equal(
    splitTransfers.length,
    5,
    'different transfer counterparty, direction, token, or time window must not merge'
  );

  console.log('feed ordering tests: ok');
}

run();
