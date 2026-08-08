import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import { runLiveMonitorCycle } from '@/lib/server/liveMonitorRuntime';
import { shouldDeferHoldingsRefreshForLiveFeed } from '@/lib/server/holdingsRefreshRuntime';
import type { User } from '@/types';

const activityResponse = { items: [], next: null, raw: null };

function makeUser(id: string, wallet: string): User {
  return {
    id,
    name: id,
    handle: id,
    avatar: '',
    addresses: [
      {
        address: wallet,
        name: '#1',
        chain: 'base',
        totalAssetUsd: 10,
        assetUpdatedAt: 1,
      },
    ],
    totalAssetUsd: 10,
    historicalMaxAssetUsd: 10,
    assetUpdatedAt: 1,
    tags: [],
  };
}

function makeDoorbell(wallet: string, userId: string) {
  return {
    walletLower: wallet.toLowerCase(),
    address: wallet,
    userId,
    chains: ['base'],
    source: 'xxyy',
    dueAtMs: 0,
    leaseToken: `lease-${userId}`,
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testFastWalletCommitsBeforeSlowWalletFinishes() {
  const fastWallet = '0xabc0000000000000000000000000000000000001';
  const slowWallet = '0xabc0000000000000000000000000000000000002';
  const users = [makeUser('fast-user', fastWallet), makeUser('slow-user', slowWallet)];
  let releaseSlow!: (value: typeof activityResponse) => void;
  const slowResponse = new Promise<typeof activityResponse>((resolve) => {
    releaseSlow = resolve;
  });
  let fastCommitted = false;
  let resolveFastCommit!: () => void;
  const fastCommit = new Promise<void>((resolve) => {
    resolveFastCommit = resolve;
  });
  const acked: string[] = [];

  const cycle = runLiveMonitorCycle({
    listUsers: () => users,
    env: {
      PILI_LIVE_SOURCE: 'alchemy',
      PILI_ALCHEMY_INBOX_URL: 'https://example.invalid/inbox',
      PILI_ALCHEMY_PULL_TOKEN: 'token',
      PILI_LIVE_MAX_CONCURRENCY: '2',
      PILI_LIVE_CYCLE_MS: '1',
    },
    now: () => Date.now() + 10 * 60_000,
    pullInbox: async () => ({
      since_id: 0,
      next_id: 0,
      events: 0,
      wallets: [],
      raw_events: [],
    }),
    claimDoorbells: () => [makeDoorbell(fastWallet, 'fast-user'), makeDoorbell(slowWallet, 'slow-user')],
    fetchActivity: async ({ wallet }) => {
      if (wallet === slowWallet) return slowResponse;
      return {
        items: [
          {
            event_type: 'buy',
            timestamp: Math.floor(Date.now() / 1000),
            tx_hash: '0xfast-live',
            token: { address: '0xfeed', symbol: 'FEED' },
            token_amount: '1',
            cost_usd: '10',
            price_usd: '10',
          },
        ] as never,
        next: null,
        raw: null,
      };
    },
    upsertTrades: ({ user }) => {
      if (user.id === 'fast-user') {
        fastCommitted = true;
        resolveFastCommit();
      }
      return { upserted: 1 };
    },
    ackDoorbells: (claims) => {
      acked.push(...claims.map((claim) => claim.walletLower));
      return claims.length;
    },
    nackDoorbells: () => 0,
    enqueueHoldingsRefresh: () => ({ enqueued: true, key: 'base:feed' }),
    gmgnCooldownRemainingMs: () => 0,
  });

  const committedBeforeSlowFinished = await Promise.race([
    fastCommit.then(() => true),
    delay(100).then(() => false),
  ]);

  // Release the slow request only after observing whether the fast wallet was
  // committed independently; this keeps the regression test deterministic and fast.
  releaseSlow(activityResponse);
  await cycle;

  assert.equal(committedBeforeSlowFinished, true, 'fast wallet must reach Feed before a slow wallet finishes');
  assert.equal(fastCommitted, true);
  assert.ok(acked.includes(fastWallet.toLowerCase()), 'fast wallet doorbell should be acked independently');
}

async function testSlowWalletTimesOutAndNacks() {
  const wallet = '0xabc0000000000000000000000000000000000003';
  const user = makeUser('timeout-user', wallet);
  let release!: (value: typeof activityResponse) => void;
  const pending = new Promise<typeof activityResponse>((resolve) => {
    release = resolve;
  });
  const nacked: string[] = [];

  const cycle = runLiveMonitorCycle({
    listUsers: () => [user],
    env: {
      PILI_LIVE_SOURCE: 'alchemy',
      PILI_ALCHEMY_INBOX_URL: 'https://example.invalid/inbox',
      PILI_ALCHEMY_PULL_TOKEN: 'token',
      PILI_LIVE_ACTIVITY_TIMEOUT_MS: '20',
      PILI_LIVE_CYCLE_MS: '1',
    },
    now: () => Date.now() + 10 * 60_000,
    pullInbox: async () => ({
      since_id: 0,
      next_id: 0,
      events: 0,
      wallets: [],
      raw_events: [],
    }),
    claimDoorbells: () => [makeDoorbell(wallet, 'timeout-user')],
    fetchActivity: async () => pending,
    upsertTrades: () => ({ upserted: 0 }),
    ackDoorbells: () => 0,
    nackDoorbells: (claims) => {
      nacked.push(...claims.map((claim) => claim.walletLower));
      return claims.length;
    },
    enqueueHoldingsRefresh: () => ({ enqueued: true, key: 'base:timeout' }),
    gmgnCooldownRemainingMs: () => 0,
  });

  const finished = await Promise.race([cycle.then(() => true), delay(100).then(() => false)]);
  if (!finished) release(activityResponse);
  await cycle;

  assert.equal(finished, true, 'one stuck wallet must not hold the live-monitor cycle forever');
  assert.deepEqual(nacked, [wallet.toLowerCase()]);
}

async function testDoorbellClaimLimitIsConfigurable() {
  let observedLimit: number | undefined;
  await runLiveMonitorCycle({
    listUsers: () => [],
    env: {
      PILI_LIVE_SOURCE: 'alchemy',
      PILI_ALCHEMY_INBOX_URL: 'https://example.invalid/inbox',
      PILI_ALCHEMY_PULL_TOKEN: 'token',
      PILI_LIVE_DOORBELL_CLAIM_LIMIT: '2',
    },
    now: () => Date.now() + 10 * 60_000,
    pullInbox: async () => ({
      since_id: 0,
      next_id: 0,
      events: 0,
      wallets: [],
      raw_events: [],
    }),
    claimDoorbells: (params) => {
      observedLimit = params?.limit;
      return [];
    },
    gmgnCooldownRemainingMs: () => 0,
  });

  assert.equal(observedLimit, 2, 'live monitor should pass the configured small claim limit to SQLite');
}

async function testAlchemyInboxFailureDoesNotBlockDoorbells() {
  const wallet = '0xabc0000000000000000000000000000000000004';
  const user = makeUser('inbox-failure-user', wallet);
  let fetched = false;
  const acked: string[] = [];

  const result = await runLiveMonitorCycle({
    listUsers: () => [user],
    env: {
      PILI_LIVE_SOURCE: 'alchemy',
      PILI_ALCHEMY_INBOX_URL: 'https://example.invalid/inbox',
      PILI_ALCHEMY_PULL_TOKEN: 'token',
      PILI_LIVE_CYCLE_MS: '1',
    },
    now: () => Date.now() + 10 * 60_000,
    pullInbox: async () => {
      fetched = true;
      throw new Error('inbox unavailable');
    },
    claimDoorbells: () => [makeDoorbell(wallet, 'inbox-failure-user')],
    fetchActivity: async () => activityResponse,
    upsertTrades: () => ({ upserted: 0 }),
    ackDoorbells: (claims) => {
      acked.push(...claims.map((claim) => claim.walletLower));
      return claims.length;
    },
    nackDoorbells: () => 0,
    enqueueHoldingsRefresh: () => ({ enqueued: true, key: 'base:inbox-failure' }),
    gmgnCooldownRemainingMs: () => 0,
  });

  assert.equal(fetched, true);
  assert.deepEqual(acked, [wallet.toLowerCase()], 'XXYY doorbell should still be acked after inbox failure');
  assert.equal(result.summary.xxyyDoorbells, 1);
  assert.match(result.lastError || '', /inbox unavailable/);
}

function testHoldingsYieldToPendingLiveFeed() {
  assert.equal(shouldDeferHoldingsRefreshForLiveFeed(0), false);
  assert.equal(shouldDeferHoldingsRefreshForLiveFeed(1), true);
  assert.equal(shouldDeferHoldingsRefreshForLiveFeed(40), true);
}

async function run() {
  await testFastWalletCommitsBeforeSlowWalletFinishes();
  await testSlowWalletTimesOutAndNacks();
  await testDoorbellClaimLimitIsConfigurable();
  await testAlchemyInboxFailureDoesNotBlockDoorbells();
  testHoldingsYieldToPendingLiveFeed();
  console.log('live-monitor reliability tests: ok');
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
