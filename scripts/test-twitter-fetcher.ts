import assert from 'node:assert/strict';

import * as twitterFetcher from '@/lib/server/twitterFetcher';
import {
  buildTwitterFetcherProviderPlan,
  createFetcherResultMetadata,
  createTwitterFetcher,
  type TwitterFetcherProviderAttempt,
} from '@/lib/server/twitterFetcher';
import type {
  Twitter6551RouteCandidate,
  TwitterStructuredProviderRouteResult,
  TwitterXreadRouteCandidate,
} from '@/lib/server/twitterProviderRouter';

const NOW_MS = Date.UTC(2026, 3, 23, 12, 0, 0);

function createStructuredTweet(tweetId: string, options: { handle?: string; text?: string; createdAtMs?: number } = {}) {
  return {
    tweetId,
    authorId: `user-${options.handle || 'elonmusk'}`,
    authorHandle: options.handle || 'elonmusk',
    authorName: 'Elon Musk',
    fullText: options.text || `tweet ${tweetId}`,
    createdAtMs: options.createdAtMs || NOW_MS,
    conversationId: tweetId,
    replyToTweetId: undefined,
    quoteTweetId: undefined,
    replyCount: 0,
    retweetCount: 0,
    likeCount: 0,
    viewCount: 0,
    raw: { tweetId },
  };
}

function create6551Candidate(
  credentialId: string,
  apiKey: string,
  remainingUnits: number
): Twitter6551RouteCandidate {
  return {
    provider: '6551',
    credentialId,
    apiKey,
    dailyLimit: 100,
    remainingUnits,
    cooldownUntilMs: null,
    lastSuccessAtMs: NOW_MS - 1_000,
    lastFailureAtMs: null,
  };
}

function createXreadCandidate(apiKey: string): TwitterXreadRouteCandidate {
  return {
    provider: 'xread',
    credentialId: 'xread-default',
    apiKey,
  };
}

function createRouteResult(
  orderedProviders: Array<Twitter6551RouteCandidate | TwitterXreadRouteCandidate>
): TwitterStructuredProviderRouteResult {
  return {
    primaryProvider: orderedProviders[0] || null,
    orderedProviders,
    unavailableProviders: [],
  };
}

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

function createBudgetSnapshot(remainingUnitsByCredential: Record<string, number>) {
  return ({ provider, credentialId, nowMs, dailyLimit }: {
    provider: string;
    credentialId: string;
    nowMs: number;
    dailyLimit: number;
  }) => ({
    provider,
    credentialId,
    dateKey: '2026-04-23',
    successUnitsUsed: Math.max(0, dailyLimit - (remainingUnitsByCredential[credentialId] ?? dailyLimit)),
    dailyLimit,
    remainingUnits: remainingUnitsByCredential[credentialId] ?? dailyLimit,
    cooldownUntilMs: null,
    lastSuccessAtMs: nowMs - 1_000,
    lastFailureAtMs: null,
    lastError: null,
  });
}

function testProviderPlanIncludesStructuredAndCliFallbacks() {
  const plan = buildTwitterFetcherProviderPlan({
    intent: 'sync',
    providerMode: 'auto',
    route: createRouteResult([
      create6551Candidate('6551-key-2', 'key-2', 80),
      create6551Candidate('6551-key-1', 'key-1', 20),
      createXreadCandidate('xread-key'),
    ]),
  });

  assert.deepEqual(
    plan.map((item) => [item.provider, item.credentialId || null]),
    [
      ['6551', '6551-key-2'],
      ['6551', '6551-key-1'],
      ['xread', 'xread-default'],
      ['opencli', null],
      ['dokobot', null],
      ['fixture', null],
    ]
  );
}

function testProviderPlanPreservesFixtureOnlyMode() {
  const plan = buildTwitterFetcherProviderPlan({
    intent: 'sync',
    providerMode: 'fixture',
    route: {
      primaryProvider: null,
      orderedProviders: [],
      unavailableProviders: [],
    },
  });

  assert.deepEqual(plan.map((item) => item.provider), ['fixture']);
}

