import assert from 'node:assert/strict';

import { fetchOkxTokenHistoricalPriceBeforeTimestamp } from '@/lib/okx';
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
    await resolveTradeAmountUsdAtTx(
      {
        chain: 'ethereum',
        quoteToken: 'ETH',
        quoteAmount: '1.5',
        token: 'TEST',
        value: 1,
        txTimestampMs: 1_710_000_000_000,
      },
      {
        fetchHistoricalTokenPrice: async () => ({
          priceUsd: 3200,
          candleTimestampMs: 1_710_000_000_000,
          bar: '1m',
        }),
      }
    ),
    4800
  );

  assert.equal(
    await resolveTradeAmountUsdAtTx(
      {
        chain: 'base',
        quoteToken: 'WETH',
        quoteAmount: '0.25',
        token: 'TEST',
        value: 1,
        txTimestampMs: 1_710_000_000_000,
      },
      {
        fetchHistoricalTokenPrice: async () => ({
          priceUsd: 3200,
          candleTimestampMs: 1_710_000_000_000,
          bar: '1m',
        }),
      }
    ),
    800
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

  process.env.OKX_API_KEY = 'test-key';
  process.env.OKX_SECRET_KEY = 'test-secret';
  process.env.OKX_API_PASSPHRASE = 'test-passphrase';

  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    const authKey = headers.get('OK-ACCESS-KEY');
    const authSign = headers.get('OK-ACCESS-SIGN');
    const authPassphrase = headers.get('OK-ACCESS-PASSPHRASE');
    const authTimestamp = headers.get('OK-ACCESS-TIMESTAMP');

    if (!authKey || !authSign || !authPassphrase || !authTimestamp) {
      return new Response(JSON.stringify({ code: '50103', msg: 'Request header OK-ACCESS-KEY can not be empty.' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({
        code: '0',
        data: [['1710000000000', '1', '1', '1', '650', '0', '0', '0']],
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );
  };

  try {
    assert.deepEqual(
      await fetchOkxTokenHistoricalPriceBeforeTimestamp(
        'bsc',
        '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
        1_710_000_000_000
      ),
      {
        priceUsd: 650,
        candleTimestampMs: 1_710_000_000_000,
        bar: '1m',
      },
      'historical candle requests should include OKX auth headers'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('trade usd tests: ok');
}

void run();
