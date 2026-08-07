import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import { createHoldingsRefreshQueue } from '@/lib/server/holdingsRefreshQueue';
import { enqueueLiveDoorbell, resetLiveDoorbellQueueForTests } from '@/lib/server/liveDoorbellQueue';

function flushTimers(timers: Array<{ cb: () => void; ms: number }>) {
  const snapshot = [...timers];
  timers.length = 0;
  for (const t of snapshot) {
    t.cb();
  }
}

async function flushMicrotasks(times = 20) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function run() {
  resetLiveDoorbellQueueForTests();
  const calls: Array<{ address: string; chain: string; userId: string }> = [];
  const timers: Array<{ cb: () => void; ms: number }> = [];

  const queue = createHoldingsRefreshQueue({
    debounceMs: 50,
    maxConcurrent: 1,
    setTimer: ((cb: () => void, ms: number) => {
      const handle = { cb, ms };
      timers.push(handle);
      return handle as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimer: ((handle: unknown) => {
      const idx = timers.indexOf(handle as { cb: () => void; ms: number });
      if (idx >= 0) timers.splice(idx, 1);
    }) as typeof clearTimeout,
    refreshWallet: async (params) => {
      await Promise.resolve();
      calls.push({
        address: params.address,
        chain: params.chain,
        userId: params.userId,
      });
      return {
        status: 'idle',
        chain: 'solana',
        holdingsRowCount: 1,
        filteredOutHoldingCount: 0,
        totalAssetUsd: 10,
        lastError: null,
      };
    },
    log: () => {},
  });

  // Coalesce two quick enqueues for same wallet into one run after debounce.
  queue.enqueue({ address: 'WalletA', chain: 'solana', userId: 'u1' });
  queue.enqueue({ address: 'WalletA', chain: 'solana', userId: 'u1' });
  assert.equal(queue.pendingCount(), 1);
  assert.equal(timers.length, 1, 'second enqueue should reset, not stack timers');

  flushTimers(timers);
  await flushMicrotasks();
  assert.equal(calls.length, 1, `expected 1 call after first debounce, got ${calls.length}`);
  assert.equal(calls[0]?.address, 'WalletA');
  assert.equal(calls[0]?.chain, 'solana');

  // Different chain is a separate key
  queue.enqueue({ address: 'WalletA', chain: 'base', userId: 'u1' });
  assert.equal(queue.pendingCount(), 1);
  flushTimers(timers);
  await flushMicrotasks();
  assert.equal(calls.length, 2, `expected 2 calls after second chain, got ${calls.length}`);
  assert.equal(calls[1]?.chain, 'base');

  // Invalid input ignored
  const bad = queue.enqueue({ address: '', chain: 'solana', userId: 'u1' });
  assert.equal(bad.enqueued, false);

  // A pending live Feed doorbell takes priority over trade-triggered holdings work.
  enqueueLiveDoorbell({
    address: '0xfeed-priority',
    userId: 'u1',
    chain: 'base',
    debounceMs: 0,
    nowMs: Date.now(),
  });
  queue.enqueue({ address: 'WalletB', chain: 'base', userId: 'u1' });
  flushTimers(timers);
  await flushMicrotasks();
  assert.equal(calls.length, 2, 'holdings must yield while a live Feed doorbell is pending');
  assert.equal(queue.pendingCount(), 1);

  queue.resetForTests();
  resetLiveDoorbellQueueForTests();
  console.log('holdings refresh queue tests: ok');
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
