import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

function insertTrackedUser(db: ReturnType<typeof import('@/lib/server/sqlite').getDb>) {
  const now = Date.UTC(2026, 3, 24, 8, 0, 0);
  db.prepare(
    `INSERT INTO tracked_users (
      id,
      name,
      handle,
      avatar,
      twitter,
      telegram,
      tags_json,
      total_asset_usd,
      historical_max_asset_usd,
      asset_updated_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('relay-user', 'Relay User', 'relay-user', '', 'RelayCase', null, '[]', 0, 0, null, now, now);
}

function insertTweet(
  db: ReturnType<typeof import('@/lib/server/sqlite').getDb>,
  input: {
    tweetId: string;
    authorHandle: string;
    sourceJson: string;
    lastSeenAtMs: number;
  }
) {
  db.prepare(
    `INSERT INTO twitter_tweets (
      tweet_id,
      author_handle,
      author_name,
      full_text,
      created_at_ms,
      lane,
      conversation_id,
      in_reply_to_tweet_id,
      quoted_tweet_id,
      metrics_reply_count,
      metrics_retweet_count,
      metrics_like_count,
      metrics_view_count,
      source_json,
      first_seen_at_ms,
      last_seen_at_ms,
      updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.tweetId,
    input.authorHandle,
    null,
    `tweet ${input.tweetId}`,
    input.lastSeenAtMs - 60_000,
    'timeline',
    null,
    null,
    null,
    0,
    0,
    0,
    0,
    input.sourceJson,
    input.lastSeenAtMs,
    input.lastSeenAtMs,
    input.lastSeenAtMs
  );
}

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-twitter-relay-coverage-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { getDb } = await import('@/lib/server/sqlite');
    const { listTwitterRelayCoverageByHandles } = await import('@/lib/server/twitterRepo');
    const { GET } = await import('@/app/api/users/route');
    const db = getDb();

    insertTrackedUser(db);
    insertTweet(db, {
      tweetId: 'relay-1',
      authorHandle: 'relaycase',
      sourceJson: JSON.stringify({ provider: 'bot2bot' }),
      lastSeenAtMs: Date.UTC(2026, 3, 24, 7, 0, 0),
    });
    insertTweet(db, {
      tweetId: 'relay-2',
      authorHandle: 'relaycase',
      sourceJson: JSON.stringify({ provider: 'bot2bot' }),
      lastSeenAtMs: Date.UTC(2026, 3, 24, 7, 30, 0),
    });
    insertTweet(db, {
      tweetId: 'non-relay',
      authorHandle: 'relaycase',
      sourceJson: JSON.stringify({ provider: '6551' }),
      lastSeenAtMs: Date.UTC(2026, 3, 24, 7, 45, 0),
    });
    insertTweet(db, {
      tweetId: 'bad-source',
      authorHandle: 'relaycase',
      sourceJson: '{not-json',
      lastSeenAtMs: Date.UTC(2026, 3, 24, 7, 50, 0),
    });

    const coverageByHandle = listTwitterRelayCoverageByHandles(['@RelayCase']);
    assert.equal(coverageByHandle.get('relaycase')?.latestTweetId, 'relay-2');
    assert.equal(coverageByHandle.get('relaycase')?.tweetCount, 2);

    const response = await GET();
    const payload = await response.json();
    assert.equal(payload.ok, true);
    const relayUser = payload.users.find((user: { id?: string }) => user.id === 'relay-user');
    assert.equal(relayUser?.relayCoverage?.latestTweetId, 'relay-2');
    assert.equal(relayUser?.relayCoverage?.tweetCount, 2);

    console.log('twitter relay coverage tests: ok');
  } finally {
    if (typeof previousDbPath === 'string') {
      process.env.PILIPILI_DB_PATH = previousDbPath;
    } else {
      delete process.env.PILIPILI_DB_PATH;
    }
    if (typeof previousDataDir === 'string') {
      process.env.PILIPILI_DATA_DIR = previousDataDir;
    } else {
      delete process.env.PILIPILI_DATA_DIR;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
