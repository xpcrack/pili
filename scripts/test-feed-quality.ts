import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import {
  buildQualityIndex,
  filterHighQualityOnly,
  isHighQualityUser,
  scoreFeedItem,
  sortFeedByQuality,
  type UserQualitySnapshot,
} from '@/lib/feedQuality';
import type { Activity, User } from '@/types';

function user(id: string): User {
  return { id, name: id, avatar: '', addresses: [] } as unknown as User;
}

function item(userId: string, overrides: Partial<Activity['metadata']> = {}, timestamp = 1_000) {
  return {
    user: user(userId),
    activity: {
      id: `${userId}-${timestamp}`,
      timestamp,
      source: 'blockchain',
      type: 'transfer',
      metadata: { txActionVariant: 'open', tradeAmountUsdAtTx: 1_000, ...overrides },
    } as unknown as Activity,
  };
}

function snapshot(overrides: Partial<UserQualitySnapshot> = {}): UserQualitySnapshot {
  return { userId: 'u1', winRate: 0.6, roundTrips: 50, realizedPnlUsd: 1_000, medianMultiple: 1.1, ...overrides };
}

function testHighQualityGate() {
  assert.ok(isHighQualityUser(snapshot()));
  assert.ok(!isHighQualityUser(undefined), 'no measurement is not high quality');
  assert.ok(!isHighQualityUser(snapshot({ roundTrips: 9 })), 'sample floor applies');
  assert.ok(!isHighQualityUser(snapshot({ winRate: 0.49 })));
  assert.ok(!isHighQualityUser(snapshot({ winRate: null })));
  assert.ok(isHighQualityUser(snapshot({ winRate: 0.5, roundTrips: 10 })), 'thresholds inclusive');
}

function testProvenTraderOutranksUnmeasured() {
  const index = buildQualityIndex([snapshot({ userId: 'good' }), snapshot({ userId: 'bad', winRate: 0.1 })]);
  const good = scoreFeedItem(item('good'), index);
  const bad = scoreFeedItem(item('bad'), index);
  const unknown = scoreFeedItem(item('unknown'), index);
  assert.ok(good > bad, 'higher win rate ranks higher');
  assert.ok(good > unknown, 'measured winner outranks unmeasured');
}

function testEntryOutranksExit() {
  const index = buildQualityIndex([snapshot()]);
  const open = scoreFeedItem(item('u1', { txActionVariant: 'open' }), index);
  const add = scoreFeedItem(item('u1', { txActionVariant: 'add' }), index);
  const reduce = scoreFeedItem(item('u1', { txActionVariant: 'reduce' }), index);
  assert.ok(open > add && add > reduce, `expected open > add > reduce, got ${open}/${add}/${reduce}`);
}

function testSizeMatters() {
  const index = buildQualityIndex([snapshot()]);
  const big = scoreFeedItem(item('u1', { tradeAmountUsdAtTx: 100_000 }), index);
  const small = scoreFeedItem(item('u1', { tradeAmountUsdAtTx: 50 }), index);
  assert.ok(big > small);
}

function testSortIsStableAndRecencyBreaksTies() {
  const index = buildQualityIndex([snapshot({ userId: 'u1' })]);
  const sorted = sortFeedByQuality(
    [item('u1', {}, 1_000), item('u1', {}, 3_000), item('u1', {}, 2_000)],
    index
  );
  assert.deepEqual(
    sorted.map((entry) => entry.activity.timestamp),
    [3_000, 2_000, 1_000],
    'equal scores must fall back to newest-first'
  );
}

function testSortDoesNotMutateInput() {
  const index = buildQualityIndex([snapshot({ userId: 'u1' })]);
  const input = [item('u1', {}, 1_000), item('u1', {}, 3_000)];
  const before = input.map((entry) => entry.activity.timestamp);
  sortFeedByQuality(input, index);
  assert.deepEqual(input.map((entry) => entry.activity.timestamp), before, 'input array must not be reordered');
}

function testSortKeepsEveryRow() {
  const index = buildQualityIndex([snapshot({ userId: 'u1' })]);
  const input = [item('u1'), item('u2'), item('u3')];
  assert.equal(sortFeedByQuality(input, index).length, 3, 'quality sort reorders, it never drops');
}

function testFilterDropsUnmeasured() {
  const index = buildQualityIndex([snapshot({ userId: 'good' }), snapshot({ userId: 'thin', roundTrips: 2 })]);
  const filtered = filterHighQualityOnly([item('good'), item('thin'), item('unknown')], index);
  assert.deepEqual(filtered.map((entry) => entry.user.id), ['good']);
}

function testEmptyIndex() {
  const index = buildQualityIndex(null);
  assert.equal(index.size, 0);
  assert.equal(sortFeedByQuality([item('u1')], index).length, 1);
  assert.equal(filterHighQualityOnly([item('u1')], index).length, 0);
}

async function run() {
  testHighQualityGate();
  testProvenTraderOutranksUnmeasured();
  testEntryOutranksExit();
  testSizeMatters();
  testSortIsStableAndRecencyBreaksTies();
  testSortDoesNotMutateInput();
  testSortKeepsEveryRow();
  testFilterDropsUnmeasured();
  testEmptyIndex();
  console.log('feed-quality: all assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
