import { fetchOkxTokenHistoricalPriceBeforeTimestamp, fetchOkxTokenLogoByContract } from '@/lib/okx';
import { findTelegramMonitorMarketCapAtTx } from '@/lib/server/telegramMonitorRepo';

const DEXSCREENER_API_BASE = 'https://api.dexscreener.com';
const DEXSCREENER_TIMEOUT_MS = 6000;
const XXYY_API_BASE = 'https://www.xxyy.io';
const XXYY_TIMEOUT_MS = 6000;

function normalizeChainForDexscreener(chain: string) {
  if (chain === 'solana') return 'solana';
  if (chain === 'bsc') return 'bsc';
  if (chain === 'ethereum') return 'ethereum';
  return null;
}

function normalizeChainForXxyy(chain: string) {
  if (chain === 'solana') return 'sol';
  if (chain === 'bsc') return 'bsc';
  if (chain === 'ethereum') return 'eth';
  return null;
}

interface DexscreenerPairToken {
  address?: string;
}

interface DexscreenerPairInfo {
  imageUrl?: string;
}

interface DexscreenerPair {
  baseToken?: DexscreenerPairToken;
  quoteToken?: DexscreenerPairToken;
  info?: DexscreenerPairInfo;
  priceUsd?: number | string;
  marketCap?: number | string;
  fdv?: number | string;
  liquidity?: {
    usd?: number | string;
  };
}

interface XxyyTokenQueryResponse {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: {
    tradeInfo?: {
      marketCapUsd?: number | string;
      price?: number | string;
    };
  };
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
  return null;
}

function pickDexscreenerTokenInfo(pairs: DexscreenerPair[], tokenAddress: string) {
  const target = tokenAddress.toLowerCase();
  const exactPairs = pairs.filter((pair) => {
    const base = pair.baseToken?.address?.toLowerCase();
    const quote = pair.quoteToken?.address?.toLowerCase();
    return base === target || quote === target;
  });

  const sourcePairs = exactPairs.length > 0 ? exactPairs : pairs;
  const bestPair = [...sourcePairs].sort((a, b) => {
    const aLiquidity = parseUsdNumber(a.liquidity?.usd) ?? 0;
    const bLiquidity = parseUsdNumber(b.liquidity?.usd) ?? 0;
    if (aLiquidity !== bLiquidity) {
      return bLiquidity - aLiquidity;
    }

    const aCap = parseUsdNumber(a.marketCap) ?? parseUsdNumber(a.fdv) ?? 0;
    const bCap = parseUsdNumber(b.marketCap) ?? parseUsdNumber(b.fdv) ?? 0;
    return bCap - aCap;
  })[0];

  const logoPair =
    sourcePairs.find((pair) => typeof pair.info?.imageUrl === 'string' && pair.info.imageUrl.trim()) || bestPair;

  return {
    logoUrl: logoPair?.info?.imageUrl?.trim() || null,
    priceUsd: bestPair ? parseUsdNumber(bestPair.priceUsd) : null,
    marketCapUsd: bestPair ? (parseUsdNumber(bestPair.marketCap) ?? parseUsdNumber(bestPair.fdv)) : null,
  };
}

