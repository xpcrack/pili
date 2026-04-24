import { fetchOkxTokenHistoricalPriceBeforeTimestamp } from '@/lib/okx';
import type { ChainType } from '@/types';

const STABLE_SYMBOLS = new Set(['USDT', 'USDC', 'DAI']);

const WRAPPED_NATIVE_BY_CHAIN: Partial<Record<ChainType, { address: string; symbols: Set<string> }>> = {
  bsc: {
    address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    symbols: new Set(['BNB', 'WBNB']),
  },
  solana: {
    address: 'So11111111111111111111111111111111111111112',
    symbols: new Set(['SOL', 'WSOL']),
  },
};

export interface ResolveTradeAmountUsdAtTxParams {
  chain?: ChainType | null;
  tokenSymbol?: string | null;
  tokenAmount?: number | null;
  quoteTokenSymbol?: string | null;
  quoteAmount?: number | null;
  explicitPriceUsd?: number | null;
  txTimestampMs: number;
}

export interface ResolveTradeAmountUsdAtTxDeps {
  fetchHistoricalPriceBeforeTimestamp?: typeof fetchOkxTokenHistoricalPriceBeforeTimestamp;
}

function normalizeSymbol(symbol: string | null | undefined) {
  return (symbol || '').trim().toUpperCase();
}

function parsePositiveFiniteNumber(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function roundUsd(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export async function resolveTradeAmountUsdAtTx(
  params: ResolveTradeAmountUsdAtTxParams,
  deps: ResolveTradeAmountUsdAtTxDeps = {}
) {
  const quoteTokenSymbol = normalizeSymbol(params.quoteTokenSymbol);
  const tokenSymbol = normalizeSymbol(params.tokenSymbol);
  const quoteAmount = parsePositiveFiniteNumber(params.quoteAmount);
  const tokenAmount = parsePositiveFiniteNumber(params.tokenAmount);
  const explicitPriceUsd = parsePositiveFiniteNumber(params.explicitPriceUsd);

  if (quoteTokenSymbol && quoteAmount !== null && STABLE_SYMBOLS.has(quoteTokenSymbol)) {
    return roundUsd(quoteAmount);
  }

  if (tokenSymbol && tokenAmount !== null && STABLE_SYMBOLS.has(tokenSymbol)) {
    return roundUsd(tokenAmount);
  }

  if (explicitPriceUsd !== null && tokenAmount !== null) {
    return roundUsd(tokenAmount * explicitPriceUsd);
  }

  const wrappedNative =
    params.chain && quoteTokenSymbol ? WRAPPED_NATIVE_BY_CHAIN[params.chain]?.symbols.has(quoteTokenSymbol) : false;

  if (params.chain && wrappedNative && quoteAmount !== null) {
    const wrappedNativeAddress = WRAPPED_NATIVE_BY_CHAIN[params.chain]?.address;
    const fetchHistoricalPriceBeforeTimestamp =
      deps.fetchHistoricalPriceBeforeTimestamp ?? fetchOkxTokenHistoricalPriceBeforeTimestamp;

    if (wrappedNativeAddress) {
      const pricePoint = await fetchHistoricalPriceBeforeTimestamp(
        params.chain,
        wrappedNativeAddress,
        params.txTimestampMs
      );

      if (typeof pricePoint?.priceUsd === 'number' && Number.isFinite(pricePoint.priceUsd) && pricePoint.priceUsd > 0) {
        return roundUsd(quoteAmount * pricePoint.priceUsd);
      }
    }
  }

  return null;
}
