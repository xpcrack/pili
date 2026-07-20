import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import { runLiveMonitorCycle } from '@/lib/server/liveMonitorRuntime';
import type { User } from '@/types';

async function run() {
  const wallet = '0xabc0000000000000000000000000000000000001';
  const user: User = {
    id: 'user-1',
    name: 'Trader',
    handle: 'trader',
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

  const enqueued: Array<{ address: string; chain: string; userId: string }> = [];

  const result = await runLiveMonitorCycle({
    listUsers: () => [user],
    env: {
      PILI_LIVE_SOURCE: 'alchemy',
      PILI_ALCHEMY_INBOX_URL: 'https://example.invalid/inbox',
      PILI_ALCHEMY_PULL_TOKEN: 'token',
      PILI_LIVE_CYCLE_MS: '1000',
      PILI_LIVE_LOOKBACK_SEC: '7200',
    },
    pullInbox: async () => ({
      since_id: 0,
      next_id: 1,
      events: 1,
      wallets: [wallet],
      raw_events: [],
    }),
    syncWatchlist: async () => ({ ok: true } as never),
    fetchActivity: async ({ chain }) => {
      // Only return a trade on base so we get one unique (wallet, chain) enqueue.
      if (chain !== 'base') {
        return { items: [], next: null, raw: null };
      }
      return {
        items: [
          {
            event_type: 'buy',
            timestamp: Math.floor(Date.now() / 1000),
            tx_hash: '0xtx-live-1',
            token: { address: '0xtoken', symbol: 'TOK' },
            token_amount: '10',
            cost_usd: '50',
            price_usd: '5',
          },
        ] as never,
        next: null,
        raw: null,
      };
    },
    upsertTrades: () => ({ upserted: 1 }),
    enqueueHoldingsRefresh: (input) => {
      enqueued.push(input);
      return { enqueued: true, key: `${input.chain}:${input.address}` };
    },
  });

  assert.ok(result.summary.tradesUpserted >= 1, `expected trades upserted, got ${result.summary.tradesUpserted}`);
  assert.equal(enqueued.length, 1, `expected 1 enqueue, got ${enqueued.length}: ${JSON.stringify(enqueued)}`);
  assert.equal(enqueued[0]?.userId, 'user-1');
  assert.equal(enqueued[0]?.address.toLowerCase(), wallet.toLowerCase());
  assert.equal(enqueued[0]?.chain, 'base');

  // No trades → no enqueue
  enqueued.length = 0;
  await runLiveMonitorCycle({
    listUsers: () => [user],
    env: {
      PILI_LIVE_SOURCE: 'alchemy',
      PILI_ALCHEMY_INBOX_URL: 'https://example.invalid/inbox',
      PILI_ALCHEMY_PULL_TOKEN: 'token',
      PILI_LIVE_CYCLE_MS: '1000',
    },
    pullInbox: async () => ({
      since_id: 0,
      next_id: 2,
      events: 1,
      wallets: [wallet],
      raw_events: [],
    }),
    syncWatchlist: async () => ({ ok: true } as never),
    fetchActivity: async () => ({ items: [], next: null, raw: null }),
    upsertTrades: () => ({ upserted: 0 }),
    enqueueHoldingsRefresh: (input) => {
      enqueued.push(input);
      return { enqueued: true, key: `${input.chain}:${input.address}` };
    },
  });
  assert.equal(enqueued.length, 0, 'no trades should not enqueue holdings refresh');

  console.log('live-monitor holdings enqueue tests: ok');
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
