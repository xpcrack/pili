import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import {
  LEG_FOLLOWUP_SOURCE,
  mergeDoorbellSource,
  readLegFollowupMs,
  runLiveMonitorCycle,
} from '@/lib/server/liveMonitorRuntime';
import type { User } from '@/types';

const WALLET = '0xabc0000000000000000000000000000000000001';
const TOKEN = '0xdef0000000000000000000000000000000000002';

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
    mainstreamAssetUsd: 0,
    assetUpdatedAt: 1,
    tags: [],
  };
}

function makeDoorbell(wallet: string, userId: string, source = 'xxyy') {
  return {
    walletLower: wallet.toLowerCase(),
    address: wallet,
    userId,
    chains: ['base'],
    source,
    dueAtMs: 0,
    leaseToken: `lease-${userId}`,
  };
}

function activityItem(timestampSec: number) {
  return {
    timestamp: timestampSec,
    event_type: 'sell',
    token: { address: TOKEN, symbol: 'AI' },
    cost_usd: 4509,
    tx_hash: '0xtx1',
  };
}

type Ring = { address: string; userId: string; chain?: string | null; source?: string; debounceMs?: number };

function baseDeps(rings: Ring[], opts?: { upserted?: number; env?: Record<string, string> }) {
  const user = makeUser('u1', WALLET);
  return {
    deps: {
      listUsers: () => [user],
      claimDoorbells: () => [makeDoorbell(WALLET, 'u1')],
      ackDoorbells: () => 1,
      nackDoorbells: () => 0,
      enqueueDoorbell: (input: Ring & Record<string, unknown>) => {
        rings.push(input as Ring);
        return { enqueued: true, walletLower: WALLET };
      },
      enqueueHoldingsRefresh: () => {},
      gmgnCooldownRemainingMs: () => 0,
      fetchActivity: async () => ({
        items: [activityItem(Math.floor(Date.now() / 1000) - 60)],
        next: null,
        raw: null,
      }),
      upsertTrades: () => ({ upserted: opts?.upserted ?? 1 }),
      env: { PILI_LIVE_SOURCE: 'alchemy', ...(opts?.env ?? {}) },
    } as Parameters<typeof runLiveMonitorCycle>[0],
  };
}

async function testFollowupRingsAfterNewTrades() {
  const rings: Ring[] = [];
  const { deps } = baseDeps(rings);
  const result = await runLiveMonitorCycle(deps);
  assert.equal(rings.length, 1, `expected exactly one follow-up ring, got ${rings.length}`);
  assert.equal(rings[0]!.source, LEG_FOLLOWUP_SOURCE);
  assert.equal(rings[0]!.address, WALLET);
  assert.equal(rings[0]!.userId, 'u1');
  assert.equal(rings[0]!.chain, 'base', 'follow-up must scan the doorbell chain');
  assert.equal(rings[0]!.debounceMs, 120_000);
  assert.ok(result.summary.tradesUpserted >= 1);
}

async function testFollowupSourceDoesNotRering() {
  const rings: Ring[] = [];
  const { deps } = baseDeps(rings);
  const claim = makeDoorbell(WALLET, 'u1', LEG_FOLLOWUP_SOURCE);
  (deps as Record<string, unknown>).claimDoorbells = () => [claim];
  await runLiveMonitorCycle(deps);
  assert.equal(rings.length, 0, 'leg-followup scans must not ring again (bounded chain)');
}

async function testNoRingWhenNothingNewUpserted() {
  const rings: Ring[] = [];
  const { deps } = baseDeps(rings, { upserted: 0 });
  await runLiveMonitorCycle(deps);
  assert.equal(rings.length, 0, 'no new trades ⇒ no follow-up ring');
}

async function testDisabledViaEnv() {
  const rings: Ring[] = [];
  const { deps } = baseDeps(rings, { env: { PILI_LIVE_FOLLOWUP_MS: '0' } });
  await runLiveMonitorCycle(deps);
  assert.equal(rings.length, 0, 'PILI_LIVE_FOLLOWUP_MS=0 disables follow-up');
}

async function testFollowupRingsForAlchemyOnlyTargets() {
  const rings: Ring[] = [];
  const user = makeUser('u1', WALLET);
  await runLiveMonitorCycle({
    listUsers: () => [user],
    claimDoorbells: () => [],
    ackDoorbells: () => 1,
    nackDoorbells: () => 0,
    enqueueDoorbell: (input: Ring & Record<string, unknown>) => {
      rings.push(input as Ring);
      return { enqueued: true, walletLower: WALLET };
    },
    enqueueHoldingsRefresh: () => {},
    gmgnCooldownRemainingMs: () => 0,
    pullInbox: async () => ({
      next_id: 0,
      events: 0,
      wallets: [WALLET],
      raw_events: [],
    }),
    fetchActivity: async () => ({
      items: [activityItem(Math.floor(Date.now() / 1000) - 60)],
      next: null,
      raw: null,
    }),
    upsertTrades: () => ({ upserted: 1 }),
    env: {
      PILI_LIVE_SOURCE: 'alchemy',
      PILI_ALCHEMY_INBOX_URL: 'https://inbox.example',
      PILI_ALCHEMY_PULL_TOKEN: 't',
    },
  } as Parameters<typeof runLiveMonitorCycle>[0]);
  // eventChains 空 ⇒ 按「产出成交的链」补铃；mock 每条链都返回成交。
  assert.equal(rings.length, 3, 'one follow-up per chain that produced trades');
  assert.deepEqual(rings.map((r) => r.chain), ['base', 'ethereum', 'bsc']);
  assert.ok(rings.every((r) => r.source === 'leg-followup'));
  assert.ok(rings.every((r) => r.address === WALLET && r.userId === 'u1'));
}

function testMergeDoorbellSource() {
  assert.equal(mergeDoorbellSource(null, 'xxyy'), 'xxyy');
  assert.equal(mergeDoorbellSource(LEG_FOLLOWUP_SOURCE, 'xxyy'), 'xxyy', 'real ring overrides follow-up');
  assert.equal(mergeDoorbellSource('xxyy', LEG_FOLLOWUP_SOURCE), 'xxyy', 'follow-up never overrides real ring');
  assert.equal(mergeDoorbellSource(null, null), null);
  assert.equal(mergeDoorbellSource(LEG_FOLLOWUP_SOURCE, null), LEG_FOLLOWUP_SOURCE);
  assert.equal(mergeDoorbellSource('xxyy', ''), 'xxyy');
}

function testReadLegFollowupMs() {
  assert.equal(readLegFollowupMs({}), 120_000);
  assert.equal(readLegFollowupMs({ PILI_LIVE_FOLLOWUP_MS: '0' }), 0);
  assert.equal(readLegFollowupMs({ PILI_LIVE_FOLLOWUP_MS: '45000' }), 45_000);
  assert.equal(readLegFollowupMs({ PILI_LIVE_FOLLOWUP_MS: 'abc' }), 120_000);
  assert.equal(readLegFollowupMs({ PILI_LIVE_FOLLOWUP_MS: '-5' }), 0);
}

(async () => {
  testMergeDoorbellSource();
  testReadLegFollowupMs();
  await testFollowupRingsAfterNewTrades();
  await testFollowupSourceDoesNotRering();
  await testNoRingWhenNothingNewUpserted();
  await testDisabledViaEnv();
  await testFollowupRingsForAlchemyOnlyTargets();
  console.log('test-leg-followup: all assertions passed');
})();
