import assert from 'node:assert/strict';

import { resolveTradeAmountUsdAtTx } from '@/lib/tradeUsd';

async function run() {
  assert.equal(
    await resolveTradeAmountUsdAtTx({
      chain: 'bsc',
      quoteTokenSymbol: 'USDT',
      quoteAmount: 1250,
      tokenSymbol: 'TEST',
      tokenAmount: 1,
      txTimestampMs: 1_710_000_000_000,
    }),
    1250
  );

  assert.equal(
    await resolveTradeAmountUsdAtTx(
      {
        chain: 'bsc',
        quoteTokenSymbol: 'BNB',
        quoteAmount: 2,
        tokenSymbol: 'TEST',
        tokenAmount: 1,
        txTimestampMs: 1_710_000_000_000,
      },
      {
        fetchHistoricalPriceBeforeTimestamp: async () => ({
          priceUsd: 600,
          candleTimestampMs: 1_710_000_000_000,
          bar: '1m',
        }),
      }
    ),
    1200
  );

  assert.equal(
    await resolveTradeAmountUsdAtTx({
      chain: 'bsc',
      tokenSymbol: 'TEST',
      tokenAmount: 300,
      explicitPriceUsd: 2.5,
      txTimestampMs: 1_710_000_000_000,
    }),
    750
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: '1', data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  try {
    assert.equal(
      await resolveTradeAmountUsdAtTx({
        chain: 'solana',
        quoteTokenSymbol: 'SOL',
        quoteAmount: 1,
        tokenSymbol: 'TEST',
        tokenAmount: 1,
        txTimestampMs: 1_710_000_000_000,
      }),
      null
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('trade usd tests: ok');
}

void run();
