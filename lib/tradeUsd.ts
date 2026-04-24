import { fetchOkxTokenHistoricalPriceBeforeTimestamp } from '@/lib/okx';

const STABLE_SYMBOLS = new Set(['USDT', 'USDC', 'DAI']);

const WRAPPED_NATIVE_BY_CHAIN: Record<string, { address: string; symbols: Set<string> }> = {
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
  chain?: string | null;
  token?: string | null;
  value?: string | number | null;
  quoteToken?: string | null;
  quoteAmount?: string | number | null;
  explicitPriceUsd?: number | null;
  txTimestampMs: number;
}

export interface ResolveTradeAmountUsdAtTxDeps {
  fetchHistoricalTokenPrice?: typeof fetchOkxTokenHistoricalPriceBeforeTimestamp;
}

function normalizeSymbol(symbol: string | null | undefined) {
  return (symbol || '').trim().toUpperCase();
}

function parsePositiveFiniteNumber(value: string | number | null | undefined) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const parsed = Number.parseFloat(value.trim().replaceAll(',', ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function roundUsd(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export async function resolveTradeAmountUsdAtTx(
  params: ResolveTradeAmountUsdAtTxParams,
  deps: ResolveTradeAmountUsdAtTxDeps = {}
) {
  const chain = (params.chain || '').trim().toLowerCase();
  const quoteTokenSymbol = normalizeSymbol(params.quoteToken);
  const tokenSymbol = normalizeSymbol(params.token);
  const quoteAmount = parsePositiveFiniteNumber(params.quoteAmount);
  const tokenAmount = parsePositiveFiniteNumber(params.value);
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

  const wrappedNative = chain && quoteTokenSymbol ? WRAPPED_NATIVE_BY_CHAIN[chain]?.symbols.has(quoteTokenSymbol) : false;

  if (chain && wrappedNative && quoteAmount !== null) {
    const wrappedNativeAddress = WRAPPED_NATIVE_BY_CHAIN[chain]?.address;
    const fetchHistoricalTokenPrice = deps.fetchHistoricalTokenPrice ?? fetchOkxTokenHistoricalPriceBeforeTimestamp;

    if (wrappedNativeAddress) {
      const pricePoint = await fetchHistoricalTokenPrice(chain, wrappedNativeAddress, params.txTimestampMs);

      if (typeof pricePoint?.priceUsd === 'number' && Number.isFinite(pricePoint.priceUsd) && pricePoint.priceUsd > 0) {
        return roundUsd(quoteAmount * pricePoint.priceUsd);
      }
    }
  }

  return null;
}
