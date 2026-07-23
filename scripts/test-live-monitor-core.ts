import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import { matchedWatchedWallets, extractAddressesFromAlchemyPayload } from '@/lib/server/alchemyInbox';
import { splitTrackedAddresses } from '@/lib/server/alchemyWatchlist';
import {
  extractActivityItems,
  extractMarketCapUsd,
  inferChainsForAddress,
  normalizeGmgnActivityItems,
  normalizeGmgnChainToPili,
} from '@/lib/server/gmgnWalletActivity';
import {
  shouldAcceptXxyyChain,
  readLiveSourceMode,
  readXxyyAllowedChains,
} from '@/lib/server/liveMonitorConfig';
import {
  buildLiveMonitorActivityId,
  buildLiveMonitorActivity,
  isLiveMonitorActivityId,
} from '@/lib/server/liveMonitorIngest';
import type { User } from '@/types';

function testSplitAddresses() {
  const { evm, sol } = splitTrackedAddresses([
    '0xABC0000000000000000000000000000000000001',
    '0xabc0000000000000000000000000000000000001',
    'So11111111111111111111111111111111111111112',
    '',
  ]);
  assert.equal(evm.length, 1);
  assert.equal(evm[0], '0xabc0000000000000000000000000000000000001');
  assert.equal(sol.length, 1);
  console.log('PASS splitTrackedAddresses');
}

function testPayloadMatch() {
  const payload = {
    event: {
      activity: [
        { fromAddress: '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa', toAddress: '0xbbbb' },
      ],
    },
  };
  const addrs = extractAddressesFromAlchemyPayload(payload);
  assert.ok(addrs.some((a) => a.toLowerCase().startsWith('0xaaaa')));
  const matched = matchedWatchedWallets(payload, [
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'So11111111111111111111111111111111111111112',
  ]);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].toLowerCase(), '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  console.log('PASS alchemy payload match');
}

function testGmgnNormalize() {
  assert.deepEqual(inferChainsForAddress('0xabc'), ['robinhood', 'base', 'eth', 'bsc']);
  assert.deepEqual(inferChainsForAddress('So111'), ['sol']);
  assert.equal(normalizeGmgnChainToPili('sol'), 'solana');
  assert.equal(normalizeGmgnChainToPili('eth'), 'ethereum');

  const items = extractActivityItems({
    data: {
      activities: [
        {
          event_type: 'buy',
          timestamp: 1_700_000_100,
          tx_hash: '0xtx1',
          token: { address: '0xToken', symbol: 'TOK' },
          token_amount: '12.5',
          cost_usd: '40',
          price_usd: '0.01',
        },
        {
          event_type: 'transfer',
          timestamp: 1_700_000_200,
          token: { address: '0xToken' },
        },
        {
          event_type: 'sell',
          timestamp: 1_700_000_050,
          tx_hash: '0xtx0',
          token: { address: '0xToken', symbol: 'TOK' },
          cost_usd: '5',
        },
      ],
    },
  });
  assert.equal(items.length, 3);

  const trades = normalizeGmgnActivityItems(items, {
    wallet: '0xwallet',
    chain: 'base',
    min_cost_usd: 10,
    after_ts: 1_700_000_000,
  });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].side, 'buy');
  assert.equal(trades[0].chain, 'base');
  assert.equal(trades[0].tokenAddress, '0xtoken');

  // explicit market_cap
  assert.equal(
    extractMarketCapUsd({
      market_cap: 1_500_000,
      price_usd: 0.01,
      token: { total_supply: 1_000_000_000 },
    }),
    1_500_000
  );
  // price × supply fallback when market_cap missing
  assert.equal(
    extractMarketCapUsd({
      price_usd: 0.01,
      token: { address: '0xt', total_supply: 1_000_000_000 },
    }),
    10_000_000
  );
  // >100B discarded
  assert.equal(
    extractMarketCapUsd({
      price_usd: 200,
      token: { total_supply: 1_000_000_000 },
    }),
    null
  );

  const withMcap = normalizeGmgnActivityItems(
    [
      {
        event_type: 'buy',
        timestamp: 1_700_000_100,
        tx_hash: '0xtx2',
        token: { address: '0xToken2', symbol: 'T2', total_supply: 1_000_000_000 },
        cost_usd: '50',
        price_usd: '0.0005',
      },
    ],
    { wallet: '0xwallet', chain: 'base', after_ts: 1_700_000_000 }
  );
  assert.equal(withMcap.length, 1);
  assert.equal(withMcap[0].marketCapUsd, 500_000);
  console.log('PASS gmgn normalize');
}