function testDokobotArtifactFilterStillRejectsNavigationChrome() {
  const artifactFilter = (twitterFetcher as Record<string, unknown>).isLikelyDokobotArtifactText as
    | ((value: string) => boolean)
    | undefined;

  assert.equal(typeof artifactFilter, 'function');
  assert.equal(artifactFilter?.('[20] /analytics'), true);
  assert.equal(artifactFilter?.('在meme币游戏中，人们在大金狗起飞前丢掉筹码'), false);
}

function testFetcherResultMetadataIncludesFallbackChain() {
  const attempts: TwitterFetcherProviderAttempt[] = [
    {
      provider: '6551',
      credentialId: '6551-key-1',
      ok: false,
    },
    {
      provider: 'xread',
      credentialId: 'xread-default',
      ok: true,
      chargedUnit: 0,
    },
  ];

  const metadata = createFetcherResultMetadata(attempts);
  assert.equal(metadata.provider, 'xread');
  assert.equal(metadata.credentialId, 'xread-default');
  assert.equal(metadata.chargedUnit, 0);
  assert.deepEqual(metadata.fallbackChain, ['6551', 'xread']);
}

async function testFetchUserTweetsUses6551Provider() {
  await withEnv(
    {
      TWITTER_6551_API_KEY_1: 'key-1',
      TWITTER_6551_API_KEY_2: 'key-2',
      TWITTER_XREAD_API_KEY: 'xread-key',
    },
    async () => {
      const successCalls: Array<Record<string, unknown>> = [];
      const failureCalls: Array<Record<string, unknown>> = [];
      const lookupCalls: string[] = [];
      const fetchCalls: string[] = [];
      const identityCache = new Map<string, { userId: string | null; provider: string }>();

      const fetcher = createTwitterFetcher(undefined, {
        client6551: {
          lookupUser: async ({ apiKey, username }: { apiKey: string; username: string }) => {
            lookupCalls.push(`${apiKey}:${username}`);
            return {
              provider: '6551',
              user: {
                id: '44196397',
                handle: 'elonmusk',
                raw: {},
              },
              raw: {},
            };
          },
          fetchUserTweets: async ({
            apiKey,
            username,
            lane,
          }: {
            apiKey: string;
            username: string;
            lane: 'timeline' | 'replies';
          }) => {
            fetchCalls.push(`${apiKey}:${username}:${lane}`);
            return {
              provider: '6551',
              tweets: [createStructuredTweet('1901')],
              hasMore: false,
              raw: {},
            };
          },
          fetchTweetById: async () => {
            throw new Error('unexpected detail fetch');
          },
        } as never,
        clientXread: {
          lookupUser: async () => {
            throw new Error('unexpected xread lookup');
          },
          fetchUserTweets: async () => {
            throw new Error('unexpected xread user fetch');
          },
          fetchTweetById: async () => {
            throw new Error('unexpected xread detail fetch');
          },
        } as never,
        readBudgetSnapshot: createBudgetSnapshot({
          '6551-key-1': 20,
          '6551-key-2': 80,
        }),
        readIdentityCache: (handle) => {
          const hit = identityCache.get(handle);
          return hit
            ? {
                handle,
                provider: hit.provider,
                userId: hit.userId,
                username: handle,
                resolvedAtMs: NOW_MS,
                expiresAtMs: NOW_MS + 60_000,
                lastError: null,
                updatedAtMs: NOW_MS,
              }
            : null;
        },
        upsertIdentityCache: (input) => {
          identityCache.set(input.handle, {
            provider: input.provider,
            userId: input.userId,
          });
        },
        markProviderSuccess: (input) => {
          successCalls.push(input as unknown as Record<string, unknown>);
        },
        markProviderFailure: (input) => {
          failureCalls.push(input as unknown as Record<string, unknown>);
        },
        now: () => NOW_MS,
      });

      const result = await fetcher.fetchUserTweets({
        handle: 'ElonMusk',
        lane: 'timeline',
        sinceMs: 0,
        maxItems: 5,
        intent: 'sync',
      });

      assert.equal(result.provider, '6551');
      assert.equal(result.credentialId, '6551-key-2');
      assert.equal(result.chargedUnit, 1);
      assert.deepEqual(result.fallbackChain, ['6551']);
      assert.equal(result.coverageEstablished, true);
      assert.equal(result.tweets.length, 1);
      assert.equal(result.tweets[0]?.tweetId, '1901');
      assert.equal(result.tweets[0]?.lane, 'timeline');
      assert.deepEqual(lookupCalls, ['key-2:elonmusk']);
      assert.deepEqual(fetchCalls, ['key-2:elonmusk:timeline']);
      assert.equal(successCalls.length, 2);
      assert.equal(failureCalls.length, 0);
      assert.equal(identityCache.get('elonmusk')?.userId, '44196397');
    }
  );
}

