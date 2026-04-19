import assert from 'node:assert/strict';

import { getDb } from '@/lib/server/sqlite';
import { readEventsFeed } from '@/lib/server/eventsRepo';

function run() {
  const db = getDb();
  const now = Date.now();

  const userId1 = 'test-feed-total-user-1';
  const userId2 = 'test-feed-total-user-2';

  db.prepare("DELETE FROM events WHERE event_id LIKE 'test-feed-total:%'").run();

  const insert = db.prepare(
    `INSERT INTO events (
      event_id,
      source,
      kind,
      timestamp,
      user_id,
      user_name,
      chain,
      address,
      content,
      url,
      action,
      token,
      tweet_id,
      tx_hash,
      ingest_source,
      dedup_key,
      metadata_json,
      payload_json,
      user_json,
      activity_json,
      indexed_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const makeUser = (id: string, name: string) =>
    JSON.stringify({
      id,
      name,
      handle: id,
      avatar: '',
      addresses: [],
      totalAssetUsd: 0,
      historicalMaxAssetUsd: 0,
      assetUpdatedAt: null,
      tags: [],
    });

  const makeActivity = (
    activityId: string,
    userId: string,
    source: 'twitter' | 'blockchain',
    token: string,
    content: string
  ) =>
    JSON.stringify({
      id: activityId,
      userId,
      source,
      type: source === 'twitter' ? 'post' : 'transfer',
      title: content,
      content,
      timestamp: now,
      metadata: { token, chain: source === 'twitter' ? undefined : 'bsc' },
    });

  insert.run(
    'test-feed-total:1',
    'test-source',
    'post',
    now - 3000,
    userId1,
    'Alice',
    null,
    null,
    'alpha keyword one',
    null,
    null,
    'ALPHA',
    'tweet-test-1',
    null,
    'test-source',
    'test-feed-total:1',
    '{}',
    '{}',
    makeUser(userId1, 'Alice'),
    makeActivity('test-feed-total-a1', userId1, 'twitter', 'ALPHA', 'alpha keyword one'),
    now,
    now,
    now
  );

  insert.run(
    'test-feed-total:2',
    'test-source',
    'post',
    now - 2000,
    userId2,
    'Bob',
    null,
    null,
    'beta keyword two',
    null,
    null,
    'BETA',
    'tweet-test-2',
    null,
    'test-source',
    'test-feed-total:2',
    '{}',
    '{}',
    makeUser(userId2, 'Bob'),
    makeActivity('test-feed-total-a2', userId2, 'twitter', 'BETA', 'beta keyword two'),
    now,
    now,
    now
  );

  insert.run(
    'test-feed-total:3',
    'test-source',
    'transfer',
    now - 1000,
    userId1,
    'Alice',
    'bsc',
    '0xabc',
    'alpha chain transfer',
    null,
    'buy',
    'ALPHA',
    null,
    '0xtx3',
    'test-source',
    'test-feed-total:3',
    '{}',
    '{}',
    makeUser(userId1, 'Alice'),
    makeActivity('test-feed-total-a3', userId1, 'blockchain', 'ALPHA', 'alpha chain transfer'),
    now,
    now,
    now
  );

  const filteredBySourceAndUser = readEventsFeed({
    limit: 50,
    source: 'test-source',
    userId: userId1,
  });
  assert.equal(filteredBySourceAndUser.total, 2);

  const filteredBySearch = readEventsFeed({
    limit: 50,
    source: 'test-source',
    q: 'alpha',
  });
  assert.equal(filteredBySearch.total, 2);

  const filteredByChainAndSearch = readEventsFeed({
    limit: 50,
    source: 'test-source',
    chain: 'bsc',
    q: 'alpha',
  });
  assert.equal(filteredByChainAndSearch.total, 1);

  const page1 = readEventsFeed({
    limit: 1,
    source: 'test-source',
    userId: userId1,
  });
  assert.equal(page1.total, 2);
  assert.equal(page1.feed.length, 1);

  const page2 = readEventsFeed({
    limit: 1,
    source: 'test-source',
    userId: userId1,
    cursor: page1.nextCursor,
  });
  assert.equal(page2.total, 1);

  db.prepare("DELETE FROM events WHERE event_id LIKE 'test-feed-total:%'").run();

  console.log('events feed total tests: ok');
}

run();
