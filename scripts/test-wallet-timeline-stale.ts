import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import { isWalletTimelineStale } from '@/lib/server/walletTimelineState';

function main() {
  const now = 1_000_000_000_000;
  const windowDays = 14;
  const staleAfterMs = 6 * 60 * 60 * 1000;

  assert.equal(
    isWalletTimelineStale({
      state: null,
      nowMs: now,
      windowDays,
      staleAfterMs,
    }),
    true,
    'missing state is stale'
  );

  assert.equal(
    isWalletTimelineStale({
      state: {
        addressLower: '0xabc',
        lastBackfillAt: now,
        lastOkAt: null,
        windowStartMs: null,
        lastError: 'x',
        coverageVersion: 0,
        chains: [],
        updatedAt: now,
      },
      nowMs: now,
      windowDays,
      staleAfterMs,
    }),
    true,
    'never-ok is stale'
  );

  const freshOk = now - 60_000;
  assert.equal(
    isWalletTimelineStale({
      state: {
        addressLower: '0xabc',
        lastBackfillAt: freshOk,
        lastOkAt: freshOk,
        windowStartMs: freshOk - windowDays * 86400_000,
        lastError: null,
        coverageVersion: 2,
        chains: ['eth', 'bsc', 'base', 'robinhood'],
        updatedAt: freshOk,
      },
      nowMs: now,
      windowDays,
      staleAfterMs,
    }),
    false,
    'fresh ok within staleAfter is not stale'
  );

  const oldOk = now - staleAfterMs - 1;
  assert.equal(
    isWalletTimelineStale({
      state: {
        addressLower: '0xabc',
        lastBackfillAt: oldOk,
        lastOkAt: oldOk,
        windowStartMs: oldOk - windowDays * 86400_000,
        lastError: null,
        coverageVersion: 2,
        chains: ['eth', 'bsc', 'base', 'robinhood'],
        updatedAt: oldOk,
      },
      nowMs: now,
      windowDays,
      staleAfterMs,
    }),
    true,
    'ok older than staleAfter is stale'
  );

  // window slipped: last ok recent but declared window start too new (covers <14d)
  const recent = now - 60_000;
  assert.equal(
    isWalletTimelineStale({
      state: {
        addressLower: '0xabc',
        lastBackfillAt: recent,
        lastOkAt: recent,
        windowStartMs: now - 3 * 86400_000, // only claims 3d
        lastError: null,
        coverageVersion: 2,
        chains: ['eth', 'bsc', 'base', 'robinhood'],
        updatedAt: recent,
      },
      nowMs: now,
      windowDays,
      staleAfterMs,
    }),
    true,
    'window shorter than 14d is stale'
  );

  console.log('PASS wallet-timeline-stale');
}

main();
