import 'server-only';

/**
 * Hyperliquid HyperCore spot token API
 * Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
 */

const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';

interface HyperCoreToken {
  name: string;
  szDecimals: number;
  weiDecimals: number;
  index: number;
  tokenId: string;
  isCanonical: boolean;
  evmContract: {
    address: string;
    evm_extra_wei_decimals: number;
  } | null;
  fullName: string | null;
}

interface HyperCoreSpotPair {
  tokens: [number, number]; // [base, quote]
  name: string;
  index: number;
  isCanonical: boolean;
}

interface HyperCoreSpotMeta {
  universe: HyperCoreSpotPair[];
  tokens: HyperCoreToken[];
}

// Token index -> token info cache
let tokenCache: Map<number, HyperCoreToken> | null = null;
let tokenNameCache: Map<string, HyperCoreToken> | null = null;
let lastFetch = 0;
const CACHE_TTL = 60_000; // 1 min

async function fetchSpotMeta(): Promise<HyperCoreSpotMeta> {
  const res = await fetch(HYPERLIQUID_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'spotMeta' }),
  });
  if (!res.ok) throw new Error(`HyperCore API error: ${res.status}`);
  return res.json();
}

async function ensureCache() {
  if (tokenCache && Date.now() - lastFetch < CACHE_TTL) return;
  const meta = await fetchSpotMeta();
  tokenCache = new Map();
  tokenNameCache = new Map();
  for (const t of meta.tokens) {
    tokenCache.set(t.index, t);
    tokenNameCache.set(t.name.toUpperCase(), t);
  }
  lastFetch = Date.now();
}

/** Find token by name (e.g. "PURR") or index */
export async function getHyperCoreToken(identifier: string | number): Promise<HyperCoreToken | null> {
  await ensureCache();
  if (typeof identifier === 'number') return tokenCache!.get(identifier) ?? null;
  return tokenNameCache!.get(identifier.toUpperCase()) ?? null;
}

/** Get all mids (mid prices) for spot pairs */
export async function getHyperCoreMids(): Promise<Record<string, string>> {
  const res = await fetch(HYPERLIQUID_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'allMids' }),
  });
  if (!res.ok) throw new Error(`HyperCore mids error: ${res.status}`);
  return res.json();
}

/** Get spot price for a token name (e.g. "PURR") */
export async function getHyperCorePrice(tokenName: string): Promise<number | null> {
  const mids = await getHyperCoreMids();

  // Try direct name match first (e.g. "PURR")
  const directPrice = mids[tokenName];
  if (directPrice) return parseFloat(directPrice);

  // Try name/USDC format
  const pairPrice = mids[`${tokenName}/USDC`];
  if (pairPrice) return parseFloat(pairPrice);

  // For non-canonical tokens, need to look up by pair index
  // Fetch spotMeta to get token -> pair mapping
  const meta = await fetchSpotMeta();
  const token = meta.tokens.find(t => t.name.toUpperCase() === tokenName.toUpperCase());
  if (!token) return null;

  // Find the pair that has this token as base
  const pair = meta.universe.find(p => p.tokens[0] === token.index);
  if (!pair) return null;

  // The pair name is used as key in allMids (e.g. "@1", "@2", or "PURR/USDC")
  const pairPrice2 = mids[pair.name];
  return pairPrice2 ? parseFloat(pairPrice2) : null;
}

/** Get token info + price for display */
export async function getHyperCoreTokenInfo(tokenName: string): Promise<{
  name: string;
  index: number;
  price: number | null;
  evmAddress: string | null;
} | null> {
  const token = await getHyperCoreToken(tokenName);
  if (!token) return null;

  const price = await getHyperCorePrice(tokenName);

  return {
    name: token.name,
    index: token.index,
    price,
    evmAddress: token.evmContract?.address ?? null,
  };
}

/**
 * Batch get HyperCore token prices
 * @param tokenNames e.g. ["PURR", "HFUN", "POINTS"]
 */
export async function getHyperCoreBatchPrices(tokenNames: string[]): Promise<Record<string, number | null>> {
  const mids = await getHyperCoreMids();
  const result: Record<string, number | null> = {};
  for (const name of tokenNames) {
    const price = mids[name] ?? mids[`${name}/USDC`];
    result[name] = price ? parseFloat(price) : null;
  }
  return result;
}