function testXxyyFilter() {
  assert.equal(readLiveSourceMode({}), 'xxyy');
  assert.equal(
    readLiveSourceMode({
      PILI_ALCHEMY_INBOX_URL: 'https://example.workers.dev',
      PILI_ALCHEMY_PULL_TOKEN: 't',
    }),
    'dual'
  );
  assert.equal(readLiveSourceMode({ PILI_LIVE_SOURCE: 'alchemy' }), 'alchemy');

  assert.equal(shouldAcceptXxyyChain('solana', { PILI_LIVE_SOURCE: 'xxyy' }), true);
  assert.equal(
    shouldAcceptXxyyChain('solana', {
      PILI_LIVE_SOURCE: 'alchemy',
      PILI_LIVE_XXYY_CHAINS: 'robinhood',
    }),
    false
  );
  assert.equal(
    shouldAcceptXxyyChain('robinhood', {
      PILI_LIVE_SOURCE: 'alchemy',
      PILI_LIVE_XXYY_CHAINS: 'robinhood',
    }),
    true
  );
  assert.equal(
    shouldAcceptXxyyChain('bsc', {
      PILI_LIVE_SOURCE: 'dual',
      PILI_LIVE_XXYY_CHAINS: 'robinhood',
    }),
    false
  );
  const dualAll = readXxyyAllowedChains({ PILI_LIVE_SOURCE: 'dual' });
  assert.equal(dualAll, null);
  console.log('PASS xxyy chain filter');
}

function testLiveActivityShape() {
  const user = {
    id: 'u1',
    name: 'Alice',
    handle: null,
    avatar: null,
    twitter: null,
    twitterUserId: null,
    twitterAvatarUrl: null,
    telegram: null,
    telegrams: [],
    tags: [],
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    addresses: [],
  } as unknown as User;

  const activity = buildLiveMonitorActivity({
    user,
    trade: {
      chain: 'base',
      wallet: '0xWallet',
      txHash: '0xTxHash',
      tokenAddress: '0xtoken',
      tokenSymbol: 'TOK',
      side: 'buy',
      tokenAmount: 10,
      costUsd: 25,
      priceUsd: 2.5,
      marketCapUsd: 1_200_000,
      eventTimeMs: 1_700_000_000_000,
    },
  });

  assert.ok(isLiveMonitorActivityId(activity.id));
  assert.ok(activity.id.startsWith('live-monitor:base:'));
  assert.equal(activity.title, '链上监控交易');
  assert.equal(activity.metadata.liveSource, 'alchemy-gmgn');
  assert.equal(activity.metadata.txAction, 'buy');
  assert.equal(activity.metadata.txActionVariant, 'add');
  assert.equal(activity.metadata.chain, 'base');
  assert.equal(activity.metadata.marketCapAtTxUsd, 1_200_000);
  assert.equal(activity.metadata.marketCapAtTxSource, 'gmgn-activity');

  const id = buildLiveMonitorActivityId({
    chain: 'robinhood',
    trackedAddress: '0xabc',
    txHash: '0xdef',
    tokenAddress: '0xt',
    eventTimeMs: 1,
  });
  assert.equal(id, 'live-monitor:robinhood:0xabc:0xdef:0xt');

  const idA = buildLiveMonitorActivityId({
    chain: 'base',
    trackedAddress: '0xwallet',
    txHash: '0xsame',
    tokenAddress: '0xtokenA',
    eventTimeMs: 1,
  });
  const idB = buildLiveMonitorActivityId({
    chain: 'base',
    trackedAddress: '0xwallet',
    txHash: '0xsame',
    tokenAddress: '0xtokenB',
    eventTimeMs: 1,
  });
  assert.notEqual(idA, idB, 'same tx different tokens must not share event id');
  assert.equal(activity.id, 'live-monitor:base:0xwallet:0xtxhash:0xtoken');
  console.log('PASS live activity shape');
}

async function main() {
  testSplitAddresses();
  testPayloadMatch();
  testGmgnNormalize();
  testXxyyFilter();
  testLiveActivityShape();
  console.log('OK live-monitor-core');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
