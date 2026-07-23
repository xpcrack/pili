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

  console.log('PASS wallet-activity-backfill-queue');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
