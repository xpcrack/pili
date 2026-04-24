import { fetchOkxTokenHistoricalPriceBeforeTimestamp, fetchOkxTokenLogoByContract } from '@/lib/okx';
import { findTelegramMonitorMarketCapAtTx } from '@/lib/server/telegramMonitorRepo';

const DEXSCREENER_API_BASE = 'https://api.dexscreener.com';
const DEXSCREENER_TIMEOUT_MS = 6000;
const XXYY_API_BASE = 'https://www.xxyy.io';
const XXYY_TIMEOUT_MS = 6000;

type CurrentValuationSource = 'xxyy' | 'dexscreener';
type LogoSource = 'dexscreener' | 'okx' | 'xxyy' | 'telegram-monitor' | null;

interface CurrentValuationSnapshot {
  source: CurrentValuationSource;
  marketCapUsd: number;
  priceUsd: number;
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

interface FetchTokenLogoOptions {
  txTimestampMs?: number;
  txHash?: string;
}

export interface TokenLogoResult {
  logoUrl: string | null;
  marketCapUsd: number | null;
  marketCapAtTxUsd: number | null;
  marketCapAtTxEstimated: boolean;
  source: LogoSource;
  marketCapAtTxSource?: 'telegram-monitor-exact' | 'estimated';
}

export interface TxMarketCapResolution {
  marketCapAtTxUsd: number | null;
  marketCapAtTxEstimated: boolean;
  marketCapAtTxSource?: 'telegram-monitor-exact' | 'estimated';
  currentMarketCapUsd: number | null;
  currentValuationSource: CurrentValuationSource | null;
}

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

async function resolveCurrentValuation(chain: string, tokenAddress: string) {
  const [fromDexscreener, fromXxyy] = await Promise.all([
    fetchDexscreenerTokenInfo(chain, tokenAddress),
    fetchXxyyTokenInfo(chain, tokenAddress),
  ]);

  let currentValuation: CurrentValuationSnapshot | null = null;
  if (
    typeof fromXxyy?.marketCapUsd === 'number' && fromXxyy.marketCapUsd > 0 &&
    typeof fromXxyy.priceUsd === 'number' && fromXxyy.priceUsd > 0
  ) {
    currentValuation = {
      source: 'xxyy',
      marketCapUsd: fromXxyy.marketCapUsd,
      priceUsd: fromXxyy.priceUsd,
    };
  } else if (
    typeof fromDexscreener?.marketCapUsd === 'number' && fromDexscreener.marketCapUsd > 0 &&
    typeof fromDexscreener.priceUsd === 'number' && fromDexscreener.priceUsd > 0
  ) {
    currentValuation = {
      source: 'dexscreener',
      marketCapUsd: fromDexscreener.marketCapUsd,
      priceUsd: fromDexscreener.priceUsd,
    };
  }

  return {
    fromDexscreener,
    fromXxyy,
    currentValuation,
  };
}

export async function resolveTransactionTimeMarketCap(params: {
  chain: string;
  tokenAddress: string;
  txHash?: string | null;
  txTimestampMs?: number | null;
}): Promise<TxMarketCapResolution> {
  const txHash = typeof params.txHash === 'string' ? params.txHash.trim() : '';
  const txTimestampMs =
    typeof params.txTimestampMs === 'number' && Number.isFinite(params.txTimestampMs)
      ? Math.floor(params.txTimestampMs)
      : null;

  const monitorCap = findTelegramMonitorMarketCapAtTx({
    chain: params.chain,
    tokenAddress: params.tokenAddress,
    txHash: txHash || null,
  });

  if (monitorCap?.marketCapUsd && monitorCap.marketCapUsd > 0) {
    return {
      marketCapAtTxUsd: monitorCap.marketCapUsd,
      marketCapAtTxEstimated: false,
      marketCapAtTxSource: 'telegram-monitor-exact',
      currentMarketCapUsd: monitorCap.marketCapUsd,
      currentValuationSource: null,
    };
  }

  const { currentValuation } = await resolveCurrentValuation(params.chain, params.tokenAddress);
  if (!currentValuation || !txTimestampMs || txTimestampMs <= 0) {
    return {
      marketCapAtTxUsd: null,
      marketCapAtTxEstimated: false,
      currentMarketCapUsd: currentValuation?.marketCapUsd ?? null,
      currentValuationSource: currentValuation?.source ?? null,
    };
  }

  const txPricePoint = await fetchOkxTokenHistoricalPriceBeforeTimestamp(params.chain, params.tokenAddress, txTimestampMs);
  const txPriceUsd = txPricePoint?.priceUsd ?? null;
  if (!txPriceUsd || txPriceUsd <= 0) {
    return {
      marketCapAtTxUsd: null,
      marketCapAtTxEstimated: false,
      currentMarketCapUsd: currentValuation.marketCapUsd,
      currentValuationSource: currentValuation.source,
    };
  }

  const effectiveSupply = currentValuation.marketCapUsd / currentValuation.priceUsd;
  if (!Number.isFinite(effectiveSupply) || effectiveSupply <= 0) {
    return {
      marketCapAtTxUsd: null,
      marketCapAtTxEstimated: false,
      currentMarketCapUsd: currentValuation.marketCapUsd,
      currentValuationSource: currentValuation.source,
    };
  }

  const marketCapAtTxUsd = effectiveSupply * txPriceUsd;
  if (!Number.isFinite(marketCapAtTxUsd) || marketCapAtTxUsd <= 0) {
    return {
      marketCapAtTxUsd: null,
      marketCapAtTxEstimated: false,
      currentMarketCapUsd: currentValuation.marketCapUsd,
      currentValuationSource: currentValuation.source,
    };
  }

  return {
    marketCapAtTxUsd,
    marketCapAtTxEstimated: true,
    marketCapAtTxSource: 'estimated',
    currentMarketCapUsd: currentValuation.marketCapUsd,
    currentValuationSource: currentValuation.source,
  };
}

export async function fetchTokenLogo(
  chain: string,
  tokenAddress: string,
  tokenSymbol?: string,
  options?: FetchTokenLogoOptions
): Promise<TokenLogoResult> {
  const txTimestampMs =
    typeof options?.txTimestampMs === 'number' && Number.isFinite(options.txTimestampMs)
      ? Math.floor(options.txTimestampMs)
      : null;
  const txHash = typeof options?.txHash === 'string' ? options.txHash.trim() : '';

  const [valuationData, marketCapResolution] = await Promise.all([
    resolveCurrentValuation(chain, tokenAddress),
    resolveTransactionTimeMarketCap({
      chain,
      tokenAddress,
      txHash: txHash || null,
      txTimestampMs: txTimestampMs ?? null,
    }),
  ]);

  const currentMarketCapUsd =
    valuationData.currentValuation?.marketCapUsd ??
    marketCapResolution.currentMarketCapUsd ??
    null;

  const preferredSource: LogoSource =
    marketCapResolution.marketCapAtTxSource === 'telegram-monitor-exact'
      ? 'telegram-monitor'
      : valuationData.currentValuation?.source === 'xxyy'
        ? 'xxyy'
        : valuationData.fromDexscreener
          ? 'dexscreener'
          : null;

  // Dexscreener may return a valid pair set without token image metadata.
  // In that case, continue to OKX contract lookup instead of exiting early.
  if (valuationData.fromDexscreener?.logoUrl) {
    return {
      logoUrl: valuationData.fromDexscreener.logoUrl,
      marketCapUsd: currentMarketCapUsd,
      marketCapAtTxUsd: marketCapResolution.marketCapAtTxUsd,
      marketCapAtTxEstimated: marketCapResolution.marketCapAtTxEstimated,
      marketCapAtTxSource: marketCapResolution.marketCapAtTxSource,
      source: preferredSource,
    };
  }

  const fromOkx = await fetchOkxTokenLogoByContract(chain, tokenAddress, tokenSymbol);
  if (fromOkx) {
    return {
      logoUrl: fromOkx,
      marketCapUsd: currentMarketCapUsd,
      marketCapAtTxUsd: marketCapResolution.marketCapAtTxUsd,
      marketCapAtTxEstimated: marketCapResolution.marketCapAtTxEstimated,
      marketCapAtTxSource: marketCapResolution.marketCapAtTxSource,
      source: preferredSource ?? 'okx',
    };
  }

  return {
    logoUrl: null,
    marketCapUsd: currentMarketCapUsd,
    marketCapAtTxUsd: marketCapResolution.marketCapAtTxUsd,
    marketCapAtTxEstimated: marketCapResolution.marketCapAtTxEstimated,
    marketCapAtTxSource: marketCapResolution.marketCapAtTxSource,
    source: preferredSource,
  };
}
