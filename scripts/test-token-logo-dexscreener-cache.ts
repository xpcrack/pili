import assert from 'node:assert/strict';

import { fetchDexscreenerTokenInfo, clearDexInfoCache } from '@/lib/tokenLogo';

const TOKEN_CA = 'Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump';
const OTHER_CA = 'Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo111';

function createJsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function run() {
  const originalFetch = globalThis.fetch;
  clearDexInfoCache();

  try {
    let fetchCount = 0;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      fetchCount += 1;
      if (url.includes(`/token-pairs/v1/solana/${TOKEN_CA}`)) {
        return createJsonResponse([
          {
            chainId: 'solana',
            dexId: 'pumpswap',
            pairAddress: 'pair',
            baseToken: { address: TOKEN_CA, name: 'Test', symbol: 'TEST' },
            quoteToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' },
            priceUsd: '0.5',
            marketCap: 1_000_000,
            fdv: 1_000_000,
            liquidity: { usd: 50_000 },
            info: { imageUrl: 'https://good.example/token.png' },
          },
        ]);
      }
      if (url.includes(`/token-pairs/v1/solana/${OTHER_CA}`)) {
        return createJsonResponse([]);
      }
      throw new Error(`Unhandled fetch: ${url}`);
    };

    // same chain+token twice → one upstream call
    const first = await fetchDexscreenerTokenInfo('solana', TOKEN_CA);
    const second = await fetchDexscreenerTokenInfo('solana', TOKEN_CA);
    assert.ok(first?.logoUrl, 'expected logo from first call');
    assert.equal(second?.logoUrl, first?.logoUrl, 'cache hit returns same value');
    assert.equal(fetchCount, 1, 'same token within TTL must not re-fetch');

    // different token → new upstream call
    const empty = await fetchDexscreenerTokenInfo('solana', OTHER_CA);
    assert.equal(empty?.marketCapUsd, null, 'empty pair list yields null fields');
    assert.equal(fetchCount, 2, 'different token must fetch');

    // case-insensitive key: same token different case → cache hit
    const upper = await fetchDexscreenerTokenInfo('solana', TOKEN_CA.toUpperCase());
    assert.equal(upper?.logoUrl, first?.logoUrl, 'case-insensitive key hits cache');
    assert.equal(fetchCount, 2, 'case variant must not re-fetch');

    console.log('token logo dexscreener cache tests: ok');
  } finally {
    globalThis.fetch = originalFetch;
    clearDexInfoCache();
  }
}

void run();
