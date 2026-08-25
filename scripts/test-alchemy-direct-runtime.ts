import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import { runLiveMonitorCycle } from '@/lib/server/liveMonitorRuntime';
import type { User } from '@/types';

const wallet = '0x50f27cdb650879a41fb07038bf2b818845c20e17';
const user: User = {
  id: 'alchemy-user',
  name: 'Alchemy User',
  handle: 'alchemy-user',
  avatar: '',
  addresses: [{ address: wallet, name: '#1', chain: 'base', totalAssetUsd: 1, assetUpdatedAt: 1 }],
  totalAssetUsd: 1,
  historicalMaxAssetUsd: 1,
  mainstreamAssetUsd: 0,
  assetUpdatedAt: 1,
  tags: [],
};

async function run() {
  let gmgnCalls = 0;
  let upserted = 0;
  const result = await runLiveMonitorCycle({
    listUsers: () => [user],
    env: {
      PILI_LIVE_SOURCE: 'alchemy',
      PILI_LIVE_TRADE_SOURCE: 'alchemy',
      PILI_ALCHEMY_INBOX_URL: 'https://example.invalid/inbox',
      PILI_ALCHEMY_PULL_TOKEN: 'token',
      PILI_LIVE_CYCLE_MS: '1',
    },
    pullInbox: async () => ({
      since_id: 0,
      next_id: 1,
      events: 1,
      wallets: [wallet],
      raw_events: [{
        id: 1,
        event_key: 'fixture',
        network: 'BASE_MAINNET',
        received_at: '2026-08-25T06:00:00.000Z',
        payload: { event: { network: 'BASE_MAINNET', activity: [] } },
      }],
    }),
    claimDoorbells: () => [],
    parseDirectTrades: async () => [{
      chain: 'base',
      wallet,
      txHash: '0xalchemy',
      tokenAddress: '0xtoken',
      tokenSymbol: 'TOKEN',
      side: 'buy',
      tokenAmount: 10,
      costUsd: 20,
      priceUsd: 2,
      marketCapUsd: 2_000_000,
      isOpenOrClose: null,
      eventTimeMs: Date.now(),
    }],
    fetchActivity: async () => {
      gmgnCalls += 1;
      throw new Error('GMGN must not be called in pure Alchemy mode');
    },
    upsertTrades: ({ trades }) => {
      upserted += trades.length;
      return { upserted: trades.length };
    },
    enqueueHoldingsRefresh: () => ({ enqueued: true, key: 'base:wallet' }),
    gmgnCooldownRemainingMs: () => 999_999,
  });

  assert.equal(gmgnCalls, 0);
  assert.equal(upserted, 1);
  assert.equal(result.summary.tradesUpserted, 1);
  assert.equal(result.summary.gmgnErrors, 0);

  let pullAttempts = 0;
  let observedPullLimit = 0;
  const retried = await runLiveMonitorCycle({
    listUsers: () => [user],
    env: {
      PILI_LIVE_SOURCE: 'alchemy',
      PILI_LIVE_TRADE_SOURCE: 'alchemy',
      PILI_ALCHEMY_INBOX_URL: 'https://example.invalid/inbox',
      PILI_ALCHEMY_PULL_TOKEN: 'token',
      PILI_LIVE_CYCLE_MS: '1',
    },
    pullInbox: async (options) => {
      observedPullLimit = options.limit ?? 0;
      pullAttempts += 1;
      if (pullAttempts < 3) throw new TypeError('fetch failed');
      return { since_id: 1, next_id: 1, events: 0, wallets: [], raw_events: [] };
    },
    claimDoorbells: () => [],
    parseDirectTrades: async () => [],
    enqueueHoldingsRefresh: () => ({ enqueued: true, key: 'base:wallet' }),
    gmgnCooldownRemainingMs: () => 0,
  });
  assert.equal(pullAttempts, 3, 'transient inbox fetch failures should be retried');
  assert.equal(observedPullLimit, 10, 'pure Alchemy mode should process small realtime batches');
  assert.equal(retried.lastError, null);
  console.log('alchemy direct runtime tests: ok');
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