async function testStructuredProviderDoesNotClaimCoverageWhenPageHasMoreAndBoundaryNotReached() {
  await withEnv(
    {
      TWITTER_6551_API_KEY_1: 'key-1',
    },
    async () => {
      const fetcher = createTwitterFetcher(undefined, {
        client6551: {
          lookupUser: async () => ({
            provider: '6551',
            user: {
              id: '44196397',
              handle: 'elonmusk',
              raw: {},
            },
            raw: {},
          }),
          fetchUserTweets: async () => ({
            provider: '6551',
            tweets: [
              createStructuredTweet('1950', {
                createdAtMs: NOW_MS - 5 * 60 * 1000,
              }),
            ],
            hasMore: true,
            nextCursor: 'next-page',
            raw: {},
          }),
          fetchTweetById: async () => {
            throw new Error('unexpected detail fetch');
          },
        } as never,
        clientXread: {
          lookupUser: async () => {
            throw new Error('unexpected xread lookup');
          },
          fetchUserTweets: async () => {
            throw new Error('unexpected xread user fetch');
          },
          fetchTweetById: async () => {
            throw new Error('unexpected xread detail fetch');
          },
        } as never,
        routeChooser: () => createRouteResult([create6551Candidate('6551-key-1', 'key-1', 100)]),
        readBudgetSnapshot: createBudgetSnapshot({
          '6551-key-1': 100,
        }),
        readIdentityCache: () => ({
          handle: 'elonmusk',
          provider: '6551',
          userId: '44196397',
          username: 'elonmusk',
          resolvedAtMs: NOW_MS,
          expiresAtMs: NOW_MS + 60_000,
          lastError: null,
          updatedAtMs: NOW_MS,
        }),
        upsertIdentityCache: () => {},
        markProviderSuccess: () => {},
        markProviderFailure: () => {},
        now: () => NOW_MS,
      });

      const result = await fetcher.fetchUserTweets({
        handle: 'elonmusk',
        lane: 'timeline',
        sinceMs: NOW_MS - 10 * 60 * 1000,
        maxItems: 5,
        intent: 'sync',
      });

      assert.equal(result.provider, '6551');
      assert.equal(result.tweets.length, 1);
      assert.equal(result.coverageEstablished, false);
    }
  );
}

