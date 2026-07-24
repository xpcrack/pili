import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import { createWalletActivityBackfillQueue } from '@/lib/server/walletActivityBackfillQueue';
import type { User } from '@/types';

function makeUser(): User {
  return {
    id: 'u1',
    name: 'Tester',
    handle: 'tester',
    avatar: '',
    twitter: null,
    twitterUserId: null,
    twitterAvatarUrl: null,
    telegram: null,
    telegrams: [],
    tags: [],
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    addresses: [
      {
        address: '0x57841A6640bf42d4F2aA7D87308db3c962C3945C',
        name: '',
        chain: 'base',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
    ],
  } as User;
}

async function main() {
  const calls: Array<{ address: string; days?: number }> = [];
  const marks: Array<{ kind: 'ok' | 'fail'; address: string; days?: number; error?: string }> = [];
  const queue = createWalletActivityBackfillQueue({
    memoryOnly: true,
    debounceMs: 0,
    listUsers: () => [makeUser()],
    backfill: async (params) => {
      calls.push({ address: params.address, days: params.days });
      return {
        address: params.address,
        rawCount: 3,
        tradeCount: 2,
        upserted: 2,
        chainsOk: ['base'],
        chainsFailed: [],
        stoppedOnBan: false,
      };
    },
    markOk: (input) => {
      marks.push({ kind: 'ok', address: input.address, days: input.windowDays });
    },
    markFail: (input) => {
      marks.push({ kind: 'fail', address: input.address, error: input.error });
    },
    log: () => {},
  });

  queue.enqueue({
    address: '0x57841A6640bf42d4F2aA7D87308db3c962C3945C',
    reason: 'test',
    days: 14,
  });
  // coalesce same address
  queue.enqueue({
    address: '0x57841a6640bf42d4f2aa7d87308db3c962c3945c',
    reason: 'test2',
  });
  assert.equal(queue.pendingCount(), 1);

  const drained = await queue.drain({ maxJobs: 2 });
  assert.equal(drained.processed, 1);
  assert.equal(drained.remaining, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].days, 14);
  assert.equal(
    calls[0].address.toLowerCase(),
    '0x57841a6640bf42d4f2aa7d87308db3c962c3945c'
  );
  assert.equal(marks.length, 1);
  assert.equal(marks[0].kind, 'ok');
  assert.equal(marks[0].days, 14);

  // ban path marks fail and re-queues
  const banQueue = createWalletActivityBackfillQueue({
    memoryOnly: true,
    debounceMs: 0,
    listUsers: () => [makeUser()],
    backfill: async () => ({
      address: '0x57841A6640bf42d4F2aA7D87308db3c962C3945C',
      rawCount: 0,
      tradeCount: 0,
      upserted: 0,
      chainsOk: ['base'],
      chainsFailed: [{ chain: 'eth', error: 'rate limited' }],
      stoppedOnBan: true,
    }),
    markOk: (input) => marks.push({ kind: 'ok', address: input.address }),
    markFail: (input) => marks.push({ kind: 'fail', address: input.address, error: input.error }),
    log: () => {},
  });
  marks.length = 0;
  banQueue.enqueue({ address: '0x57841A6640bf42d4F2aA7D87308db3c962C3945C', reason: 'ban-test' });
  const banDrain = await banQueue.drain({ maxJobs: 1 });
  assert.equal(banDrain.stoppedOnBan, true);
  assert.equal(banDrain.remaining, 1);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].kind, 'fail');

  console.log('PASS wallet-activity-backfill-queue');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
