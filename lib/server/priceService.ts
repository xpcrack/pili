import 'server-only';

import { fetchFromDexScreener, batchFetchFromDexScreener } from './dexscreener';
import { getHyperCorePrice, getHyperCoreBatchPrices } from './hypercoreClient';
import type { TokenChain } from './tokensRepo';

export interface TokenPriceData {
  price: number | null;
  marketCap: number | null;
  priceChange24h: number | null;
  ticker: string | null;
}

/** Get price for a single token */
export async function getTokenPrice(
  chain: TokenChain,
  contractAddress: string
): Promise<TokenPriceData> {
  // HyperCore uses different API
  if (chain === 'hypercore') {
    const price = await getHyperCorePrice(contractAddress);
    return {
      price,
      marketCap: null, // HyperCore API doesn't provide mcap directly
      priceChange24h: null,
      ticker: contractAddress, // contractAddress is token name for hypercore
    };
  }

  // All other chains use DexScreener
  const data = await fetchFromDexScreener(contractAddress, chain);
  if (!data) {
    return { price: null, marketCap: null, priceChange24h: null, ticker: null };
  }

  return {
    price: data.price,
    marketCap: data.marketCap,
    priceChange24h: data.priceChange24h,
    ticker: data.ticker,
  };
}

/** Batch get prices for multiple tokens */
export async function getBatchTokenPrices(
  tokens: Array<{ chain: TokenChain; contractAddress: string }>
): Promise<Map<string, TokenPriceData>> {
  const result = new Map<string, TokenPriceData>();

  // Split by chain type
  const hypercoreTokens = tokens.filter(t => t.chain === 'hypercore');
  const dexScreenerTokens = tokens.filter(t => t.chain !== 'hypercore');

  // Fetch HyperCore prices
  if (hypercoreTokens.length > 0) {
    const names = hypercoreTokens.map(t => t.contractAddress);
    const prices = await getHyperCoreBatchPrices(names);

    for (const t of hypercoreTokens) {
      const key = `${t.chain}:${t.contractAddress}`;
      result.set(key, {
        price: prices[t.contractAddress] ?? null,
        marketCap: null,
        priceChange24h: null,
        ticker: t.contractAddress,
      });
    }
  }

  // Fetch DexScreener prices
  if (dexScreenerTokens.length > 0) {
    const priceMap = await batchFetchFromDexScreener(
      dexScreenerTokens.map(t => ({
        contractAddress: t.contractAddress,
        chain: t.chain,
      }))
    );

    for (const t of dexScreenerTokens) {
      const key = `${t.chain}:${t.contractAddress}`;
      const data = priceMap.get(t.contractAddress.toLowerCase());

      if (data) {
        result.set(key, {
          price: data.price,
          marketCap: data.marketCap,
          priceChange24h: data.priceChange24h,
          ticker: data.ticker,
        });
      } else {
        result.set(key, {
          price: null,
          marketCap: null,
          priceChange24h: null,
          ticker: null,
        });
      }
    }
  }

  return result;
}