async function testFetchUserTweetsFallsBackToXread() {
  await withEnv(
    {
      TWITTER_6551_API_KEY_1: 'key-1',
      TWITTER_XREAD_API_KEY: 'xread-key',
    },
    async () => {
      const failureCalls: Array<Record<string, unknown>> = [];

      const fetcher = createTwitterFetcher(undefined, {
        client6551: {
          lookupUser: async () => {
            throw new Error('unexpected identity lookup');
          },
          fetchUserTweets: async () => {
            throw new Error('6551 down');
          },
          fetchTweetById: async () => {
            throw new Error('unexpected detail fetch');
          },
        } as never,
        clientXread: {
          lookupUser: async () => {
            throw new Error('unexpected xread lookup');
          },
          fetchUserTweets: async () => ({
            provider: 'xread',
            tweets: [createStructuredTweet('2901', { handle: 'elonmusk', text: 'xread timeline' })],
            hasMore: false,
            raw: {},
          }),
          fetchTweetById: async () => {
            throw new Error('unexpected xread detail fetch');
          },
        } as never,
        routeChooser: () =>
          createRouteResult([create6551Candidate('6551-key-1', 'key-1', 100), createXreadCandidate('xread-key')]),
        readBudgetSnapshot: createBudgetSnapshot({
          '6551-key-1': 100,
        }),
        readIdentityCache: () => ({
          handle: 'elonmusk',
          provider: '6551',
          userId: '44196397',
          username: 'elonmusk',
          resolvedAtMs: NOW_MS,
          expiresAtMs: NOW_MS + 60_000,
          lastError: null,
          updatedAtMs: NOW_MS,
        }),
        upsertIdentityCache: () => {},
        markProviderSuccess: () => {},
        markProviderFailure: (input) => {
          failureCalls.push(input as unknown as Record<string, unknown>);
        },
        now: () => NOW_MS,
      });

      const result = await fetcher.fetchUserTweets({
        handle: 'elonmusk',
        lane: 'timeline',
        sinceMs: 0,
        maxItems: 5,
        intent: 'sync',
      });

      assert.equal(result.provider, 'xread');
      assert.equal(result.credentialId, 'xread-default');
      assert.deepEqual(result.fallbackChain, ['6551', 'xread']);
      assert.equal(result.tweets[0]?.fullText, 'xread timeline');
      assert.equal(failureCalls.length, 1);
      assert.equal(failureCalls[0]?.credentialId, '6551-key-1');
    }
  );
}

async function testBackfillIntentPrefersXreadBeforeSecondary6551() {
  await withEnv(
    {
      TWITTER_6551_API_KEY_1: 'key-1',
      TWITTER_6551_API_KEY_2: 'key-2',
      TWITTER_XREAD_API_KEY: 'xread-key',
    },
    async () => {
      const makeFetcher = () =>
        createTwitterFetcher(undefined, {
          client6551: {
            lookupUser: async () => {
              throw new Error('unexpected lookup');
            },
            fetchUserTweets: async ({ apiKey }: { apiKey: string }) => {
              if (apiKey === 'key-1') {
                throw new Error('primary key failure');
              }
              return {
                provider: '6551',
                tweets: [createStructuredTweet('3901', { text: 'second 6551 key' })],
                hasMore: false,
                raw: {},
              };
            },
            fetchTweetById: async () => {
              throw new Error('unexpected detail fetch');
            },
          } as never,
          clientXread: {
            lookupUser: async () => {
              throw new Error('unexpected xread lookup');
            },
            fetchUserTweets: async () => ({
              provider: 'xread',
              tweets: [createStructuredTweet('3902', { text: 'xread backfill' })],
              hasMore: false,
              raw: {},
            }),
            fetchTweetById: async () => {
              throw new Error('unexpected xread detail fetch');
            },
          } as never,
          readBudgetSnapshot: createBudgetSnapshot({
            '6551-key-1': 100,
            '6551-key-2': 99,
          }),
          readIdentityCache: () => ({
            handle: 'elonmusk',
            provider: '6551',
            userId: '44196397',
            username: 'elonmusk',
            resolvedAtMs: NOW_MS,
            expiresAtMs: NOW_MS + 60_000,
            lastError: null,
            updatedAtMs: NOW_MS,
          }),
          upsertIdentityCache: () => {},
          markProviderSuccess: () => {},
          markProviderFailure: () => {},
          now: () => NOW_MS,
        });

      const syncResult = await makeFetcher().fetchUserTweets({
        handle: 'elonmusk',
        lane: 'timeline',
        sinceMs: 0,
        maxItems: 5,
        intent: 'sync',
      });
      assert.equal(syncResult.provider, '6551');
      assert.equal(syncResult.credentialId, '6551-key-2');
      assert.deepEqual(syncResult.fallbackChain, ['6551', '6551']);
      assert.equal(syncResult.tweets[0]?.fullText, 'second 6551 key');

      const backfillResult = await makeFetcher().fetchUserTweets({
        handle: 'elonmusk',
        lane: 'timeline',
        sinceMs: 0,
        maxItems: 5,
        intent: 'backfill',
      });
      assert.equal(backfillResult.provider, 'xread');
      assert.equal(backfillResult.credentialId, 'xread-default');
      assert.deepEqual(backfillResult.fallbackChain, ['6551', 'xread']);
      assert.equal(backfillResult.tweets[0]?.fullText, 'xread backfill');
    }
  );
}

