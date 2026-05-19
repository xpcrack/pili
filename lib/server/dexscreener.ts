import 'server-only';

/**
 * DexScreener API client for token prices
 * Docs: https://docs.dexscreener.com/api/reference
 */

const DEXSCREENER_API = 'https://api.dexscreener.com';

interface DexScreenerPair {
  chainId: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceUsd: string;
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  liquidity: {
    usd: number;
  };
  volume: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  fdv: number;
  marketCap: number;
  pairCreatedAt: number;
}

interface DexScreenerResponse {
  schemaVersion: string;
  pairs: DexScreenerPair[] | null;
}

// Chain name mapping for DexScreener
const CHAIN_MAP: Record<string, string> = {
  solana: 'solana',
  ethereum: 'ethereum',
  bsc: 'bsc',
  base: 'base',
  hyperevm: 'hyperevm',
};

/** Fetch token data from DexScreener */
export async function fetchFromDexScreener(
  contractAddress: string,
  chain: string
): Promise<{
  ticker: string;
  name: string;
  price: number;
  marketCap: number;
  liquidity: number;
  priceChange24h: number;
  volume24h: number;
} | null> {
  const dexChain = CHAIN_MAP[chain.toLowerCase()];
  if (!dexChain) {
    // HyperCore tokens are not on DexScreener
    return null;
  }

  try {
    const url = `${DEXSCREENER_API}/latest/dex/tokens/${contractAddress}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.error(`DexScreener API error: ${res.status}`);
      return null;
    }

    const data: DexScreenerResponse = await res.json();

    if (!data.pairs || data.pairs.length === 0) {
      return null;
    }

    // Find the best pair for this chain
    const pair = data.pairs.find(p => p.chainId === dexChain) ?? data.pairs[0];

    if (!pair) return null;

    return {
      ticker: pair.baseToken.symbol,
      name: pair.baseToken.name,
      price: parseFloat(pair.priceUsd) || 0,
      marketCap: pair.marketCap || pair.fdv || 0,
      liquidity: pair.liquidity?.usd || 0,
      priceChange24h: pair.priceChange?.h24 || 0,
      volume24h: pair.volume?.h24 || 0,
    };
  } catch (err) {
    console.error('DexScreener fetch error:', err);
    return null;
  }
}

/** Batch fetch multiple tokens from DexScreener */
export async function batchFetchFromDexScreener(
  tokens: Array<{ contractAddress: string; chain: string }>
): Promise<Map<string, {
  ticker: string;
  name: string;
  price: number;
  marketCap: number;
  liquidity: number;
  priceChange24h: number;
  volume24h: number;
}>> {
  const result = new Map();

  // Group by chain for efficiency
  const byChain = new Map<string, string[]>();
  for (const t of tokens) {
    const dexChain = CHAIN_MAP[t.chain.toLowerCase()];
    if (!dexChain) continue; // Skip HyperCore

    if (!byChain.has(dexChain)) {
      byChain.set(dexChain, []);
    }
    byChain.get(dexChain)!.push(t.contractAddress);
  }

  // Fetch each chain's tokens
  for (const [chain, addresses] of byChain) {
    // DexScreener allows up to 30 addresses per request
    for (let i = 0; i < addresses.length; i += 30) {
      const batch = addresses.slice(i, i + 30);
      try {
        const url = `${DEXSCREENER_API}/latest/dex/tokens/${batch.join(',')}`;
        const res = await fetch(url, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) continue;

        const data: DexScreenerResponse = await res.json();
        if (!data.pairs) continue;

        for (const pair of data.pairs) {
          if (pair.chainId !== chain) continue;

          result.set(pair.baseToken.address.toLowerCase(), {
            ticker: pair.baseToken.symbol,
            name: pair.baseToken.name,
            price: parseFloat(pair.priceUsd) || 0,
            marketCap: pair.marketCap || pair.fdv || 0,
            liquidity: pair.liquidity?.usd || 0,
            priceChange24h: pair.priceChange?.h24 || 0,
            volume24h: pair.volume?.h24 || 0,
          });
        }

        // Rate limit: small delay between batches
        if (i + 30 < addresses.length) {
          await new Promise(r => setTimeout(r, 200));
        }
      } catch (err) {
        console.error(`DexScreener batch error for ${chain}:`, err);
      }
    }
  }

  return result;
}
