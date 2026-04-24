import assert from 'node:assert/strict';

import { resolveTradeAmountUsdAtTx } from '@/lib/tradeUsd';

async function run() {
  assert.equal(
    await resolveTradeAmountUsdAtTx({
      chain: 'bsc',
      quoteToken: 'USDT',
      quoteAmount: '1,250',
      token: 'TEST',
      value: '1',
      txTimestampMs: 1_710_000_000_000,
    }),
    1250
  );

  assert.equal(
    await resolveTradeAmountUsdAtTx(
      {
        chain: 'bsc',
        quoteToken: 'BNB',
        quoteAmount: ' 2 ',
        token: 'TEST',
        value: 1,
        txTimestampMs: 1_710_000_000_000,
      },
      {
        fetchHistoricalTokenPrice: async () => ({
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
      token: 'TEST',
      value: '300',
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
        quoteToken: 'SOL',
        quoteAmount: 1,
        token: 'TEST',
        value: '1',
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