async function testFetchTweetsByIdsUses6551ChargedUnits() {
  await withEnv(
    {
      TWITTER_6551_API_KEY_1: 'key-1',
    },
    async () => {
      const successCalls: Array<Record<string, unknown>> = [];

      const fetcher = createTwitterFetcher(undefined, {
        client6551: {
          lookupUser: async () => {
            throw new Error('unexpected lookup');
          },
          fetchUserTweets: async () => {
            throw new Error('unexpected user fetch');
          },
          fetchTweetById: async ({ tweetId }: { tweetId: string }) => ({
            provider: '6551',
            tweet: createStructuredTweet(tweetId, { text: `detail ${tweetId}` }),
            raw: {},
          }),
        } as never,
        clientXread: {
          lookupUser: async () => {
            throw new Error('unexpected xread lookup');
          },
          fetchUserTweets: async () => {
            throw new Error('unexpected xread user fetch');
          },
          fetchTweetById: async () => {
            throw new Error('unexpected xread detail fetch');
          },
        } as never,
        routeChooser: () => createRouteResult([create6551Candidate('6551-key-1', 'key-1', 100)]),
        readBudgetSnapshot: createBudgetSnapshot({
          '6551-key-1': 100,
        }),
        readIdentityCache: () => null,
        upsertIdentityCache: () => {},
        markProviderSuccess: (input) => {
          successCalls.push(input as unknown as Record<string, unknown>);
        },
        markProviderFailure: () => {},
        now: () => NOW_MS,
      });

      const result = await fetcher.fetchTweetsByIds({
        ids: ['501', '502'],
        intent: 'detail',
      });

      assert.equal(result.provider, '6551');
      assert.equal(result.credentialId, '6551-key-1');
      assert.equal(result.chargedUnit, 2);
      assert.deepEqual(result.fallbackChain, ['6551']);
      assert.deepEqual(
        result.tweets.map((tweet) => tweet.tweetId),
        ['501', '502']
      );
      assert.equal(successCalls.length, 1);
      assert.equal(successCalls[0]?.successUnits, undefined);
    }
  );
}

async function testFetchTweetsByIdsFallsBackWhen6551ReturnsNull() {
  await withEnv(
    {
      TWITTER_6551_API_KEY_1: 'key-1',
      TWITTER_XREAD_API_KEY: 'xread-key',
    },
    async () => {
      const successCalls: Array<Record<string, unknown>> = [];

      const fetcher = createTwitterFetcher(undefined, {
        client6551: {
          lookupUser: async () => {
            throw new Error('unexpected lookup');
          },
          fetchUserTweets: async () => {
            throw new Error('unexpected user fetch');
          },
          fetchTweetById: async () => ({
            provider: '6551',
            tweet: null,
            raw: {},
          }),
        } as never,
        clientXread: {
          lookupUser: async () => {
            throw new Error('unexpected xread lookup');
          },
          fetchUserTweets: async () => {
            throw new Error('unexpected xread user fetch');
          },
          fetchTweetById: async ({ tweetId }: { tweetId: string }) => ({
            provider: 'xread',
            tweet: createStructuredTweet(tweetId, { text: `xread detail ${tweetId}` }),
            raw: {},
          }),
        } as never,
        routeChooser: () =>
          createRouteResult([create6551Candidate('6551-key-1', 'key-1', 100), createXreadCandidate('xread-key')]),
        readBudgetSnapshot: createBudgetSnapshot({
          '6551-key-1': 100,
        }),
        readIdentityCache: () => null,
        upsertIdentityCache: () => {},
        markProviderSuccess: (input) => {
          successCalls.push(input as unknown as Record<string, unknown>);
        },
        markProviderFailure: () => {},
        now: () => NOW_MS,
      });

      const result = await fetcher.fetchTweetsByIds({
        ids: ['601'],
        intent: 'detail',
      });

      assert.equal(result.provider, 'xread');
      assert.equal(result.credentialId, 'xread-default');
      assert.deepEqual(result.fallbackChain, ['6551', 'xread']);
      assert.deepEqual(
        result.tweets.map((tweet) => tweet.tweetId),
        ['601']
      );
      assert.equal(result.tweets[0]?.fullText, 'xread detail 601');
      assert.equal(successCalls.length, 0);
    }
  );
}

