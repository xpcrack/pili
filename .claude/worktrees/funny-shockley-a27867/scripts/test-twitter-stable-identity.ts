import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-twitter-stable-identity-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { getDb } = await import('@/lib/server/sqlite');
    const { createTrackedUser, listTrackedUsers } = await import('@/lib/server/trackedUsersRepo');
    const { upsertTwitterTweets } = await import('@/lib/server/twitterRepo');
    const { projectTwitterTweetsToFeed } = await import('@/lib/server/twitterFeedMapper');
    const { PATCH } = await import('@/app/api/users/[id]/route');

    const user = createTrackedUser({
      name: 'Stable Identity',
      handle: 'stable-identity',
      avatar: '',
      twitter: 'oldhandle',
      twitterUserId: 'twitter-user-1',
      addresses: [],
      totalAssetUsd: 0,
      historicalMaxAssetUsd: 0,
      assetUpdatedAt: null,
      tags: [],
    });

    const [storedUser] = listTrackedUsers();
    assert.equal(storedUser?.twitterUserId, 'twitter-user-1');

    upsertTwitterTweets([
      {
        tweetId: 'stable-identity-tweet-1',
        authorUserId: 'twitter-user-1',
        authorHandle: 'newhandle',
        fullText: 'new handle, same person',
        createdAtMs: Date.now(),
        lane: 'timeline',
      },
    ]);

    const projected = projectTwitterTweetsToFeed({
      userId: user.id,
      sinceMs: 0,
      tweetIds: ['stable-identity-tweet-1'],
    });
    assert.equal(projected.projectedCount, 1);

    const row = getDb()
      .prepare(
        `SELECT user_id, json_extract(activity_json, '$.metadata.tweetUrl') AS tweet_url
         FROM activity_feed
         WHERE activity_key = ?`
      )
      .get('twitter:stable-identity-tweet-1') as { user_id: string; tweet_url: string } | undefined;

    assert.equal(row?.user_id, user.id);
    assert.equal(row?.tweet_url, 'https://x.com/newhandle/status/stable-identity-tweet-1');

    const sameHandleResponse = await PATCH(
      new Request(`http://localhost/api/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ twitter: 'oldhandle' }),
      }) as Parameters<typeof PATCH>[0],
      { params: Promise.resolve({ id: user.id }) }
    );
    assert.equal(sameHandleResponse.status, 200);
    const sameHandlePayload = await sameHandleResponse.json();
    assert.equal(sameHandlePayload.user.twitterUserId, 'twitter-user-1');

    const changedUnresolvedResponse = await PATCH(
      new Request(`http://localhost/api/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ twitter: 'unresolvedhandle' }),
      }) as Parameters<typeof PATCH>[0],
      { params: Promise.resolve({ id: user.id }) }
    );
    assert.equal(changedUnresolvedResponse.status, 200);
    const changedUnresolvedPayload = await changedUnresolvedResponse.json();
    assert.equal(changedUnresolvedPayload.user.twitter, 'unresolvedhandle');
    assert.equal(changedUnresolvedPayload.user.twitterUserId, undefined);
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

run().then(() => {
  console.log('twitter stable identity tests: ok');
});
