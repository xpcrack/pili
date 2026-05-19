import { fetchOkxMarketUsdPrice } from '@/lib/okx';
import type { Activity } from '@/types';

export type FilterDecision = 'visible' | 'hidden' | 'pending';
export type FilterReasonCode = 'meets_min_usd' | 'below_min_usd' | 'pending_valuation';

export interface FilterEngineConfig {
  minUsdValue: number;
}

export interface FilterVerdict {
  decision: FilterDecision;
  reasonCode: FilterReasonCode;
  reasonText: string;
  computedUsdValue: number | null;
}

const DEFAULT_MIN_USD_VALUE = 5;
const STABLE_SYMBOLS = new Set(['USDT', 'USDC']);
const NATIVE_SYMBOLS = new Set(['SOL', 'WSOL', 'BNB', 'WBNB']);

function normalizeSymbol(symbol: string | undefined) {
  return (symbol || '').trim().toUpperCase();
}

function parsePositiveAmount(value: string | undefined) {
  const parsed = Number.parseFloat((value || '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function toRoundedUsd(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isStableSymbol(symbol: string | undefined) {
  return STABLE_SYMBOLS.has(normalizeSymbol(symbol));
}

function isNativeSymbol(symbol: string | undefined) {
  return NATIVE_SYMBOLS.has(normalizeSymbol(symbol));
}

export function getDefaultFilterEngineConfig(): FilterEngineConfig {
  const parsed = Number.parseFloat(process.env.CHAIN_ACTIVITY_MIN_USD_VALUE || '');
  return {
    minUsdValue: Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIN_USD_VALUE,
  };
}

async function computeActivityUsdValue(activity: Activity) {
  const quoteToken = normalizeSymbol(activity.metadata.quoteToken);
  const token = normalizeSymbol(activity.metadata.token);
  const quoteAmount = parsePositiveAmount(activity.metadata.quoteAmount);
  const tokenAmount = parsePositiveAmount(activity.metadata.value);

  if (quoteToken && quoteAmount !== null && isStableSymbol(quoteToken)) {
    return toRoundedUsd(quoteAmount);
  }

  if (token && tokenAmount !== null && isStableSymbol(token)) {
    return toRoundedUsd(tokenAmount);
  }

  if (quoteToken && quoteAmount !== null && isNativeSymbol(quoteToken)) {
    const nativePrice = await fetchOkxMarketUsdPrice(quoteToken);
    if (nativePrice !== null) {
      return toRoundedUsd(quoteAmount * nativePrice);
    }
  }

  if (token && tokenAmount !== null && isNativeSymbol(token)) {
    const nativePrice = await fetchOkxMarketUsdPrice(token);
    if (nativePrice !== null) {
      return toRoundedUsd(tokenAmount * nativePrice);
    }
  }

  return null;
}

export async function evaluateActivityForFeed(
  activity: Activity,
  config: FilterEngineConfig = getDefaultFilterEngineConfig()
): Promise<FilterVerdict> {
  const computedUsdValue = await computeActivityUsdValue(activity);

  if (computedUsdValue === null) {
    return {
      decision: 'pending',
      reasonCode: 'pending_valuation',
      reasonText: '无法可靠换算 USD，已移出主 feed 并标记待判定',
      computedUsdValue: null,
    };
  }

  if (computedUsdValue < config.minUsdValue) {
    return {
      decision: 'hidden',
      reasonCode: 'below_min_usd',
      reasonText: `链上交易估值低于 ${config.minUsdValue}U，已从主 feed 隐藏`,
      computedUsdValue,
    };
  }

  return {
    decision: 'visible',
    reasonCode: 'meets_min_usd',
    reasonText: `链上交易估值达到 ${config.minUsdValue}U，保留展示`,
    computedUsdValue,
  };
}