async function testFetchTweetsByIdsMergesMixedProviderResultsInRequestOrder() {
  await withEnv(
    {
      TWITTER_6551_API_KEY_1: 'key-1',
      TWITTER_XREAD_API_KEY: 'xread-key',
    },
    async () => {
      const fetcher = createTwitterFetcher(undefined, {
        client6551: {
          lookupUser: async () => {
            throw new Error('unexpected lookup');
          },
          fetchUserTweets: async () => {
            throw new Error('unexpected user fetch');
          },
          fetchTweetById: async ({ tweetId }: { tweetId: string }) => ({
            provider: '6551',
            tweet:
              tweetId === '701'
                ? createStructuredTweet(tweetId, { text: `6551 detail ${tweetId}` })
                : null,
            raw: {},
          }),
        } as never,
        clientXread: {
          lookupUser: async () => {
            throw new Error('unexpected xread lookup');
          },
          fetchUserTweets: async () => {
            throw new Error('unexpected xread user fetch');
          },
          fetchTweetById: async ({ tweetId }: { tweetId: string }) => ({
            provider: 'xread',
            tweet: createStructuredTweet(tweetId, { text: `xread detail ${tweetId}` }),
            raw: {},
          }),
        } as never,
        routeChooser: () =>
          createRouteResult([create6551Candidate('6551-key-1', 'key-1', 100), createXreadCandidate('xread-key')]),
        readBudgetSnapshot: createBudgetSnapshot({
          '6551-key-1': 100,
        }),
        readIdentityCache: () => null,
        upsertIdentityCache: () => {},
        markProviderSuccess: () => {},
        markProviderFailure: () => {},
        now: () => NOW_MS,
      });

      const result = await fetcher.fetchTweetsByIds({
        ids: ['701', '702'],
        intent: 'detail',
      });

      assert.equal(result.provider, '6551');
      assert.equal(result.credentialId, '6551-key-1');
      assert.equal(result.chargedUnit, 2);
      assert.deepEqual(result.fallbackChain, ['6551', 'xread']);
      assert.deepEqual(
        result.tweets.map((tweet) => tweet.tweetId),
        ['701', '702']
      );
      assert.deepEqual(
        result.tweets.map((tweet) => tweet.fullText),
        ['6551 detail 701', 'xread detail 702']
      );
    }
  );
}

