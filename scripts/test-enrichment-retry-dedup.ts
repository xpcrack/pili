import assert from 'node:assert/strict';

import './server-only-shim.cjs';

/**
 * Integration tests for the enrichment retry/dedup wiring, running against the
 * throwaway PILIPILI_DATA_DIR the test runner provisions.
 *
 * Covers the regressions behind the "canceled" request flood:
 *  1. A timed-out / failed relay call must be persisted as last_error, otherwise
 *     the projector re-queues the tweet every cycle and re-fires the request.
 *  2. A tweet still mid-flight (or crashed mid-flight) must not be re-queued
 *     while its last attempt is fresh — but must still be retried once stale.
 *  3. Concurrent enrichment of one tweet must issue a single relay call.
 */

async function seedUserAndTweet(tweetId: string, text: string) {
  const { getDb } = await import('../lib/server/sqlite');
  const { upsertTwitterTweets } = await import('../lib/server/twitterRepo');
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO tracked_users (
      id, name, handle, avatar, twitter, telegram, tags_json,
      total_asset_usd, historical_max_asset_usd, asset_updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, '', ?, null, '[]', 0, 0, null, ?, ?)`,
  ).run(`user-${tweetId}`, 'Retry User', `retry-${tweetId}`, `test${tweetId}`, now, now);

  upsertTwitterTweets([
    {
      tweetId,
      authorHandle: `test${tweetId}`,
      fullText: text,
      createdAtMs: now,
      lane: 'timeline',
    },
  ]);
}

/** Force the enrichment row's last attempt timestamp (simulates elapsed time). */
async function setLastProcessedAtMs(tweetId: string, value: number) {
  const { getDb } = await import('../lib/server/sqlite');
  getDb()
    .prepare('UPDATE twitter_tweet_enrichments SET last_processed_at_ms = ? WHERE tweet_id = ?')
    .run(value, tweetId);
}

async function rowFor(tweetId: string) {
  const { listTwitterTweetEnrichmentsByTweetIds } = await import('../lib/server/twitterEnrichmentRepo');
  return listTwitterTweetEnrichmentsByTweetIds([tweetId])[0];
}

async function testTimeoutRecordsLastError() {
  const { runTweetEnrichmentForTweetIds } = await import('../lib/server/twitterEnrichmentService');

  const tweetId = 'tweet-retry-timeout';
  await seedUserAndTweet(tweetId, 'Still bullish on $ABC.');

  // Stands in for the relay timing out: enrichTweet reports the reason in the
  // result instead of throwing — exactly what NvidaQwenEnrichmentModel does now.
  await runTweetEnrichmentForTweetIds({
    tweetIds: [tweetId],
    model: {
      enrichTweet: async () => ({
        translationZh: null,
        sentiments: [],
        error: 'aborted after 60000ms (request timeout)',
      }),
    },
  });

  const row = await rowFor(tweetId);
  assert.ok(row, 'enrichment row should exist after the attempt');
  assert.equal(row.translationStatus, 'failed');
  assert.ok(
    row.lastError && row.lastError.includes('timeout'),
    `timeout must be persisted as last_error so re-queue backoff engages, got: ${row.lastError}`,
  );
  console.log('PASS relay timeout is persisted as last_error');
}

async function testSuccessLeavesNoLastError() {
  const { runTweetEnrichmentForTweetIds } = await import('../lib/server/twitterEnrichmentService');

  const tweetId = 'tweet-retry-success';
  await seedUserAndTweet(tweetId, 'Still bullish on $XYZ.');

  // Boundary check on the new error path: a successful translation carries no
  // error, so it must NOT be marked as failing (which would wrongly back it off).
  await runTweetEnrichmentForTweetIds({
    tweetIds: [tweetId],
    model: {
      enrichTweet: async () => ({ translationZh: '依旧看好 XYZ。', sentiments: [] }),
    },
  });

  const row = await rowFor(tweetId);
  assert.equal(row.translationStatus, 'succeeded');
  assert.equal(row.lastError, null, 'successful translation must not record last_error');
  console.log('PASS successful translation records no last_error');
}

async function testFreshAttemptIsNotRequeuedButStaleIs() {
  const { shouldQueueEnrichment } = await import('../lib/server/twitterFeedMapper');
  const { listTwitterTweetEnrichmentsByTweetIds: listRows } = await import(
    '../lib/server/twitterEnrichmentRepo'
  );

  const tweetId = 'tweet-retry-policy';
  await seedUserAndTweet(tweetId, 'Still bullish on $STLE.');

  const { runTweetEnrichmentForTweetIds } = await import('../lib/server/twitterEnrichmentService');
  await runTweetEnrichmentForTweetIds({
    tweetIds: [tweetId],
    model: { enrichTweet: async () => ({ translationZh: '看好。', sentiments: [] }) },
  });

  const base = listRows([tweetId])[0];
  assert.ok(base, 'row exists');
  const now = Date.now();

  // Mid-flight / crashed-mid-flight: fresh attempt must be left alone...
  assert.equal(
    shouldQueueEnrichment({ ...base, translationStatus: 'processing', lastProcessedAtMs: now }, now),
    false,
    'a fresh in-flight attempt must not be re-queued',
  );
  // ...but a stale one must come back, otherwise the tweet is stuck forever.
  assert.equal(
    shouldQueueEnrichment(
      { ...base, translationStatus: 'processing', lastProcessedAtMs: now - 10 * 60_000 },
      now,
    ),
    true,
    'a stale in-flight attempt must be retried',
  );
  assert.equal(
    shouldQueueEnrichment({ ...base, translationStatus: 'pending', lastProcessedAtMs: null }, now),
    true,
    'an abandoned pending row with no timestamp must be retried',
  );

  // Recorded failure: back off while recent, retry once the backoff lapses.
  assert.equal(
    shouldQueueEnrichment(
      { ...base, translationStatus: 'failed', lastError: 'timeout', lastProcessedAtMs: now },
      now,
    ),
    false,
    'a just-failed tweet must back off instead of re-firing',
  );
  assert.equal(
    shouldQueueEnrichment(
      {
        ...base,
        translationStatus: 'failed',
        lastError: 'timeout',
        lastProcessedAtMs: now - 31 * 60_000,
      },
      now,
    ),
    true,
    'a failure older than the backoff window must be retried',
  );

  // Settled rows are not re-queued at all.
  assert.equal(
    shouldQueueEnrichment({ ...base, translationStatus: 'succeeded', lastError: null }, now),
    false,
    'a succeeded tweet must not be re-queued',
  );
  assert.equal(shouldQueueEnrichment(undefined, now), true, 'an unknown tweet must be queued');

  console.log('PASS enrichment re-queue policy (fresh vs stale vs failed vs settled)');
}

async function testConcurrentEnrichmentIsDeduped() {
  const { runTweetEnrichmentForTweetIds, listInFlightEnrichmentTweetIds } = await import(
    '../lib/server/twitterEnrichmentService'
  );

  const tweetId = 'tweet-retry-dedupe';
  await seedUserAndTweet(tweetId, 'Still bullish on $GHI.');

  let calls = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = {
    enrichTweet: async () => {
      calls += 1;
      await gate;
      return { translationZh: '依旧看好 GHI。', sentiments: [] };
    },
  };

  const first = runTweetEnrichmentForTweetIds({ tweetIds: [tweetId], model });
  // Let the first run reach the relay call before the second one arrives.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(listInFlightEnrichmentTweetIds(), [tweetId], 'first run is in flight');

  const second = runTweetEnrichmentForTweetIds({ tweetIds: [tweetId], model });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(calls, 1, 'second concurrent run must reuse the in-flight attempt');

  release!();
  await Promise.all([first, second]);
  assert.equal(calls, 1, 'still exactly one relay call after both settle');
  assert.deepEqual(listInFlightEnrichmentTweetIds(), [], 'in-flight entry cleared on settle');
  console.log('PASS concurrent enrichment of one tweet issues a single relay call');
}

async function main() {
  await testTimeoutRecordsLastError();
  await testSuccessLeavesNoLastError();
  await testFreshAttemptIsNotRequeuedButStaleIs();
  await testConcurrentEnrichmentIsDeduped();
  console.log('\nAll enrichment retry/dedup tests passed!');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
