import 'server-only';

const DEXSCREENER_API = 'https://api.dexscreener.com';
const MAINSTREAM_SYMBOLS = ['USDC', 'USDT', 'SOL', 'WSOL', 'ETH', 'WETH', 'BNB', 'WBNB'] as const;
const NATIVE_TOKEN_ADDRESSES: Record<string, string | undefined> = {
  solana: 'So11111111111111111111111111111111111111112',
  ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  base: '0x4200000000000000000000000000000000000006',
  bsc: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  hyperevm: undefined,
};
const STABLECOIN_ADDRESSES: Record<string, string[]> = {
  solana: [
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  ],
  ethereum: [
    '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  ],
  base: [
    '0x833589fCD6EDB6E08f4c7C32D4f71b54bdA02913',
    '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  ],
  bsc: [
    '0x55d398326f99059fF775485246999027B3197955',
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
  ],
  hyperevm: [],
};

export interface DexScreenerPair {
  chainId: string;
  dexId?: string;
  url?: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken?: {
    address?: string;
    name?: string;
    symbol?: string;
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
  info?: {
    imageUrl?: string;
    socials?: Array<{ type?: string; url?: string }>;
  };
}

interface DexScreenerResponse {
  schemaVersion: string;
  pairs: DexScreenerPair[] | null;
}

const CHAIN_MAP: Record<string, string> = {
  solana: 'solana',
  ethereum: 'ethereum',
  bsc: 'bsc',
  base: 'base',
  hyperevm: 'hyperevm',
};

function isEvmChain(chain: string) {
  return ['ethereum', 'bsc', 'base', 'hyperevm'].includes(chain.toLowerCase());
}

export function normalizeDexScreenerTokenKey(chain: string, address: string) {
  const trimmed = address.trim();
  return isEvmChain(chain) ? trimmed.toLowerCase() : trimmed;
}

function parseUsdNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function isReasonableDexPairPrice(pair: DexScreenerPair) {
  const price = parseUsdNumber(pair.priceUsd);
  return price > 0 && price < 1_000_000_000;
}

function isPreferredQuoteToken(chain: string, pair: DexScreenerPair) {
  const quoteSymbol = pair.quoteToken?.symbol?.toUpperCase();
  if (quoteSymbol && MAINSTREAM_SYMBOLS.includes(quoteSymbol as (typeof MAINSTREAM_SYMBOLS)[number])) {
    return true;
  }

  const quoteAddress = pair.quoteToken?.address?.trim();
  if (!quoteAddress) {
    return false;
  }

  const normalizedQuote = normalizeDexScreenerTokenKey(chain, quoteAddress);
  const nativeAddress = NATIVE_TOKEN_ADDRESSES[chain.toLowerCase()];
  if (nativeAddress && normalizeDexScreenerTokenKey(chain, nativeAddress) === normalizedQuote) {
    return true;
  }

  const stablecoinAddresses = STABLECOIN_ADDRESSES[chain.toLowerCase()] ?? [];
  return stablecoinAddresses.some((address) => normalizeDexScreenerTokenKey(chain, address) === normalizedQuote);
}

export function selectPreferredDexScreenerPair(
  contractAddress: string,
  chain: string,
  pairs: DexScreenerPair[]
) {
  const chainKey = chain.toLowerCase();
  const dexChain = CHAIN_MAP[chainKey];
  if (!dexChain) {
    return null;
  }

  const normalizedContract = normalizeDexScreenerTokenKey(chainKey, contractAddress);
  let filteredPairs = pairs.filter((pair) => {
    if (pair.chainId !== dexChain) {
      return false;
    }
    return normalizeDexScreenerTokenKey(chainKey, pair.baseToken.address) === normalizedContract;
  });

  if (filteredPairs.length === 0) {
    return null;
  }

  filteredPairs = filteredPairs.filter((pair) => isReasonableDexPairPrice(pair));
  if (filteredPairs.length === 0) {
    return null;
  }

  const preferredQuotePairs = filteredPairs.filter((pair) => isPreferredQuoteToken(chainKey, pair));
  const candidatePairs = preferredQuotePairs.length > 0 ? preferredQuotePairs : filteredPairs;

  return [...candidatePairs].sort((left, right) => {
    const liquidityDiff = (right.liquidity?.usd || 0) - (left.liquidity?.usd || 0);
    if (liquidityDiff !== 0) {
      return liquidityDiff;
    }

    const volume6hDiff = (right.volume?.h6 || 0) - (left.volume?.h6 || 0);
    if (volume6hDiff !== 0) {
      return volume6hDiff;
    }

    return (right.volume?.h24 || 0) - (left.volume?.h24 || 0);
  })[0] ?? null;
}

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
    return null;
  }

  try {
    const url = `${DEXSCREENER_API}/latest/dex/tokens/${contractAddress}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
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

    const pair = selectPreferredDexScreenerPair(contractAddress, chain, data.pairs);
    if (!pair) {
      return null;
    }

    return {
      ticker: pair.baseToken.symbol,
      name: pair.baseToken.name,
      price: parseUsdNumber(pair.priceUsd),
      // Prefer circulating marketCap; FDV often overstates meme MC.
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

export async function batchFetchFromDexScreener(
  tokens: Array<{ contractAddress: string; chain: string }>
): Promise<
  Map<
    string,
    {
      ticker: string;
      name: string;
      price: number;
      marketCap: number;
      liquidity: number;
      priceChange24h: number;
      volume24h: number;
    }
  >
> {
  const result = new Map();
  const byChain = new Map<string, string[]>();

  for (const token of tokens) {
    const chain = token.chain.toLowerCase();
    if (!CHAIN_MAP[chain]) {
      continue;
    }
    if (!byChain.has(chain)) {
      byChain.set(chain, []);
    }
    byChain.get(chain)!.push(token.contractAddress);
  }

  for (const [chain, addresses] of byChain) {
    for (let i = 0; i < addresses.length; i += 30) {
      const batch = addresses.slice(i, i + 30);
      try {
        const url = `${DEXSCREENER_API}/latest/dex/tokens/${batch.join(',')}`;
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
          continue;
        }

        const data: DexScreenerResponse = await res.json();
        if (!data.pairs) {
          continue;
        }

        const requestedKeys = new Set(batch.map((address) => normalizeDexScreenerTokenKey(chain, address)));
        const pairsByToken = new Map<string, DexScreenerPair[]>();

        for (const pair of data.pairs) {
          const baseKey = normalizeDexScreenerTokenKey(chain, pair.baseToken.address);
          if (!requestedKeys.has(baseKey)) {
            continue;
          }
          const existing = pairsByToken.get(baseKey) ?? [];
          existing.push(pair);
          pairsByToken.set(baseKey, existing);
        }

        for (const address of batch) {
          const key = normalizeDexScreenerTokenKey(chain, address);
          const pair = selectPreferredDexScreenerPair(address, chain, pairsByToken.get(key) ?? []);
          if (!pair) {
            continue;
          }
          result.set(key, {
            ticker: pair.baseToken.symbol,
            name: pair.baseToken.name,
            price: parseUsdNumber(pair.priceUsd),
            marketCap: pair.marketCap || pair.fdv || 0,
            liquidity: pair.liquidity?.usd || 0,
            priceChange24h: pair.priceChange?.h24 || 0,
            volume24h: pair.volume?.h24 || 0,
          });
        }

        if (i + 30 < addresses.length) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      } catch (err) {
        console.error(`DexScreener batch error for ${chain}:`, err);
      }
    }
  }

  return result;
}
