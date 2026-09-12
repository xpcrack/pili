import { fetchOkxTokenHistoricalPriceBeforeTimestamp, fetchOkxTokenLogoByContract } from '@/lib/okx';
import {
  normalizeDexScreenerTokenKey,
  selectPreferredDexScreenerPair,
  type DexScreenerPair,
} from '@/lib/server/dexscreener';
import { fetchGmgnTokenInfo } from '@/lib/server/gmgnTokenInfo';
import { gmgnCooldownRemainingMs } from '@/lib/server/gmgnRateLimit';
import { findTelegramMonitorMarketCapAtTx } from '@/lib/server/telegramMonitorRepo';

const DEXSCREENER_API_BASE = 'https://api.dexscreener.com';
const DEXSCREENER_TIMEOUT_MS = 6000;

type CurrentValuationSource = 'dexscreener' | 'gmgn';
type LogoSource = 'dexscreener' | 'okx' | 'gmgn' | 'telegram-monitor' | null;

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

interface FetchTokenLogoOptions {
  txTimestampMs?: number;
  txHash?: string;
  /** 只要现价/市值/流动性，不做 logo 补全（OKX/GMGN 回退是 5s+ 慢路径）。 */
  metricsOnly?: boolean;
}

export interface DexscreenerTokenInfo {
  logoUrl: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
}

