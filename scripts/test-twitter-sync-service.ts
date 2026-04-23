import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

const TEST_USER_ID = 'test-twitter-sync-user';
const TEST_TWITTER_HANDLE = 'testtwittersyncuser';
const DAY_MS = 24 * 60 * 60 * 1000;

async function withEnv(
  overrides: Record<string, string | undefined>,
  callback: () => Promise<void> | void
) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (typeof value === 'string') {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }

  try {
    await callback();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (typeof value === 'string') {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  }
}

async function withMockedDateNow<T>(nowMs: number, callback: () => Promise<T> | T) {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    return await callback();
  } finally {
    Date.now = originalNow;
  }
}

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-twitter-sync-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { getDb } = await import('@/lib/server/sqlite');
    const twitterRepo = await import('@/lib/server/twitterRepo');
    const twitterSyncService = await import('@/lib/server/twitterSyncService');

    function cleanup() {
      const db = getDb();
      db.prepare("DELETE FROM feed_conflict_notifications WHERE conflict_key LIKE 'twitter:test-twitter-sync-%'").run();
      db.prepare("DELETE FROM feed_conflicts WHERE conflict_key LIKE 'twitter:test-twitter-sync-%'").run();
      db.prepare("DELETE FROM activity_feed WHERE user_id = ?").run(TEST_USER_ID);
      db.prepare("DELETE FROM events WHERE user_id = ?").run(TEST_USER_ID);
      db.prepare(
        "DELETE FROM twitter_tweet_relations WHERE source_tweet_id LIKE 'test-twitter-sync-%' OR target_tweet_id LIKE 'test-twitter-sync-%'"
      ).run();
      db.prepare("DELETE FROM twitter_tweets WHERE tweet_id LIKE 'test-twitter-sync-%'").run();
      db.prepare("DELETE FROM twitter_sync_cursor WHERE user_id = ?").run(TEST_USER_ID);
      db.prepare("DELETE FROM tracked_addresses WHERE user_id = ?").run(TEST_USER_ID);
      db.prepare("DELETE FROM tracked_users WHERE id = ?").run(TEST_USER_ID);
      db.prepare("DELETE FROM ingestion_leases WHERE lock_key = 'twitter-sync-global'").run();
    }

    function insertTrackedUser() {
      const db = getDb();
      const now = Date.now();
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
      ).run(
        TEST_USER_ID,
        'Twitter Sync Test',
        'twitter-sync-test',
        '',
        TEST_TWITTER_HANDLE,
        null,
        '[]',
        0,
        0,
        null,
        now,
        now
      );
    }

    function testStructuredIncompleteFetchDoesNotAdvanceCoverageCursor() {
      assert.equal(
        twitterSyncService.shouldAdvanceTwitterCoverageCursor({
          provider: '6551',
          coverageEstablished: false,
        }),
        false
      );

      assert.equal(
        twitterSyncService.shouldAdvanceTwitterCoverageCursor({
          provider: '6551',
          coverageEstablished: true,
        }),
        true
      );

      assert.equal(
        twitterSyncService.shouldAdvanceTwitterCoverageCursor({
          provider: 'opencli',
        }),
        true
      );
    }

    async function testNoopFetchDoesNotAdvanceCoverageCursor() {
      cleanup();
      insertTrackedUser();

      await withEnv(
        {
          TWITTER_FETCH_PROVIDER: 'fixture',
          TWITTER_6551_API_KEY_1: undefined,
          TWITTER_6551_API_KEY_2: undefined,
          TWITTER_XREAD_API_KEY: undefined,
        },
        async () => {
          const result = await twitterSyncService.runTwitterSyncAction({
            action: 'sync',
            userId: TEST_USER_ID,
            windowDays: 1,
          });

          assert.equal(result.ok, true);
        }
      );

      assert.equal(twitterRepo.readTwitterCursor(TEST_USER_ID, 'timeline'), null);
      assert.equal(twitterRepo.readTwitterCursor(TEST_USER_ID, 'replies'), null);
    }

    async function testSuccessfulSeedFetchStillAdvancesCoverageCursor() {
      cleanup();
      insertTrackedUser();

      const now = Date.now();
      const result = await twitterSyncService.runTwitterSyncAction({
        action: 'sync',
        userId: TEST_USER_ID,
        windowDays: 1,
        seedByHandle: {
          [TEST_TWITTER_HANDLE]: {
            timeline: [
              {
                tweetId: 'test-twitter-sync-timeline-1',
                authorHandle: TEST_TWITTER_HANDLE,
                fullText: 'timeline tweet',
                createdAtMs: now - 30 * 60 * 1000,
              },
            ],
            replies: [
              {
                tweetId: 'test-twitter-sync-replies-1',
                authorHandle: TEST_TWITTER_HANDLE,
                fullText: 'reply tweet',
                createdAtMs: now - 20 * 60 * 1000,
              },
            ],
          },
        },
      });

      assert.equal(result.ok, true);

      const timelineCursor = twitterRepo.readTwitterCursor(TEST_USER_ID, 'timeline');
      const repliesCursor = twitterRepo.readTwitterCursor(TEST_USER_ID, 'replies');

      assert.ok(timelineCursor);
      assert.ok(repliesCursor);
      assert.ok((timelineCursor?.coveredSinceMs ?? 0) >= now - DAY_MS - 10_000);
      assert.ok((repliesCursor?.coveredSinceMs ?? 0) >= now - DAY_MS - 10_000);
    }

    async function testStructuredIncompleteFetchKeepsExistingWatermarkWindow() {
      cleanup();
      insertTrackedUser();

      const nowMs = Date.UTC(2026, 3, 24, 2, 0, 0);
      const existingWatermarkMs = nowMs - 12 * 60 * 60 * 1000;
      const expectedSinceMs = existingWatermarkMs - 15 * 60 * 1000;
      const observedSinceMs: Array<{ lane: 'timeline' | 'replies'; sinceMs: number }> = [];
      let fetchRound = 0;

      twitterRepo.upsertTwitterCursor({
        userId: TEST_USER_ID,
        lane: 'timeline',
        coveredSinceMs: existingWatermarkMs - DAY_MS,
        watermarkCreatedAtMs: existingWatermarkMs,
        watermarkTweetId: 'test-twitter-sync-existing-timeline',
        lastSuccessAtMs: existingWatermarkMs,
      });
      twitterRepo.upsertTwitterCursor({
        userId: TEST_USER_ID,
        lane: 'replies',
        coveredSinceMs: existingWatermarkMs - DAY_MS,
        watermarkCreatedAtMs: existingWatermarkMs,
        watermarkTweetId: 'test-twitter-sync-existing-replies',
        lastSuccessAtMs: existingWatermarkMs,
      });

      await withMockedDateNow(nowMs, async () => {
        const fetcherOverride = {
          async fetchUserTweets(params: { lane: 'timeline' | 'replies'; sinceMs: number }) {
            observedSinceMs.push({
              lane: params.lane,
              sinceMs: params.sinceMs,
            });
            fetchRound += 1;
            return {
              provider: '6551' as const,
              credentialId: '6551-key-1',
              chargedUnit: 0,
              fallbackChain: ['6551' as const],
              coverageEstablished: false,
              tweets: [
                {
                  tweetId: `test-twitter-sync-partial-${params.lane}-${fetchRound}`,
                  authorHandle: TEST_TWITTER_HANDLE,
                  fullText: `partial ${params.lane} ${fetchRound}`,
                  createdAtMs: nowMs - 5 * 60 * 1000,
                  lane: params.lane,
                },
              ],
            };
          },
          async fetchTweetsByIds() {
            return {
              provider: 'noop' as const,
              credentialId: null,
              chargedUnit: 0,
              fallbackChain: ['noop' as const],
              coverageEstablished: false,
              tweets: [],
            };
          },
        };

        const first = await twitterSyncService.runTwitterSyncAction({
          action: 'sync',
          userId: TEST_USER_ID,
          fetcherOverride,
        });
        assert.equal(first.ok, true);

        const afterFirstTimeline = twitterRepo.readTwitterCursor(TEST_USER_ID, 'timeline');
        const afterFirstReplies = twitterRepo.readTwitterCursor(TEST_USER_ID, 'replies');
        assert.equal(afterFirstTimeline?.watermarkCreatedAtMs, existingWatermarkMs);
        assert.equal(afterFirstReplies?.watermarkCreatedAtMs, existingWatermarkMs);

        const second = await twitterSyncService.runTwitterSyncAction({
          action: 'sync',
          userId: TEST_USER_ID,
          fetcherOverride,
        });
        assert.equal(second.ok, true);
      });

      const timelineCalls = observedSinceMs.filter((item) => item.lane === 'timeline');
      const repliesCalls = observedSinceMs.filter((item) => item.lane === 'replies');

      assert.equal(timelineCalls.length, 2);
      assert.equal(repliesCalls.length, 2);
      assert.equal(timelineCalls[0]?.sinceMs, expectedSinceMs);
      assert.equal(repliesCalls[0]?.sinceMs, expectedSinceMs);
      assert.equal(timelineCalls[1]?.sinceMs, expectedSinceMs);
      assert.equal(repliesCalls[1]?.sinceMs, expectedSinceMs);
    }

    async function testStructuredIncompleteFirstSyncKeepsBootstrapWindowSticky() {
      cleanup();
      insertTrackedUser();

      const firstNowMs = Date.UTC(2026, 3, 24, 2, 0, 0);
      const secondNowMs = firstNowMs + 2 * 60 * 60 * 1000;
      const expectedSinceMs = firstNowMs - DAY_MS;
      const observedSinceMs: Array<{ lane: 'timeline' | 'replies'; sinceMs: number }> = [];

      const fetcherOverride = {
        async fetchUserTweets(params: { lane: 'timeline' | 'replies'; sinceMs: number }) {
          observedSinceMs.push({
            lane: params.lane,
            sinceMs: params.sinceMs,
          });
          return {
            provider: '6551' as const,
            credentialId: '6551-key-1',
            chargedUnit: 0,
            fallbackChain: ['6551' as const],
            coverageEstablished: false,
            tweets: [
              {
                tweetId: `test-twitter-sync-bootstrap-${params.lane}-${observedSinceMs.length}`,
                authorHandle: TEST_TWITTER_HANDLE,
                fullText: `bootstrap ${params.lane}`,
                createdAtMs: firstNowMs - 5 * 60 * 1000,
                lane: params.lane,
              },
            ],
          };
        },
        async fetchTweetsByIds() {
          return {
            provider: 'noop' as const,
            credentialId: null,
            chargedUnit: 0,
            fallbackChain: ['noop' as const],
            coverageEstablished: false,
            tweets: [],
          };
        },
      };

      await withMockedDateNow(firstNowMs, async () => {
        const first = await twitterSyncService.runTwitterSyncAction({
          action: 'sync',
          userId: TEST_USER_ID,
          fetcherOverride,
        });
        assert.equal(first.ok, true);
      });

      const afterFirstTimeline = twitterRepo.readTwitterCursor(TEST_USER_ID, 'timeline');
      const afterFirstReplies = twitterRepo.readTwitterCursor(TEST_USER_ID, 'replies');
      assert.equal(afterFirstTimeline?.coveredSinceMs, expectedSinceMs);
      assert.equal(afterFirstReplies?.coveredSinceMs, expectedSinceMs);
      assert.equal(afterFirstTimeline?.watermarkCreatedAtMs, null);
      assert.equal(afterFirstReplies?.watermarkCreatedAtMs, null);

      await withMockedDateNow(secondNowMs, async () => {
        const second = await twitterSyncService.runTwitterSyncAction({
          action: 'sync',
          userId: TEST_USER_ID,
          fetcherOverride,
        });
        assert.equal(second.ok, true);
      });

      const timelineCalls = observedSinceMs.filter((item) => item.lane === 'timeline');
      const repliesCalls = observedSinceMs.filter((item) => item.lane === 'replies');

      assert.equal(timelineCalls.length, 2);
      assert.equal(repliesCalls.length, 2);
      assert.equal(timelineCalls[0]?.sinceMs, expectedSinceMs);
      assert.equal(repliesCalls[0]?.sinceMs, expectedSinceMs);
      assert.equal(timelineCalls[1]?.sinceMs, expectedSinceMs);
      assert.equal(repliesCalls[1]?.sinceMs, expectedSinceMs);
    }

    async function testStructuredCompleteEmptyBootstrapDoesNotStaySticky() {
      cleanup();
      insertTrackedUser();

      const firstNowMs = Date.UTC(2026, 3, 24, 2, 0, 0);
      const secondNowMs = firstNowMs + 2 * 60 * 60 * 1000;
      const firstExpectedSinceMs = firstNowMs - DAY_MS;
      const secondExpectedSinceMs = secondNowMs - DAY_MS;
      const observedSinceMs: Array<{ lane: 'timeline' | 'replies'; sinceMs: number }> = [];

      const fetcherOverride = {
        async fetchUserTweets(params: { lane: 'timeline' | 'replies'; sinceMs: number }) {
          observedSinceMs.push({
            lane: params.lane,
            sinceMs: params.sinceMs,
          });
          return {
            provider: '6551' as const,
            credentialId: '6551-key-1',
            chargedUnit: 0,
            fallbackChain: ['6551' as const],
            coverageEstablished: true,
            tweets: [],
          };
        },
        async fetchTweetsByIds() {
          return {
            provider: 'noop' as const,
            credentialId: null,
            chargedUnit: 0,
            fallbackChain: ['noop' as const],
            coverageEstablished: false,
            tweets: [],
          };
        },
      };

      await withMockedDateNow(firstNowMs, async () => {
        const first = await twitterSyncService.runTwitterSyncAction({
          action: 'sync',
          userId: TEST_USER_ID,
          fetcherOverride,
        });
        assert.equal(first.ok, true);
      });

      const afterFirstTimeline = twitterRepo.readTwitterCursor(TEST_USER_ID, 'timeline');
      const afterFirstReplies = twitterRepo.readTwitterCursor(TEST_USER_ID, 'replies');
      assert.equal(afterFirstTimeline?.coveredSinceMs, null);
      assert.equal(afterFirstReplies?.coveredSinceMs, null);
      assert.equal(afterFirstTimeline?.watermarkCreatedAtMs, null);
      assert.equal(afterFirstReplies?.watermarkCreatedAtMs, null);

      await withMockedDateNow(secondNowMs, async () => {
        const second = await twitterSyncService.runTwitterSyncAction({
          action: 'sync',
          userId: TEST_USER_ID,
          fetcherOverride,
        });
        assert.equal(second.ok, true);
      });

      const timelineCalls = observedSinceMs.filter((item) => item.lane === 'timeline');
      const repliesCalls = observedSinceMs.filter((item) => item.lane === 'replies');

      assert.equal(timelineCalls.length, 2);
      assert.equal(repliesCalls.length, 2);
      assert.equal(timelineCalls[0]?.sinceMs, firstExpectedSinceMs);
      assert.equal(repliesCalls[0]?.sinceMs, firstExpectedSinceMs);
      assert.equal(timelineCalls[1]?.sinceMs, secondExpectedSinceMs);
      assert.equal(repliesCalls[1]?.sinceMs, secondExpectedSinceMs);
    }

    try {
      testStructuredIncompleteFetchDoesNotAdvanceCoverageCursor();
      await testNoopFetchDoesNotAdvanceCoverageCursor();
      await testSuccessfulSeedFetchStillAdvancesCoverageCursor();
      await testStructuredIncompleteFetchKeepsExistingWatermarkWindow();
      await testStructuredIncompleteFirstSyncKeepsBootstrapWindowSticky();
      await testStructuredCompleteEmptyBootstrapDoesNotStaySticky();
    } finally {
      cleanup();
    }

    console.log('twitter sync service tests: ok');
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
