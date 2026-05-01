import assert from 'node:assert/strict';

import {
  buildActivitiesByUser,
  filterFeedByExistingUsers,
  mergeFeedItems,
  type FeedItem,
} from '@/lib/feed/feedItemMerge';
import {
  buildFeedDebugEntries,
  filterPoisonFromFeed,
} from '@/lib/feed/feedPoisonFilter';
import type { Activity, User } from '@/types';

function makeUser(id: string): User {
  return {
    id,
    name: id,
    handle: id,
    avatar: '',
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
  timestamp: number,
  metadata: Partial<Activity['metadata']>
): Activity {
  return {
    id,
    userId,
    source: 'blockchain',
    type: 'transfer',
    content: id,
    title: id,
    timestamp,
    metadata,
  };
}

function makeItem(user: User, activity: Activity): FeedItem {
  return { user, activity };
}

function run() {
  const alice = makeUser('alice');
  const bob = makeUser('bob');
  const carol = makeUser('carol');
  const base = 1_700_000_000_000;

  const nativeLeg = makeItem(
    alice,
    makeActivity('native-leg', alice.id, base - 1000, {
      monitorTxAggregateKey: 'bsc:0xalice:0xswap',
      txHash: '0xswap',
      chain: 'bsc',
      trackedAddress: '0xalice',
      token: 'BNB',
      value: '1.2',
      txAction: 'receive',
    })
  );
  const tokenLeg = makeItem(
    alice,
    makeActivity('token-leg', alice.id, base, {
      monitorTxAggregateKey: 'bsc:0xalice:0xswap',
      txHash: '0xswap',
      chain: 'bsc',
      trackedAddress: '0xalice',
      token: 'MEME',
      tokenAddress: '0xmeme',
      value: '5000',
      txAction: 'send',
    })
  );

  const merged = mergeFeedItems([nativeLeg], [tokenLeg]);
  assert.equal(merged.length, 1, 'same scoped transaction should dedupe to one feed item');
  assert.equal(merged[0]?.activity.id, 'token-leg', 'non-native token leg should represent a swap');
  assert.equal(merged[0]?.activity.metadata.txAction, 'sell', 'paired native receive should promote outgoing token leg to sell');

  const filteredUsers = filterFeedByExistingUsers(
    [makeItem(alice, makeActivity('a', alice.id, base, {})), makeItem(carol, makeActivity('c', carol.id, base, {}))],
    [alice, bob]
  );
  assert.deepEqual(
    filteredUsers.map((item) => item.user.id),
    ['alice'],
    'feed should drop activities for users no longer present locally'
  );

  const activitiesByUser = buildActivitiesByUser([
    makeItem(alice, makeActivity('a1', alice.id, base, {})),
    makeItem(alice, makeActivity('a2', alice.id, base - 1, {})),
    makeItem(bob, makeActivity('b1', bob.id, base, {})),
  ]);
  assert.deepEqual(
    Array.from(activitiesByUser.entries()).map(([userId, activities]) => [userId, activities.map((item) => item.id)]),
    [
      ['alice', ['a1', 'a2']],
      ['bob', ['b1']],
    ],
    'activities should stay grouped by feed user order'
  );

  const poisonFeed = [
    makeItem(alice, makeActivity('airdrop-a', alice.id, base, {
      txHash: 'airdrop-a',
      chain: 'solana',
      token: 'SPAM',
      tokenAddress: 'SpamMint111',
      value: '1',
      txAction: 'receive',
      uncertainFrom: true,
      fromAddress: 'SpamSender111',
      toAddress: 'AliceWallet111',
    })),
    makeItem(bob, makeActivity('airdrop-b', bob.id, base - 1, {
      txHash: 'airdrop-b',
      chain: 'solana',
      token: 'SPAM',
      tokenAddress: 'SpamMint111',
      value: '1',
      txAction: 'receive',
      uncertainFrom: true,
      fromAddress: 'SpamSender111',
      toAddress: 'BobWallet111',
    })),
    makeItem(carol, makeActivity('airdrop-c', carol.id, base - 2, {
      txHash: 'airdrop-c',
      chain: 'solana',
      token: 'SPAM',
      tokenAddress: 'SpamMint111',
      value: '1',
      txAction: 'receive',
      uncertainFrom: true,
      fromAddress: 'SpamSender111',
      toAddress: 'CarolWallet111',
    })),
    makeItem(bob, makeActivity('safe-b', bob.id, base, {
      txHash: 'safe-b',
      chain: 'solana',
      token: 'USDC',
      value: '10',
      txAction: 'receive',
      uncertainFrom: false,
    })),
  ];
  const poisonFiltered = filterPoisonFromFeed(poisonFeed);
  assert.deepEqual(
    poisonFiltered.map((item) => item.activity.id),
    ['safe-b'],
    'client poison filter should remove suspicious fan-out receives while keeping safe receives'
  );

  const senderOnlyPoisonFeed = [
    makeItem(alice, makeActivity('sender-only-a', alice.id, base, {
      txHash: 'sender-only-a',
      chain: 'solana',
      token: 'SPAM_A',
      tokenAddress: 'SpamMintA111',
      value: '10',
      txAction: 'receive',
      uncertainFrom: true,
      fromAddress: 'FanoutSender111',
      toAddress: 'AliceWallet111',
    })),
    makeItem(bob, makeActivity('sender-only-b', bob.id, base - 1, {
      txHash: 'sender-only-b',
      chain: 'solana',
      token: 'SPAM_B',
      tokenAddress: 'SpamMintB111',
      value: '11',
      txAction: 'receive',
      uncertainFrom: true,
      fromAddress: 'FanoutSender111',
      toAddress: 'BobWallet111',
    })),
    makeItem(carol, makeActivity('sender-only-c', carol.id, base - 2, {
      txHash: 'sender-only-c',
      chain: 'solana',
      token: 'SPAM_C',
      tokenAddress: 'SpamMintC111',
      value: '12',
      txAction: 'receive',
      uncertainFrom: true,
      fromAddress: 'FanoutSender111',
      toAddress: 'CarolWallet111',
    })),
    makeItem(alice, makeActivity('sender-only-safe', alice.id, base - 3, {
      txHash: 'sender-only-safe',
      chain: 'solana',
      token: 'USDC',
      value: '25',
      txAction: 'receive',
      uncertainFrom: false,
    })),
  ];
  const senderOnlyFiltered = filterPoisonFromFeed(senderOnlyPoisonFeed);
  assert.deepEqual(
    senderOnlyFiltered.map((item) => item.activity.id),
    ['sender-only-safe'],
    'client poison filter should apply sender fan-out even without suspicious token or repeat keys'
  );

  const debugFeed = [makeItem(alice, makeActivity('dust-a', alice.id, base, {
    txHash: 'dust-a',
    chain: 'solana',
    token: 'SOL',
    value: '0.00001',
    txAction: 'receive',
    uncertainFrom: true,
  }))];
  const debugEntries = buildFeedDebugEntries(debugFeed, 'dust-a');
  assert.equal(debugEntries.length, 1);
  assert.equal(debugEntries[0]?.matches.nativeDust, true, 'debug entries should expose poison match reasons');

  console.log('feed client state tests: ok');
}

run();
