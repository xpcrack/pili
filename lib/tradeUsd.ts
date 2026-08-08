import { fetchOkxTokenHistoricalPriceBeforeTimestamp } from '@/lib/okx';

const STABLE_SYMBOLS = new Set(['USDT', 'USDC', 'DAI']);

const WRAPPED_NATIVE_BY_CHAIN: Record<string, { address: string; symbols: Set<string>; priceChain?: string }> = {
  bsc: {
    address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    symbols: new Set(['BNB', 'WBNB']),
  },
  ethereum: {
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    symbols: new Set(['ETH', 'WETH']),
  },
  base: {
    address: '0x4200000000000000000000000000000000000006',
    symbols: new Set(['ETH', 'WETH']),
  },
  // Robinhood chain quotes ETH; OKX historical candles live on ethereum WETH.
  robinhood: {
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    symbols: new Set(['ETH', 'WETH']),
    priceChain: 'ethereum',
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

/** Shared positive amount parse (number or comma-separated string). */
export function parsePositiveFiniteNumber(value: string | number | null | undefined) {
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

/**
 * Resolve the USD amount using only fields already present in the source
 * message. This is safe for latency-sensitive ingest because it never calls
 * an external price service.
 */
export function resolveTradeAmountUsdAtTxSync(params: ResolveTradeAmountUsdAtTxParams) {
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

  return null;
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

  const nativeMeta = chain ? WRAPPED_NATIVE_BY_CHAIN[chain] : undefined;
  const isNativeQuote = Boolean(nativeMeta && quoteTokenSymbol && nativeMeta.symbols.has(quoteTokenSymbol));

  // Prefer native quote × historical price over token×explicitPrice (GMGN-aligned).
  if (isNativeQuote && quoteAmount !== null && nativeMeta) {
    const fetchHistoricalTokenPrice = deps.fetchHistoricalTokenPrice ?? fetchOkxTokenHistoricalPriceBeforeTimestamp;
    const priceLookupChain = nativeMeta.priceChain || chain;
    const pricePoint = await fetchHistoricalTokenPrice(priceLookupChain, nativeMeta.address, params.txTimestampMs);

    if (typeof pricePoint?.priceUsd === 'number' && Number.isFinite(pricePoint.priceUsd) && pricePoint.priceUsd > 0) {
      return roundUsd(quoteAmount * pricePoint.priceUsd);
    }
  }

  if (explicitPriceUsd !== null && tokenAmount !== null) {
    return roundUsd(tokenAmount * explicitPriceUsd);
  }

  return null;
}
