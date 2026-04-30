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
    const { readSystemConfig, saveSystemConfig } = await import('@/lib/server/systemConfigRepo');
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

    async function withSystemConfig(
      config: Parameters<typeof saveSystemConfig>[0],
      callback: () => Promise<void>
    ) {
      const original = readSystemConfig();
      saveSystemConfig(config);
      try {
        await callback();
      } finally {
        saveSystemConfig(original);
      }
    }

    function insertRelayTweet(lastSeenAtMs: number) {
      const db = getDb();
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
        'test-twitter-sync-relay-1',
        TEST_TWITTER_HANDLE,
        null,
        'relay tweet',
        lastSeenAtMs - 60_000,
        'timeline',
        null,
        null,
        null,
        0,
        0,
        0,
        0,
        JSON.stringify({ provider: 'bot2bot' }),
        lastSeenAtMs,
        lastSeenAtMs,
        lastSeenAtMs
      );
    }

    function setLaneSuccessCursors(lastSuccessAtMs: number) {
      for (const lane of ['timeline', 'replies'] as const) {
        twitterRepo.upsertTwitterCursor({
          userId: TEST_USER_ID,
          lane,
          coveredSinceMs: lastSuccessAtMs - DAY_MS,
          watermarkCreatedAtMs: lastSuccessAtMs - 60_000,
          watermarkTweetId: `test-twitter-sync-${lane}-cursor`,
          lastSuccessAtMs,
        });
      }
    }

    function createCountingFetcher(fetchCalls: Array<{ lane: 'timeline' | 'replies'; sinceMs: number }>) {
      return {
        async fetchUserTweets(params: { lane: 'timeline' | 'replies'; sinceMs: number }) {
          fetchCalls.push({
            lane: params.lane,
            sinceMs: params.sinceMs,
          });
          return {
            provider: 'seed' as const,
            credentialId: null,
            chargedUnit: 0,
            fallbackChain: ['seed' as const],
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
          force: true,
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
          force: true,
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

    async function testRelayCoveredUserSkipsUntilCoveredIntervalElapsed() {
      cleanup();
      insertTrackedUser();

      const nowMs = Date.UTC(2026, 3, 24, 8, 0, 0);
      setLaneSuccessCursors(nowMs - 2 * 60 * 60 * 1000);
      insertRelayTweet(nowMs - 30 * 60 * 1000);
      const fetchCalls: Array<{ lane: 'timeline' | 'replies'; sinceMs: number }> = [];

      await withSystemConfig(
        {
          twitterRelayCoveredPollingIntervalMinutes: 360,
          twitterUncoveredPollingIntervalMinutes: 30,
        },
        async () => {
          await withMockedDateNow(nowMs, async () => {
            const result = await twitterSyncService.runTwitterSyncAction({
              action: 'sync',
              userId: TEST_USER_ID,
              fetcherOverride: createCountingFetcher(fetchCalls),
            });
            assert.equal(result.ok, true);
          });
        }
      );

      assert.equal(fetchCalls.length, 0);
    }

    async function testUncoveredUserUsesConfiguredUncoveredInterval() {
      cleanup();
      insertTrackedUser();

      const nowMs = Date.UTC(2026, 3, 24, 8, 0, 0);
      const fetchCalls: Array<{ lane: 'timeline' | 'replies'; sinceMs: number }> = [];

      await withSystemConfig(
        {
          twitterRelayCoveredPollingIntervalMinutes: 360,
          twitterUncoveredPollingIntervalMinutes: 30,
        },
        async () => {
          setLaneSuccessCursors(nowMs - 29 * 60 * 1000);
          await withMockedDateNow(nowMs, async () => {
            const first = await twitterSyncService.runTwitterSyncAction({
              action: 'sync',
              userId: TEST_USER_ID,
              fetcherOverride: createCountingFetcher(fetchCalls),
            });
            assert.equal(first.ok, true);
          });
          assert.equal(fetchCalls.length, 0);

          setLaneSuccessCursors(nowMs - 31 * 60 * 1000);
          await withMockedDateNow(nowMs, async () => {
            const second = await twitterSyncService.runTwitterSyncAction({
              action: 'sync',
              userId: TEST_USER_ID,
              fetcherOverride: createCountingFetcher(fetchCalls),
            });
            assert.equal(second.ok, true);
          });
        }
      );

      assert.deepEqual(
        fetchCalls.map((item) => item.lane),
        ['timeline', 'replies']
      );
    }

    async function testForcedManualSyncBypassesRelayCoveredInterval() {
      cleanup();
      insertTrackedUser();

      const nowMs = Date.UTC(2026, 3, 24, 8, 0, 0);
      setLaneSuccessCursors(nowMs - 60_000);
      insertRelayTweet(nowMs - 30 * 60 * 1000);
      const fetchCalls: Array<{ lane: 'timeline' | 'replies'; sinceMs: number }> = [];

      await withSystemConfig(
        {
          twitterRelayCoveredPollingIntervalMinutes: 360,
          twitterUncoveredPollingIntervalMinutes: 30,
        },
        async () => {
          await withMockedDateNow(nowMs, async () => {
            const result = await twitterSyncService.runTwitterSyncAction({
              action: 'sync',
              userId: TEST_USER_ID,
              force: true,
              fetcherOverride: createCountingFetcher(fetchCalls),
            });
            assert.equal(result.ok, true);
          });
        }
      );

      assert.deepEqual(
        fetchCalls.map((item) => item.lane),
        ['timeline', 'replies']
      );
    }

    try {
      testStructuredIncompleteFetchDoesNotAdvanceCoverageCursor();
      await testNoopFetchDoesNotAdvanceCoverageCursor();
      await testSuccessfulSeedFetchStillAdvancesCoverageCursor();
      await testStructuredIncompleteFetchKeepsExistingWatermarkWindow();
      await testStructuredIncompleteFirstSyncKeepsBootstrapWindowSticky();
      await testStructuredCompleteEmptyBootstrapDoesNotStaySticky();
      await testRelayCoveredUserSkipsUntilCoveredIntervalElapsed();
      await testUncoveredUserUsesConfiguredUncoveredInterval();
      await testForcedManualSyncBypassesRelayCoveredInterval();
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