export interface TokenLogoResult {
  logoUrl: string | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  priceUsd: number | null;
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
  if (chain === 'base') return 'base';
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

function pickDexscreenerTokenInfo(pairs: DexScreenerPair[], chain: string, tokenAddress: string) {
  const bestPair = selectPreferredDexScreenerPair(tokenAddress, chain, pairs);
  const target = normalizeDexScreenerTokenKey(chain, tokenAddress);
  const matchingPairs = pairs.filter((pair) => {
    const base = pair.baseToken?.address ? normalizeDexScreenerTokenKey(chain, pair.baseToken.address) : null;
    return base === target;
  });
  const sourcePairs = matchingPairs.length > 0 ? matchingPairs : pairs;
  const logoPair = bestPair && typeof bestPair.info?.imageUrl === 'string' && bestPair.info.imageUrl.trim()
    ? bestPair
    : sourcePairs.find((pair) => typeof pair.info?.imageUrl === 'string' && pair.info.imageUrl.trim()) || bestPair;

  return {
    logoUrl: logoPair?.info?.imageUrl?.trim() || null,
    priceUsd: bestPair ? parseUsdNumber(bestPair.priceUsd) : null,
    marketCapUsd: bestPair ? (parseUsdNumber(bestPair.fdv) || parseUsdNumber(bestPair.marketCap) || null) : null,
    liquidityUsd: bestPair ? parseUsdNumber(bestPair.liquidity?.usd) : null,
  };
}

/** 进程级 dexscreener 现价信息缓存：feed 每 15s 重渲染对同 token 重复打
 * token-pairs 端点；成功 60s / 失败 10s 负缓存把 N 次 render 合成 1 次请求。
 * 只缓存「当前估值」(logo/marketCap/liquidity)；tx 时间点估值不经过这里。 */
const DEX_INFO_TTL_MS = 60_000;
const DEX_INFO_ERROR_TTL_MS = 10_000;
const dexInfoCache = new Map<string, { at: number; value: DexscreenerTokenInfo | null }>();

export function clearDexInfoCache(): void {
  dexInfoCache.clear();
}

export async function fetchDexscreenerTokenInfo(chain: string, tokenAddress: string) {
  const chainId = normalizeChainForDexscreener(chain);
  const normalizedAddress = tokenAddress.trim();
  if (!chainId || !normalizedAddress) {
    return null;
  }
  const key = `${chainId}|${normalizedAddress.toLowerCase()}`;
  const now = Date.now();
  const hit = dexInfoCache.get(key);
  if (hit) {
    const ttl = hit.value ? DEX_INFO_TTL_MS : DEX_INFO_ERROR_TTL_MS;
    if (now - hit.at < ttl) return hit.value;
  }
  const value = await fetchDexscreenerTokenInfoUncached(chainId, normalizedAddress);
  dexInfoCache.set(key, { at: now, value });
  return value;
}

async function fetchDexscreenerTokenInfoUncached(chainId: string, normalizedAddress: string) {

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
    return pickDexscreenerTokenInfo(payload as DexScreenerPair[], chainId, normalizedAddress) as DexscreenerTokenInfo;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveCurrentValuation(chain: string, tokenAddress: string) {
  const fromDexscreener = await fetchDexscreenerTokenInfo(chain, tokenAddress);

  let currentValuation: CurrentValuationSnapshot | null = null;
  if (
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
  const normalizedChain = chain.trim().toLowerCase();
  const isRobinhood = normalizedChain === 'robinhood' || normalizedChain === 'rh';
  const gmgnAllowed = gmgnCooldownRemainingMs() <= 0;

  // Robinhood has no DexScreener / OKX logo coverage — go straight to GMGN.
  if (isRobinhood) {
    const monitorCap = findTelegramMonitorMarketCapAtTx({ chain, tokenAddress, txHash: txHash || null });
    let marketCapAtTxUsd: number | null = null;
    let marketCapAtTxEstimated = false;
    let marketCapAtTxSource: 'telegram-monitor-exact' | 'estimated' | undefined;
    if (monitorCap?.marketCapUsd && monitorCap.marketCapUsd > 0) {
      marketCapAtTxUsd = monitorCap.marketCapUsd;
      marketCapAtTxSource = 'telegram-monitor-exact';
    }

    let gmgnResult: Awaited<ReturnType<typeof fetchGmgnTokenInfo>> = null;
    if (gmgnAllowed) {
      gmgnResult = await fetchGmgnTokenInfo(chain, tokenAddress);
    }

    return {
      logoUrl: gmgnResult?.logoUrl ?? null,
      marketCapUsd: gmgnResult?.marketCapUsd ?? null,
      liquidityUsd: null,
      priceUsd: null,
      marketCapAtTxUsd,
      marketCapAtTxEstimated,
      marketCapAtTxSource,
      source: gmgnResult?.logoUrl ? 'gmgn' : marketCapAtTxSource === 'telegram-monitor-exact' ? 'telegram-monitor' : null,
    };
  }

  // Single DexScreener call — shared for both current valuation and tx-time market cap.
  const fromDexscreener = await fetchDexscreenerTokenInfo(chain, tokenAddress);

  const currentPriceUsd = fromDexscreener?.priceUsd ?? null;
  const currentMarketCapUsd = fromDexscreener?.marketCapUsd ?? null;
  const liquidityUsd = fromDexscreener?.liquidityUsd ?? null;

  // Transaction-time market cap: prefer Telegram monitor exact, else estimate from current data.
  const monitorCap = findTelegramMonitorMarketCapAtTx({ chain, tokenAddress, txHash: txHash || null });
  let marketCapAtTxUsd: number | null = null;
  let marketCapAtTxEstimated = false;
  let marketCapAtTxSource: 'telegram-monitor-exact' | 'estimated' | undefined;

  if (monitorCap?.marketCapUsd && monitorCap.marketCapUsd > 0) {
    marketCapAtTxUsd = monitorCap.marketCapUsd;
    marketCapAtTxSource = 'telegram-monitor-exact';
  } else if (currentMarketCapUsd && currentPriceUsd && currentPriceUsd > 0 && txTimestampMs && txTimestampMs > 0) {
    const txPricePoint = await fetchOkxTokenHistoricalPriceBeforeTimestamp(chain, tokenAddress, txTimestampMs);
    const txPriceUsd = txPricePoint?.priceUsd ?? null;
    if (txPriceUsd && txPriceUsd > 0) {
      const effectiveSupply = currentMarketCapUsd / currentPriceUsd;
      if (Number.isFinite(effectiveSupply) && effectiveSupply > 0) {
        const estimated = effectiveSupply * txPriceUsd;
        if (Number.isFinite(estimated) && estimated > 0) {
          marketCapAtTxUsd = estimated;
          marketCapAtTxEstimated = true;
          marketCapAtTxSource = 'estimated';
        }
      }
    }
  }

  // metricsOnly（持仓面板批量）：DexScreener 现价/市值/流动性就是全部所需，
  // 跳过 OKX/GMGN logo 补全 —— 那条链路单 token 可拖 5-12s 并烧 GMGN 配额。
  if (options?.metricsOnly) {
    return {
      logoUrl: fromDexscreener?.logoUrl ?? null,
      marketCapUsd: currentMarketCapUsd,
      liquidityUsd,
      priceUsd: currentPriceUsd,
      marketCapAtTxUsd,
      marketCapAtTxEstimated,
      marketCapAtTxSource,
      source: fromDexscreener ? 'dexscreener' : null,
    };
  }

  const preferredSource: LogoSource =
    marketCapAtTxSource === 'telegram-monitor-exact'
      ? 'telegram-monitor'
      : fromDexscreener
        ? 'dexscreener'
        : null;

  // Dexscreener may return a valid pair set without token image metadata.
  // In that case, continue to OKX contract lookup instead of exiting early.
  if (fromDexscreener?.logoUrl) {
    return {
      logoUrl: fromDexscreener.logoUrl,
      marketCapUsd: currentMarketCapUsd,
      liquidityUsd,
      priceUsd: currentPriceUsd,
      marketCapAtTxUsd,
      marketCapAtTxEstimated,
      marketCapAtTxSource,
      source: preferredSource,
    };
  }

  const fromOkx = await fetchOkxTokenLogoByContract(chain, tokenAddress, tokenSymbol);
  if (fromOkx) {
    return {
      logoUrl: fromOkx,
      marketCapUsd: currentMarketCapUsd,
      liquidityUsd,
      priceUsd: currentPriceUsd,
      marketCapAtTxUsd,
      marketCapAtTxEstimated,
      marketCapAtTxSource,
      source: preferredSource ?? 'okx',
    };
  }

  // GMGN fills gaps when DexScreener/OKX have no image (and covers multi-chain).
  // Skip entirely when in cooldown to avoid blocking the batch.
  if (gmgnAllowed) {
    const fromGmgn = await fetchGmgnTokenInfo(chain, tokenAddress);
    if (fromGmgn?.logoUrl) {
      return {
        logoUrl: fromGmgn.logoUrl,
        marketCapUsd: currentMarketCapUsd ?? fromGmgn.marketCapUsd,
        liquidityUsd,
        priceUsd: currentPriceUsd,
        marketCapAtTxUsd,
        marketCapAtTxEstimated,
        marketCapAtTxSource,
        source: preferredSource ?? 'gmgn',
      };
    }
    return {
      logoUrl: null,
      marketCapUsd: currentMarketCapUsd ?? fromGmgn?.marketCapUsd ?? null,
      liquidityUsd,
      priceUsd: currentPriceUsd,
      marketCapAtTxUsd,
      marketCapAtTxEstimated,
      marketCapAtTxSource,
      source: preferredSource,
    };
  }

  return {
    logoUrl: null,
    marketCapUsd: currentMarketCapUsd,
    liquidityUsd,
    priceUsd: currentPriceUsd,
    marketCapAtTxUsd,
    marketCapAtTxEstimated,
    marketCapAtTxSource,
    source: preferredSource,
  };
}
