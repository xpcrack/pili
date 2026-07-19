import assert from 'node:assert/strict';

import { fetchDexscreenerTokenInfo } from '@/lib/tokenLogo';

function createJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

async function run() {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('/token-pairs/v1/solana/Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump')) {
        return createJsonResponse([
          {
            chainId: 'solana',
            dexId: 'meteora',
            pairAddress: 'badpair',
            baseToken: {
              address: 'Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump',
              name: 'Test Token',
              symbol: 'TEST',
            },
            quoteToken: {
              address: 'J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump',
              symbol: 'TripleT',
              name: 'TripleT',
            },
            priceUsd: '110',
            marketCap: 110_000_000_000,
            fdv: 110_000_000_000,
            liquidity: { usd: 12_000_000 },
            volume: { m5: 0, h1: 0, h6: 0, h24: 32_000_000 },
            priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 },
            info: { imageUrl: 'https://bad.example/token.png' },
          },
          {
            chainId: 'solana',
            dexId: 'pumpswap',
            pairAddress: 'goodpair',
            baseToken: {
              address: 'Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump',
              name: 'Test Token',
              symbol: 'TEST',
            },
            quoteToken: {
              address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              symbol: 'USDC',
              name: 'USD Coin',
            },
            priceUsd: '0.0227',
            marketCap: 22_700_000,
            fdv: 22_700_000,
            liquidity: { usd: 280_000 },
            volume: { m5: 1000, h1: 10_000, h6: 250_000, h24: 3_400_000 },
            priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 },
            info: { imageUrl: 'https://good.example/token.png' },
          },
        ]);
      }

      throw new Error(`Unhandled fetch in test-token-logo-dex-preferred-pair: ${url}`);
    };

    const result = await fetchDexscreenerTokenInfo('solana', 'Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump');
    assert.ok(result, 'expected DexScreener token info');
    assert.equal(result?.marketCapUsd, 22_700_000, 'should prefer mainstream quote pair market cap');
    assert.equal(result?.priceUsd, 0.0227, 'should prefer mainstream quote pair price');
    assert.equal(result?.liquidityUsd, 280_000, 'should follow preferred pair liquidity');
    assert.equal(result?.logoUrl, 'https://good.example/token.png', 'should use preferred pair image when available');

    console.log('token logo preferred pair tests: ok');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void run();
