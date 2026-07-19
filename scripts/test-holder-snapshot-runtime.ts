import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import { createHolderSnapshotCycleRunner } from '@/lib/server/holderSnapshotRuntime';

async function testCycleQueuesAndCompletesOneRun() {
  const completed: Array<{ runId: number; holders: unknown[]; meta?: Record<string, unknown> }> = [];
  const failed: Array<{ runId: number; error: string }> = [];
  let queueTradeCalls = 0;
  let queuePeriodicCalls = 0;
  let queuedCount = 1;

  const cycle = createHolderSnapshotCycleRunner({
    readHolderSnapshotPeriodicCursor: () => null,
    readHolderSnapshotTradeCursor: () => null,
    queueTradeTriggeredHolderSnapshots: () => {
      queueTradeCalls += 1;
      return {
        scannedCount: 2,
        queuedCount: 1,
        lastSeenId: 99,
      };
    },
    queuePeriodicHolderSnapshots: () => {
      queuePeriodicCalls += 1;
      return {
        queuedCount: 1,
        bucketStartMs: 21_600_000,
        tokenCount: 1,
      };
    },
    claimNextQueuedHolderSnapshotRun: () => ({
      id: 7,
      chain: 'solana',
      tokenAddress: 'TokenAAA11111111111111111111111111111111111',
      tokenAddressLower: 'TokenAAA11111111111111111111111111111111111',
      tokenSymbol: 'AAA',
      trackedWalletAddress: 'CJ5fHkNPf3yd7fKnjv5VtBJTNDAWFiRfLCutpuTAnpis',
      trackedWalletAddressLower: 'cj5fhknpf3yd7fknjv5vtbjtndawfirflcutputanpis',
      userId: 'user-1',
      triggerType: 'trade',
      triggerSource: 'telegram_monitor_tx_states',
      tradeAction: 'buy',
      txHash: 'tx-1',
      txHashLower: 'tx-1',
      tradeTimeMs: 1,
      holdingsRefreshedAt: null,
      periodBucketStartMs: null,
      dedupeKey: 'trade|solana|wallet|tx|token',
      status: 'running',
      attemptCount: 1,
      holderCount: null,
      error: null,
      meta: {},
      requestedAt: 1,
      startedAt: 1,
      completedAt: null,
      updatedAt: 1,
    }),
    collectTokenHolders: async () => ({
      holders: [
        {
          holderRank: 1,
          address: 'holder-1',
          amountPercentage: 12.5,
          raw: { rank: 1, address: 'holder-1' },
        },
      ],
      meta: { payloadShape: 'list' },
    }),
    completeHolderSnapshotRun: ({ runId, holders, meta }) => {
      completed.push({ runId, holders, meta });
      queuedCount = 0;
      return {
        id: runId,
        chain: 'solana',
        tokenAddress: 'TokenAAA11111111111111111111111111111111111',
        tokenAddressLower: 'TokenAAA11111111111111111111111111111111111',
        tokenSymbol: 'AAA',
        trackedWalletAddress: 'CJ5fHkNPf3yd7fKnjv5VtBJTNDAWFiRfLCutpuTAnpis',
        trackedWalletAddressLower: 'cj5fhknpf3yd7fknjv5vtbjtndawfirflcutputanpis',
        userId: 'user-1',
        triggerType: 'trade',
        triggerSource: 'telegram_monitor_tx_states',
        tradeAction: 'buy',
        txHash: 'tx-1',
        txHashLower: 'tx-1',
        tradeTimeMs: 1,
        holdingsRefreshedAt: null,
        periodBucketStartMs: null,
        dedupeKey: 'trade|solana|wallet|tx|token',
        status: 'completed',
        attemptCount: 1,
        holderCount: holders.length,
        error: null,
        meta: meta || {},
        requestedAt: 1,
        startedAt: 1,
        completedAt: 2,
        updatedAt: 2,
      };
    },
    failHolderSnapshotRun: ({ runId, error }) => {
      failed.push({ runId, error });
      return null;
    },
    countQueuedHolderSnapshotRuns: () => queuedCount,
  });

  const result = await cycle({
    now: () => 21_700_000,
  });

  assert.equal(queueTradeCalls, 1);
  assert.equal(queuePeriodicCalls, 1);
  assert.equal(completed.length, 1);
  assert.equal(failed.length, 0);
  assert.equal(result.status, 'idle');
  assert.equal(result.detail.lastQueuedTradeId, 99);
  assert.equal(result.detail.lastProcessedRunId, 7);
  assert.equal(result.detail.processedHolderCount, 1);
}

async function testCycleHandlesCollectorFailure() {
  const failed: Array<{ runId: number; error: string }> = [];

  const cycle = createHolderSnapshotCycleRunner({
    readHolderSnapshotPeriodicCursor: () => null,
    readHolderSnapshotTradeCursor: () => null,
    queueTradeTriggeredHolderSnapshots: () => ({
      scannedCount: 0,
      queuedCount: 0,
      lastSeenId: null,
    }),
    queuePeriodicHolderSnapshots: () => ({
      queuedCount: 0,
      bucketStartMs: 21_600_000,
      tokenCount: 0,
    }),
    claimNextQueuedHolderSnapshotRun: () => ({
      id: 8,
      chain: 'solana',
      tokenAddress: 'TokenBBB11111111111111111111111111111111111',
      tokenAddressLower: 'TokenBBB11111111111111111111111111111111111',
      tokenSymbol: 'BBB',
      trackedWalletAddress: 'CJ5fHkNPf3yd7fKnjv5VtBJTNDAWFiRfLCutpuTAnpis',
      trackedWalletAddressLower: 'cj5fhknpf3yd7fknjv5vtbjtndawfirflcutputanpis',
      userId: 'user-1',
      triggerType: 'manual',
      triggerSource: 'manual',
      tradeAction: null,
      txHash: null,
      txHashLower: null,
      tradeTimeMs: null,
      holdingsRefreshedAt: null,
      periodBucketStartMs: null,
      dedupeKey: 'manual',
      status: 'running',
      attemptCount: 1,
      holderCount: null,
      error: null,
      meta: {},
      requestedAt: 1,
      startedAt: 1,
      completedAt: null,
      updatedAt: 1,
    }),
    collectTokenHolders: async () => {
      throw new Error('gmgn exploded');
    },
    failHolderSnapshotRun: ({ runId, error }) => {
      failed.push({ runId, error });
      return null;
    },
    countQueuedHolderSnapshotRuns: () => 0,
  });

  const result = await cycle({
    now: () => 21_700_000,
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.detail.lastProcessedRunId, 8);
  assert.equal(result.detail.lastProcessedRunStatus, 'failed');
  assert.equal(failed.length, 1);
  assert.match(failed[0]?.error || '', /gmgn exploded/);
}

async function run() {
  await testCycleQueuesAndCompletesOneRun();
  await testCycleHandlesCollectorFailure();
  console.log('holder snapshot runtime tests: ok');
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