async function testFetchTweetsByIdsKeepsChargedUnitsOnNullOnlyMissWithoutFallbackHit() {
  await withEnv(
    {
      TWITTER_FETCH_PROVIDER: '6551',
      TWITTER_6551_API_KEY_1: 'key-1',
      TWITTER_XREAD_API_KEY: undefined,
    },
    async () => {
      const fetcher = createTwitterFetcher(undefined, {
        client6551: {
          lookupUser: async () => {
            throw new Error('unexpected lookup');
          },
          fetchUserTweets: async () => {
            throw new Error('unexpected user fetch');
          },
          fetchTweetById: async () => ({
            provider: '6551',
            tweet: null,
            raw: {},
          }),
        } as never,
        clientXread: {
          lookupUser: async () => {
            throw new Error('unexpected xread lookup');
          },
          fetchUserTweets: async () => {
            throw new Error('unexpected xread user fetch');
          },
          fetchTweetById: async () => {
            throw new Error('unexpected xread detail fetch');
          },
        } as never,
        routeChooser: () => createRouteResult([create6551Candidate('6551-key-1', 'key-1', 100)]),
        readBudgetSnapshot: createBudgetSnapshot({
          '6551-key-1': 100,
        }),
        readIdentityCache: () => null,
        upsertIdentityCache: () => {},
        markProviderSuccess: () => {},
        markProviderFailure: () => {},
        now: () => NOW_MS,
      });

      const result = await fetcher.fetchTweetsByIds({
        ids: ['801'],
        intent: 'detail',
      });

      assert.equal(result.provider, 'noop');
      assert.equal(result.chargedUnit, 1);
      assert.deepEqual(result.fallbackChain, ['6551']);
      assert.equal(result.tweets.length, 0);
    }
  );
}

async function testSeedResultsStillShortCircuitFetcher() {
  const fetcher = createTwitterFetcher({
    elonmusk: {
      timeline: [
        {
          tweetId: 'seed-1',
          authorHandle: 'elonmusk',
          authorName: 'Elon Musk',
          fullText: 'seed timeline',
          createdAtMs: NOW_MS,
          conversationId: 'seed-1',
          replyToTweetId: undefined,
          quoteTweetId: undefined,
          replyCount: 0,
          retweetCount: 0,
          likeCount: 0,
          viewCount: 0,
          source: {},
        },
      ],
      byId: [
        {
          tweetId: 'seed-2',
          authorHandle: 'elonmusk',
          authorName: 'Elon Musk',
          fullText: 'seed detail',
          createdAtMs: NOW_MS,
          conversationId: 'seed-2',
          replyToTweetId: undefined,
          quoteTweetId: undefined,
          replyCount: 0,
          retweetCount: 0,
          likeCount: 0,
          viewCount: 0,
          source: {},
        },
      ],
    },
  });

  const laneResult = await fetcher.fetchUserTweets({
    handle: 'elonmusk',
    lane: 'timeline',
    sinceMs: 0,
    maxItems: 5,
  });
  assert.equal(laneResult.provider, 'seed');
  assert.deepEqual(laneResult.fallbackChain, ['seed']);
  assert.equal(laneResult.tweets[0]?.tweetId, 'seed-1');

  const detailResult = await fetcher.fetchTweetsByIds({
    ids: ['seed-2'],
  });
  assert.equal(detailResult.provider, 'seed');
  assert.deepEqual(detailResult.fallbackChain, ['seed']);
  assert.equal(detailResult.tweets[0]?.tweetId, 'seed-2');
}

async function main() {
  testProviderPlanIncludesStructuredAndCliFallbacks();
  testProviderPlanPreservesFixtureOnlyMode();
  testDokobotArtifactFilterStillRejectsNavigationChrome();
  testFetcherResultMetadataIncludesFallbackChain();
  await testFetchUserTweetsUses6551Provider();
  await testStructuredProviderDoesNotClaimCoverageWhenPageHasMoreAndBoundaryNotReached();
  await testFetchUserTweetsFallsBackToXread();
  await testBackfillIntentPrefersXreadBeforeSecondary6551();
  await testFetchTweetsByIdsUses6551ChargedUnits();
  await testFetchTweetsByIdsFallsBackWhen6551ReturnsNull();
  await testFetchTweetsByIdsMergesMixedProviderResultsInRequestOrder();
  await testFetchTweetsByIdsKeepsChargedUnitsOnNullOnlyMissWithoutFallbackHit();
  await testSeedResultsStillShortCircuitFetcher();
  console.log('twitter fetcher tests: ok');
}

main();
