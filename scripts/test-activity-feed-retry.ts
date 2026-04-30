import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import { buildActivityFeed, type BuildActivityFeedFetchFailure } from '@/lib/activityFeed';
import type { User } from '@/types';

function createUser(): User {
  return {
    id: 'u1',
    name: 'Retry User',
    handle: 'retry_user',
    avatar: '',
    twitter: '',
    telegram: '',
    addresses: [
      {
        address: '0x1111111111111111111111111111111111111111',
        name: '#1',
        chain: 'bsc',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
    ],
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
  };
}

async function run() {
  const now = Date.UTC(2026, 3, 29, 12, 0, 0);
  const beginMs = now - 14 * 24 * 60 * 60 * 1000;
  const endMs = now;

  let attempts = 0;
  const recovered = await buildActivityFeed([createUser()], {
    beginMs,
    endMs,
    fetchTransactionsByAddress: async () => {
      attempts += 1;
      if (attempts < 3) {
        return {
          ok: false,
          configured: true,
          transactions: [],
          error: 'OKX API 504: gateway timeout',
        };
      }
      return {
        ok: true,
        configured: true,
        transactions: [],
        error: null,
      };
    },
    retryPolicy: {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
      sleep: async () => {},
    },
    assetSnapshotCollector: async () => ({
      addressAssets: [],
      userAssets: [],
    }),
  });

  assert.equal(attempts, 3);
  assert.equal(recovered.summary.failedAddressCount, 0);
  assert.equal(recovered.diagnostics[0]?.ok, true);
  assert.equal(recovered.diagnostics[0]?.error, null);
  assert.equal(recovered.diagnostics[0]?.fetchAttempts, 3);
  assert.equal(recovered.diagnostics[0]?.retryExhausted, false);

  let failedAttempts = 0;
  const exhausted: BuildActivityFeedFetchFailure[] = [];
  const exhaustedResult = await buildActivityFeed([createUser()], {
    beginMs,
    endMs,
    fetchTransactionsByAddress: async () => {
      failedAttempts += 1;
      return {
        ok: false,
        configured: true,
        transactions: [],
        error: 'OKX API 429: too many requests',
      };
    },
    retryPolicy: {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
      sleep: async () => {},
    },
    onAddressFetchRetryExhausted: async (failure) => {
      exhausted.push(failure);
    },
    assetSnapshotCollector: async () => ({
      addressAssets: [],
      userAssets: [],
    }),
  });

  assert.equal(failedAttempts, 3);
  assert.equal(exhaustedResult.summary.failedAddressCount, 1);
  assert.equal(exhaustedResult.diagnostics[0]?.ok, false);
  assert.equal(exhaustedResult.diagnostics[0]?.fetchAttempts, 3);
  assert.equal(exhaustedResult.diagnostics[0]?.retryExhausted, true);
  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0]?.attemptCount, 3);
  assert.match(exhausted[0]?.error || '', /429/);

  let nonRetryableAttempts = 0;
  const nonRetryableExhausted: BuildActivityFeedFetchFailure[] = [];
  const nonRetryableResult = await buildActivityFeed([createUser()], {
    beginMs,
    endMs,
    fetchTransactionsByAddress: async () => {
      nonRetryableAttempts += 1;
      return {
        ok: false,
        configured: true,
        transactions: [],
        error: '暂不支持 avalanche，当前仅支持 BSC / Ethereum / Base / Solana',
      };
    },
    retryPolicy: {
      maxAttempts: 5,
      baseDelayMs: 1,
      maxDelayMs: 1,
      sleep: async () => {},
    },
    onAddressFetchRetryExhausted: async (failure) => {
      nonRetryableExhausted.push(failure);
    },
    assetSnapshotCollector: async () => ({
      addressAssets: [],
      userAssets: [],
    }),
  });

  assert.equal(nonRetryableAttempts, 1);
  assert.equal(nonRetryableResult.diagnostics[0]?.retryExhausted, false);
  assert.equal(nonRetryableExhausted.length, 0);

  let thrownAttempts = 0;
  const thrownRecovered = await buildActivityFeed([createUser()], {
    beginMs,
    endMs,
    fetchTransactionsByAddress: async () => {
      thrownAttempts += 1;
      if (thrownAttempts < 3) {
        throw new Error('timeout while contacting OKX');
      }
      return {
        ok: true,
        configured: true,
        transactions: [],
        error: null,
      };
    },
    retryPolicy: {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
      sleep: async () => {},
    },
    assetSnapshotCollector: async () => ({
      addressAssets: [],
      userAssets: [],
    }),
  });

  assert.equal(thrownAttempts, 3);
  assert.equal(thrownRecovered.summary.failedAddressCount, 0);
  assert.equal(thrownRecovered.diagnostics[0]?.ok, true);
  assert.equal(thrownRecovered.diagnostics[0]?.fetchAttempts, 3);
  assert.equal(thrownRecovered.diagnostics[0]?.retryExhausted, false);
  console.log('activity feed retry tests: ok');
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
