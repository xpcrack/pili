import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import { parseAlchemyInboxTrades } from '@/lib/server/alchemyDirectTrade';
import type { AlchemyInboxEvent } from '@/lib/server/alchemyInbox';

const WATCHED = '0x50f27cdb650879a41fb07038bf2b818845c20e17';
const OTHER = '0x1111111111111111111111111111111111111111';
const TOKEN = '0xabc0000000000000000000000000000000000001';
const USDC = '0x833589fCD6EDB6E08f4c7C32D4f71b54bdA02913';

function event(payload: Record<string, unknown>, network = 'BASE_MAINNET'): AlchemyInboxEvent {
  return {
    id: 1,
    event_key: 'fixture',
    network,
    received_at: '2026-08-25T06:00:00.000Z',
    payload: { event: { network, ...payload } },
  };
}

const fetchMarket = async (address: string, _chain: string) => ({
  ticker: address.toLowerCase() === TOKEN ? 'TEST' : 'USD Coin',
  name: address.toLowerCase() === TOKEN ? 'Test Token' : 'USD Coin',
  price: address.toLowerCase() === TOKEN ? 0.02 : 1,
  marketCap: address.toLowerCase() === TOKEN ? 2_000_000 : 50_000_000_000,
  liquidity: 500_000,
  priceChange24h: 0,
  volume24h: 0,
});

async function testEvmBuyFiltersQuoteLeg() {
  const trades = await parseAlchemyInboxTrades({
    events: [
      event({
        activity: [
          {
            fromAddress: OTHER,
            toAddress: WATCHED,
            value: '1500',
            hash: '0xbuy',
            rawContract: { address: TOKEN },
          },
          {
            fromAddress: WATCHED,
            toAddress: OTHER,
            value: '30',
            hash: '0xbuy',
            rawContract: { address: USDC },
          },
        ],
      }),
    ],
    watchedAddresses: [WATCHED],
    fetchMarket,
  });

  assert.equal(trades.length, 1);
  assert.equal(trades[0]?.side, 'buy');
  assert.equal(trades[0]?.chain, 'base');
  assert.equal(trades[0]?.wallet, WATCHED);
  assert.equal(trades[0]?.tokenAddress, TOKEN);
  assert.equal(trades[0]?.tokenSymbol, 'TEST');
  assert.equal(trades[0]?.tokenAmount, 1500);
  assert.equal(trades[0]?.costUsd, 30);
  assert.equal(trades[0]?.txHash, '0xbuy');
}

async function testEvmSell() {
  const trades = await parseAlchemyInboxTrades({
    events: [
      event({
        activity: [
          {
            fromAddress: WATCHED,
            toAddress: OTHER,
            value: '500',
            hash: '0xsell',
            rawContract: { address: TOKEN },
          },
        ],
      }),
    ],
    watchedAddresses: [WATCHED],
    fetchMarket,
  });

  assert.equal(trades.length, 1);
  assert.equal(trades[0]?.side, 'sell');
  assert.equal(trades[0]?.costUsd, 10);
}

async function testAlchemyBnbNetworkMapsToBsc() {
  const trades = await parseAlchemyInboxTrades({
    events: [
      event({
        activity: [{
          fromAddress: OTHER,
          toAddress: WATCHED,
          value: 1000,
          hash: '0xbnb',
          asset: 'TEST',
          rawContract: { address: TOKEN, rawValue: '0x1', decimals: 18 },
        }],
      }, 'BNB_MAINNET'),
    ],
    watchedAddresses: [WATCHED],
    fetchMarket,
  });
  assert.equal(trades.length, 1);
  assert.equal(trades[0]?.chain, 'bsc');
}

async function testD1TimestampIsParsedAsUtc() {
  const d1Event = event({
    activity: [{
      fromAddress: OTHER,
      toAddress: WATCHED,
      value: 1000,
      hash: '0xutc',
      rawContract: { address: TOKEN },
    }],
  });
  d1Event.received_at = '2026-08-25 06:00:00';
  const trades = await parseAlchemyInboxTrades({
    events: [d1Event],
    watchedAddresses: [WATCHED],
    fetchMarket,
  });
  assert.equal(trades[0]?.eventTimeMs, Date.parse('2026-08-25T06:00:00.000Z'));
}

async function testSolanaTransfer() {
  const solWallet = 'CJ5fHkNPf3yd7fKnjv5VtBJTNDAWFiRfLCutpuTAnpis';
  const mint = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs';
  const trades = await parseAlchemyInboxTrades({
    events: [
      event(
        {
          transactionData: { signature: '5sig', slot: 1 },
          tokenTransfers: [
            { fromOwner: 'OtherSolWallet', toOwner: solWallet, mint, tokenAmount: 42 },
          ],
        },
        'SOL_MAINNET'
      ),
    ],
    watchedAddresses: [solWallet],
    fetchMarket: async () => ({
      ticker: 'SOLTEST',
      name: 'Sol Test',
      price: 1,
      marketCap: 1_000_000,
      liquidity: 10_000,
      priceChange24h: 0,
      volume24h: 0,
    }),
  });

  assert.equal(trades.length, 1);
  assert.equal(trades[0]?.chain, 'solana');
  assert.equal(trades[0]?.wallet, solWallet);
  assert.equal(trades[0]?.txHash, '5sig');
  assert.equal(trades[0]?.tokenAddress, mint);
}

async function testDustAndThinLiquidityAreRejected() {
  const payload = event({
    activity: [
      {
        fromAddress: OTHER,
        toAddress: WATCHED,
        value: '1',
        hash: '0xdust',
        rawContract: { address: TOKEN },
      },
    ],
  });
  const dust = await parseAlchemyInboxTrades({
    events: [payload],
    watchedAddresses: [WATCHED],
    fetchMarket,
    minCostUsd: 10,
  });
  assert.equal(dust.length, 0);

  const thin = await parseAlchemyInboxTrades({
    events: [payload],
    watchedAddresses: [WATCHED],
    fetchMarket: async () => ({
      ...(await fetchMarket(TOKEN, 'base')),
      liquidity: 100,
      price: 20,
    }),
  });
  assert.equal(thin.length, 0);
}

async function testMissingMarketDataDoesNotDropTrade() {
  const trades = await parseAlchemyInboxTrades({
    events: [event({
      activity: [{
        fromAddress: OTHER,
        toAddress: WATCHED,
        value: 12,
        asset: 'RAW',
        hash: '0xraw',
        rawContract: { address: TOKEN },
      }],
    })],
    watchedAddresses: [WATCHED],
    fetchMarket: async () => null,
    minCostUsd: 10,
  });
  assert.equal(trades.length, 1, 'market API failure must not drop an on-chain trade');
  assert.equal(trades[0]?.tokenSymbol, 'RAW');
  assert.equal(trades[0]?.costUsd, null);
  assert.equal(trades[0]?.priceUsd, null);
}

async function run() {
  await testEvmBuyFiltersQuoteLeg();
  await testEvmSell();
  await testAlchemyBnbNetworkMapsToBsc();
  await testD1TimestampIsParsedAsUtc();
  await testSolanaTransfer();
  await testDustAndThinLiquidityAreRejected();
  await testMissingMarketDataDoesNotDropTrade();
  console.log('alchemy direct trade tests: ok');
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
