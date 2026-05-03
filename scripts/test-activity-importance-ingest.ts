import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Activity, User } from '@/types';

import './server-only-shim.cjs';

const VALID_SOLANA_WALLET = 'testuser_solana_placeholder_1111111111111111';

function makeUser(id: string): User {
  return {
    id,
    name: id,
    handle: id,
    avatar: '',
    twitter: id,
    addresses: [{ address: VALID_SOLANA_WALLET, name: '#1', chain: 'solana', totalAssetUsd: null, assetUpdatedAt: null }],
    totalAssetUsd: 250_000,
    historicalMaxAssetUsd: 250_000,
    assetUpdatedAt: null,
    tags: [],
  };
}

function makeChainActivity(id: string, userId: string, timestamp: number): Activity {
  return {
    id,
    userId,
    source: 'blockchain',
    type: 'transfer',
    title: id,
    content: id,
    timestamp,
    metadata: {
      txHash: `${id}-tx`,
      chain: 'solana',
      trackedAddress: VALID_SOLANA_WALLET,
      txAction: 'buy',
      token: 'TEST',
      value: '1',
    },
  };
}

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-importance-ingest-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { upsertEventsFromFeedRows, readEventsFeed } = await import('@/lib/server/eventsRepo');
    const { upsertFeedSnapshot } = await import('@/lib/server/feedSnapshotRepo');
    const { projectTwitterTweetsToFeed } = await import('@/lib/server/twitterFeedMapper');
    const { createTrackedUser } = await import('@/lib/server/trackedUsersRepo');
    const { ingestTelegramChannelPost } = await import('@/lib/server/telegramChannelIngest');
    const { upsertTelegramChannelSource } = await import('@/lib/server/telegramChannelSourceRepo');
    const { upsertTelegramChannelPost } = await import('@/lib/server/telegramChannelPostRepo');
    const { upsertTwitterTweets } = await import('@/lib/server/twitterRepo');
    const { getDb } = await import('@/lib/server/sqlite');

    const user = createTrackedUser(makeUser('alpha'));
    const timestamp = 1_710_000_000_000;

    upsertEventsFromFeedRows([{ user, activity: makeChainActivity('direct-chain', user.id, timestamp) }], 'test-direct');
    const directEvents = readEventsFeed({ limit: 10, userId: user.id });
    assert.ok(directEvents.feed[0]?.activity.metadata.importance?.score !== undefined);

    upsertFeedSnapshot([{ user, activity: makeChainActivity('snapshot-chain', user.id, timestamp + 1_000) }]);
    const db = getDb();
    const snapshotRow = db.prepare('SELECT activity_json FROM activity_feed WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1').get(user.id) as { activity_json: string };
    assert.ok(JSON.parse(snapshotRow.activity_json).metadata.importance.score !== undefined);

    upsertTwitterTweets([
      {
        tweetId: 'tweet-1',
        authorHandle: user.twitter || 'alpha',
        authorName: user.name,
        fullText: 'alpha says hello',
        createdAtMs: timestamp + 2_000,
        lane: 'timeline',
      },
    ]);
    const projected = projectTwitterTweetsToFeed({ sinceMs: timestamp });
    assert.equal(projected.projectedCount, 1);
    const twitterFeedRow = db.prepare("SELECT activity_json FROM activity_feed WHERE activity_key = 'twitter:tweet-1'").get() as { activity_json: string };
    assert.ok(JSON.parse(twitterFeedRow.activity_json).metadata.importance.score !== undefined);

    const source = upsertTelegramChannelSource({
      userId: user.id,
      channelRef: '@alpha',
    });
    const post = upsertTelegramChannelPost({
      channelChatId: '-100321',
      channelUsername: 'alpha',
      channelTitle: 'Alpha',
      messageId: 1,
      groupedId: null,
      postedAtMs: timestamp + 3_000,
      editDateMs: null,
      text: 'telegram hello',
      textEntities: [],
      media: [],
      linkUrls: [],
      forwardInfo: null,
      views: 0,
      forwards: 0,
      replies: 0,
      raw: { id: 1 },
    });
    const ingestResult = await ingestTelegramChannelPost({
      source,
      post,
      fetchTweetsByIds: async () => ({ provider: 'fixture', tweets: [] }),
    });
    const telegramEvent = readEventsFeed({ limit: 10, userId: user.id, source: 'telegram' });
    assert.ok(ingestResult.projected.activity.metadata.importance?.score !== undefined);
    assert.ok(telegramEvent.feed[0]?.activity.metadata.importance?.score !== undefined);

    console.log('activity importance ingest tests: ok');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
