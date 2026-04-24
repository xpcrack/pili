import assert from 'node:assert/strict';

import { getDb } from '@/lib/server/sqlite';
import { readEventsFeed, readLatestActivityAtByUser } from '@/lib/server/eventsRepo';
import {
  buildCompletenessWindow,
  computeTwitterBackfillWindowDays,
  readActivityBreakdownByUser,
  resolveUnifiedWindowStartMs,
  resolveTwitterCoverageStartMs,
} from '@/lib/server/feedViewMeta';

function run() {
  const db = getDb();
  const now = new Date('2026-04-23T04:00:00.000Z').getTime();

  const userId1 = 'test-feed-total-user-1';
  const userId2 = 'test-feed-total-user-2';

  db.prepare("DELETE FROM events WHERE event_id LIKE 'test-feed-total:%'").run();
  db.prepare("DELETE FROM activity_feed WHERE activity_key LIKE 'test-feed-total:%'").run();

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
  const insertFeed = db.prepare(
    `INSERT INTO activity_feed (
      user_id,
      activity_key,
      timestamp,
      tx_hash_lower,
      chain,
      tracked_address_lower,
      source,
      type,
      user_json,
      activity_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
  insertFeed.run(
    userId1,
    'test-feed-total:1',
    now - 3000,
    null,
    null,
    null,
    'twitter',
    'post',
    makeUser(userId1, 'Alice'),
    makeActivity('test-feed-total-a1', userId1, 'twitter', 'ALPHA', 'alpha keyword one'),
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
  insertFeed.run(
    userId2,
    'test-feed-total:2',
    now - 2000,
    null,
    null,
    null,
    'twitter',
    'post',
    makeUser(userId2, 'Bob'),
    makeActivity('test-feed-total-a2', userId2, 'twitter', 'BETA', 'beta keyword two'),
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
  insertFeed.run(
    userId1,
    'test-feed-total:3',
    now - 1000,
    '0xtx3',
    'bsc',
    '0xabc',
    'blockchain',
    'transfer',
    makeUser(userId1, 'Alice'),
    makeActivity('test-feed-total-a3', userId1, 'blockchain', 'ALPHA', 'alpha chain transfer'),
    now
  );

  const filteredBySourceAndUser = readEventsFeed({
    limit: 50,
    source: 'test-source',
    userId: userId1,
  });
  assert.equal(filteredBySourceAndUser.total, 2);

  const latestByUser = readLatestActivityAtByUser();
  assert.ok((latestByUser[userId1] ?? 0) > 0);
  assert.ok((latestByUser[userId2] ?? 0) > 0);
  assert.ok((latestByUser[userId1] ?? 0) >= (latestByUser[userId2] ?? 0));

  const userBreakdown = readActivityBreakdownByUser(userId1);
  assert.deepEqual(userBreakdown, {
    twitterCount: 1,
    tradeCount: 1,
  });

  const globalWindow = buildCompletenessWindow({
    scope: 'global',
    endMs: now,
    windowState: {
      globalEarliestMs: now - 7 * 24 * 60 * 60 * 1000,
      perUserEarliestMs: {
        [userId1]: now - 2 * 24 * 60 * 60 * 1000,
      },
      perUserHistoryComplete: {
        [userId1]: false,
      },
      perUserLastBackfillAt: {},
      perUserLocalQualifiedCount: {},
      globalAlignment: 'partial',
      updatedAt: now,
    },
  });
  assert.equal(globalWindow.scope, 'global');
  assert.equal(globalWindow.startMs, now - 7 * 24 * 60 * 60 * 1000);
  assert.equal(globalWindow.endMs, now);
  assert.equal(globalWindow.complete, false);
  assert.equal(globalWindow.label, '2026-04-16 12:00');

  const userWindow = buildCompletenessWindow({
    scope: 'user',
    userId: userId1,
    endMs: now,
    windowState: {
      globalEarliestMs: now - 7 * 24 * 60 * 60 * 1000,
      perUserEarliestMs: {
        [userId1]: now - 2 * 24 * 60 * 60 * 1000,
      },
      perUserHistoryComplete: {
        [userId1]: false,
      },
      perUserLastBackfillAt: {},
      perUserLocalQualifiedCount: {},
      globalAlignment: 'aligned',
      updatedAt: now,
    },
  });
  assert.equal(userWindow.scope, 'user');
  assert.equal(userWindow.startMs, now - 2 * 24 * 60 * 60 * 1000);
  assert.equal(userWindow.endMs, now);
  assert.equal(userWindow.complete, true);
  assert.equal(userWindow.label, '2026-04-21 12:00');

  assert.equal(
    resolveUnifiedWindowStartMs(now - 7 * 24 * 60 * 60 * 1000, [now - 2 * 24 * 60 * 60 * 1000]),
    now - 2 * 24 * 60 * 60 * 1000
  );
  assert.equal(resolveUnifiedWindowStartMs(now - 7 * 24 * 60 * 60 * 1000, [null]), null);
  assert.equal(computeTwitterBackfillWindowDays(now - 10 * 24 * 60 * 60 * 1000, now), 10);
  assert.equal(computeTwitterBackfillWindowDays(now - 33 * 24 * 60 * 60 * 1000, now), 30);
  assert.equal(computeTwitterBackfillWindowDays(null, now), 7);
  assert.equal(
    resolveTwitterCoverageStartMs([
      { lane: 'timeline', coveredSinceMs: now - 10 * 24 * 60 * 60 * 1000 },
      { lane: 'replies', coveredSinceMs: now - 8 * 24 * 60 * 60 * 1000 },
    ]),
    now - 8 * 24 * 60 * 60 * 1000
  );
  assert.equal(
    resolveTwitterCoverageStartMs([
      { lane: 'timeline', coveredSinceMs: now - 10 * 24 * 60 * 60 * 1000 },
      { lane: 'replies', coveredSinceMs: null },
    ]),
    null
  );

  const incompleteByTwitterWindow = buildCompletenessWindow({
    scope: 'user',
    userId: userId1,
    endMs: now,
    requiredSourceStarts: [null],
    windowState: {
      globalEarliestMs: now - 7 * 24 * 60 * 60 * 1000,
      perUserEarliestMs: {
        [userId1]: now - 7 * 24 * 60 * 60 * 1000,
      },
      perUserHistoryComplete: {
        [userId1]: true,
      },
      perUserLastBackfillAt: {},
      perUserLocalQualifiedCount: {},
      globalAlignment: 'aligned',
      updatedAt: now,
    },
  });
  assert.equal(incompleteByTwitterWindow.startMs, null);
  assert.equal(incompleteByTwitterWindow.complete, false);
  assert.equal(incompleteByTwitterWindow.label, null);

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
  db.prepare("DELETE FROM activity_feed WHERE activity_key LIKE 'test-feed-total:%'").run();

  console.log('events feed total tests: ok');
}

run();
