import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

process.env.TELEGRAM_MONITOR_INGEST_TOKEN ??= 'fixture-telegram-ingest-token';
process.env.PILI_DISABLE_TELEGRAM_MONITOR_AUTO_RECONCILE = '1';

async function main() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-live-doorbell-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');
  process.env.PILI_LIVE_SOURCE = 'alchemy';
  process.env.PILI_XXYY_FEED = 'doorbell';
  process.env.PILI_ALCHEMY_INBOX_URL = 'https://example.invalid/inbox';
  process.env.PILI_ALCHEMY_PULL_TOKEN = 'token';

  try {
    const { readXxyyFeedMode, shouldAcceptXxyyChain } = await import(
      '@/lib/server/liveMonitorConfig'
    );
    assert.equal(readXxyyFeedMode({ PILI_LIVE_SOURCE: 'alchemy' }), 'doorbell');
    assert.equal(readXxyyFeedMode({ PILI_LIVE_SOURCE: 'xxyy' }), 'project');
    assert.equal(
      readXxyyFeedMode({ PILI_LIVE_SOURCE: 'alchemy', PILI_XXYY_FEED: 'project' }),
      'project'
    );
    assert.equal(
      shouldAcceptXxyyChain('solana', { PILI_LIVE_SOURCE: 'alchemy' }),
      true,
      'doorbell mode accepts all chains as rings'
    );
    assert.equal(
      shouldAcceptXxyyChain('solana', {
        PILI_LIVE_SOURCE: 'alchemy',
        PILI_XXYY_FEED: 'project',
        PILI_LIVE_XXYY_CHAINS: 'robinhood',
      }),
      false
    );
    console.log('PASS xxyy feed mode');

    const {
      enqueueLiveDoorbell,
      claimDueLiveDoorbells,
      countPendingLiveDoorbells,
      resetLiveDoorbellQueueForTests,
    } = await import('@/lib/server/liveDoorbellQueue');

    resetLiveDoorbellQueueForTests();
    const wallet = '0xA9a4ae9eE3888085574Aed126EA6D6D3887e9c9d';
    enqueueLiveDoorbell({
      address: wallet,
      userId: 'user-finn',
      chain: 'robinhood',
      source: 'xxyy',
      debounceMs: 5_000,
      nowMs: 1_000,
    });
    enqueueLiveDoorbell({
      address: wallet,
      userId: 'user-finn',
      chain: 'base',
      source: 'xxyy',
      debounceMs: 5_000,
      nowMs: 2_000,
    });
    assert.equal(countPendingLiveDoorbells(), 1, 'same wallet coalesces');

    const notDue = claimDueLiveDoorbells({ nowMs: 3_000 });
    assert.equal(notDue.length, 0, 'not due yet');

    const due = claimDueLiveDoorbells({ nowMs: 10_000 });
    assert.equal(due.length, 1);
    assert.equal(due[0]?.address.toLowerCase(), wallet.toLowerCase());
    assert.deepEqual(due[0]?.chains.sort(), ['base', 'robinhood']);
    assert.equal(countPendingLiveDoorbells(), 0, 'claim deletes');
    console.log('PASS doorbell queue coalesce/claim');

    const { runLiveMonitorCycle } = await import('@/lib/server/liveMonitorRuntime');
    const user = {
      id: 'user-finn',
      name: 'Finn',
      handle: 'finn',
      avatar: '',
      addresses: [
        {
          address: wallet,
          name: '#2',
          chain: 'base',
          totalAssetUsd: 1,
          assetUpdatedAt: 1,
        },
      ],
      totalAssetUsd: 1,
      historicalMaxAssetUsd: 1,
      assetUpdatedAt: 1,
      tags: [],
    };

    // Re-enqueue a due doorbell for cycle.
    enqueueLiveDoorbell({
      address: wallet,
      userId: user.id,
      chain: 'robinhood',
      debounceMs: 0,
      nowMs: Date.now(),
    });

    const scanned: Array<{ chain: string; wallet: string }> = [];
    const result = await runLiveMonitorCycle({
      listUsers: () => [user as never],
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
        events: 0,
        wallets: [],
        raw_events: [],
      }),
      claimDoorbells: (params) => claimDueLiveDoorbells(params),
      fetchActivity: async ({ chain, wallet: w }) => {
        scanned.push({ chain, wallet: String(w) });
        if (chain !== 'robinhood') {
          return { items: [], next: null, raw: null };
        }
        return {
          items: [
            {
              event_type: 'buy',
              timestamp: Math.floor(Date.now() / 1000),
              tx_hash: '0x5c842b16a2da9271ce36a5e596c5883be3352bd5327fe3eb00c2e8a92b2d7000',
              token: {
                address: '0x395c45c2e5170ab9d020010dc13214ab73051e18',
                symbol: 'JACKET',
              },
              token_amount: '38565',
              cost_usd: '15',
              price_usd: '0.000382',
            },
          ] as never,
          next: null,
          raw: null,
        };
      },
      upsertTrades: ({ trades }) => {
        assert.ok(trades.length >= 1, 'expected gmgn trades from xxyy doorbell');
        assert.equal(trades[0]?.tokenSymbol, 'JACKET');
        return { upserted: trades.length };
      },
      enqueueHoldingsRefresh: () => ({ enqueued: true, key: 'x' }),
    });

    assert.equal(result.summary.xxyyDoorbells, 1);
    assert.ok(result.summary.tradesUpserted >= 1);
    assert.ok(
      scanned.some((s) => s.chain === 'robinhood'),
      `expected robinhood scan, got ${JSON.stringify(scanned)}`
    );
    console.log('PASS live cycle drains xxyy doorbell via GMGN');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