export async function fetchDexscreenerTokenInfo(chain: string, tokenAddress: string) {
  const chainId = normalizeChainForDexscreener(chain);
  const normalizedAddress = tokenAddress.trim();
  if (!chainId || !normalizedAddress) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEXSCREENER_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${DEXSCREENER_API_BASE}/token-pairs/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(normalizedAddress)}`,
      {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      }
    );
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      return null;
    }
    return pickDexscreenerTokenInfo(payload as DexscreenerPair[], normalizedAddress);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchXxyyTokenInfo(chain: string, tokenAddress: string) {
  const apiKey = process.env.XXYY_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }

  const normalizedChain = normalizeChainForXxyy(chain);
  const normalizedAddress = tokenAddress.trim();
  if (!normalizedChain || !normalizedAddress) {
    return null;
  }

  const params = new URLSearchParams({
    ca: normalizedAddress,
    chain: normalizedChain,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), XXYY_TIMEOUT_MS);
  try {
    const response = await fetch(`${XXYY_API_BASE}/api/trade/open/api/query?${params.toString()}`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as XxyyTokenQueryResponse;
    if (payload.success === false || (typeof payload.code === 'number' && payload.code !== 200)) {
      return null;
    }

    const marketCapUsd = parseUsdNumber(payload.data?.tradeInfo?.marketCapUsd);
    const priceUsd = parseUsdNumber(payload.data?.tradeInfo?.price);
    if (marketCapUsd === null && priceUsd === null) {
      return null;
    }

    return {
      marketCapUsd,
      priceUsd,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface FetchTokenLogoOptions {
  txTimestampMs?: number;
  txHash?: string;
}

async function estimateMarketCapAtTx(params: {
  chain: string;
  tokenAddress: string;
  currentMarketCapUsd: number;
  currentPriceUsd: number | null;
  txTimestampMs: number;
}) {
  const { chain, tokenAddress, currentMarketCapUsd, currentPriceUsd, txTimestampMs } = params;
  const [txPricePoint, currentPricePoint] = await Promise.all([
    fetchOkxTokenHistoricalPriceBeforeTimestamp(chain, tokenAddress, txTimestampMs),
    fetchOkxTokenHistoricalPriceBeforeTimestamp(chain, tokenAddress, Date.now()),
  ]);

  const resolvedCurrentPrice = currentPricePoint?.priceUsd ?? currentPriceUsd;
  const resolvedTxPrice = txPricePoint?.priceUsd ?? null;

  if (
    !resolvedCurrentPrice ||
    resolvedCurrentPrice <= 0 ||
    !resolvedTxPrice ||
    resolvedTxPrice <= 0
  ) {
    return {
      marketCapAtTxUsd: null,
      marketCapAtTxEstimated: false,
    };
  }

  const inferredCirculatingSupply = currentMarketCapUsd / resolvedCurrentPrice;
  const estimatedMarketCap = inferredCirculatingSupply * resolvedTxPrice;
  if (!Number.isFinite(estimatedMarketCap) || estimatedMarketCap <= 0) {
    return {
      marketCapAtTxUsd: null,
      marketCapAtTxEstimated: false,
    };
  }

  return {
    marketCapAtTxUsd: estimatedMarketCap,
    marketCapAtTxEstimated: true,
  };
}

export async function fetchTokenLogo(
  chain: string,
  tokenAddress: string,
  tokenSymbol?: string,
  options?: FetchTokenLogoOptions
) {
  const [fromDexscreener, fromXxyy] = await Promise.all([
    fetchDexscreenerTokenInfo(chain, tokenAddress),
    fetchXxyyTokenInfo(chain, tokenAddress),
  ]);

  const currentMarketCapUsd = fromXxyy?.marketCapUsd ?? fromDexscreener?.marketCapUsd ?? null;
  const currentPriceUsd = fromXxyy?.priceUsd ?? fromDexscreener?.priceUsd ?? null;
  let marketCapAtTxUsd: number | null = null;
  let marketCapAtTxEstimated = false;

  const txTimestampMs =
    typeof options?.txTimestampMs === 'number' && Number.isFinite(options.txTimestampMs)
      ? Math.floor(options.txTimestampMs)
      : null;
  const txHash = typeof options?.txHash === 'string' ? options.txHash.trim() : '';

  const monitorCap = findTelegramMonitorMarketCapAtTx({
    chain,
    tokenAddress,
    txHash: txHash || null,
    txTimestampMs: txTimestampMs ?? null,
  });

  if (monitorCap?.marketCapUsd && monitorCap.marketCapUsd > 0) {
    marketCapAtTxUsd = monitorCap.marketCapUsd;
    marketCapAtTxEstimated = false;
  } else if (currentMarketCapUsd && currentMarketCapUsd > 0 && txTimestampMs && txTimestampMs > 0) {
    const estimation = await estimateMarketCapAtTx({
      chain,
      tokenAddress,
      currentMarketCapUsd,
      currentPriceUsd,
      txTimestampMs,
    });
    marketCapAtTxUsd = estimation.marketCapAtTxUsd;
    marketCapAtTxEstimated = estimation.marketCapAtTxEstimated;
  }

  if (fromDexscreener) {
    return {
      logoUrl: fromDexscreener.logoUrl,
      marketCapUsd: currentMarketCapUsd,
      marketCapAtTxUsd,
      marketCapAtTxEstimated,
      source: monitorCap ? ('telegram-monitor' as const) : (fromXxyy ? ('xxyy' as const) : ('dexscreener' as const)),
    };
  }

  const fromOkx = await fetchOkxTokenLogoByContract(chain, tokenAddress, tokenSymbol);
  if (fromOkx) {
    return {
      logoUrl: fromOkx,
      marketCapUsd: currentMarketCapUsd,
      marketCapAtTxUsd,
      marketCapAtTxEstimated,
      source: monitorCap ? ('telegram-monitor' as const) : (fromXxyy ? ('xxyy' as const) : ('okx' as const)),
    };
  }

  return {
    logoUrl: null,
    marketCapUsd: currentMarketCapUsd,
    marketCapAtTxUsd,
    marketCapAtTxEstimated,
    source: monitorCap ? ('telegram-monitor' as const) : (fromXxyy ? ('xxyy' as const) : null),
  };
}
