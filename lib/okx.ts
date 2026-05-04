import crypto from 'node:crypto';

import type { ChainType } from '@/types';

const OKX_API_BASE = 'https://web3.okx.com';
const OKX_MARKET_API_BASE = 'https://www.okx.com';
const OKX_REQUEST_INTERVAL_MS = 250;
const OKX_MAX_CONCURRENT_REQUESTS = 4;
const OKX_REQUEST_TIMEOUT_MS = 8000;
const OKX_MARKET_PRICE_CACHE_TTL_MS = 60 * 1000;

const endpointNextAvailableAt = new Map<string, number>();
const endpointInFlight = new Map<string, number>();
const marketPriceCache = new Map<string, { value: number | null; expiresAt: number }>();
const marketPriceInFlight = new Map<string, Promise<number | null>>();

export const CHAIN_TO_OKX_INDEX: Record<string, string> = {
  bsc: '56',
  ethereum: '1',
  base: '8453',
  solana: '501',
};

export function isSupportedOkxChain(chain: string) {
  return Boolean(CHAIN_TO_OKX_INDEX[chain]);
}

export interface OkxTransaction {
  chainIndex?: string;
  txHash?: string;
  itype?: string;
  iType?: string;
  methodId?: string;
  nonce?: string;
  txTime?: string;
  from?: Array<{ address: string; amount: string }>;
  to?: Array<{ address: string; amount: string }>;
  tokenAddress?: string;
  tokenContractAddress?: string;
  amount?: string;
  symbol?: string;
  txFee?: string;
  txStatus?: string;
  hitBlacklist?: boolean;
  tag?: string;
}

export interface OkxTransactionDetailTokenTransfer {
  from?: string;
  to?: string;
  tokenContractAddress?: string;
  symbol?: string;
  amount?: string;
}

export interface OkxTransactionDetailInternalTransfer {
  from?: string;
  to?: string;
  amount?: string;
  txStatus?: string;
}

export interface OkxTransactionDetail {
  chainIndex?: string;
  txhash?: string;
  txHash?: string;
  txStatus?: string;
  symbol?: string;
  amount?: string;
  fromDetails?: Array<{ address?: string; amount?: string }>;
  toDetails?: Array<{ address?: string; amount?: string }>;
  tokenTransferDetails?: OkxTransactionDetailTokenTransfer[];
  internalTransactionDetails?: OkxTransactionDetailInternalTransfer[];
}

interface OkxPayload {
  code?: string;
  msg?: string;
  data?: Array<{
    transactionList?: OkxTransaction[];
    transactions?: OkxTransaction[];
  }>;
  transactions?: OkxTransaction[];
}

interface OkxTotalValuePayload {
  code?: string;
  msg?: string;
  data?: Array<{
    totalValue?: string;
    totalAssetUsd?: string;
    totalAssetValue?: string;
  }>;
}

interface OkxAddressAssetPayload {
  tokenContractAddress?: string;
  tokenAddress?: string;
  tokenAddr?: string;
  contractAddress?: string;
  contractAddr?: string;
  tokenContract?: string;
  tokenContractAddr?: string;
  symbol?: string;
  tokenSymbol?: string;
  tokenName?: string;
  balance?: string;
  tokenPrice?: string;
  price?: string;
  valueUsd?: string;
  assetValue?: string;
  totalValue?: string;
  holdAmountUsd?: string;
}

interface OkxAddressAssetDetailsPayload {
  code?: string;
  msg?: string;
  data?: Array<{
    tokenAssets?: OkxAddressAssetPayload[];
  }>;
}

interface OkxTransactionDetailPayload {
  code?: string;
  msg?: string;
  data?: OkxTransactionDetail[];
}

interface OkxMarketTickerPayload {
  code?: string;
  msg?: string;
  data?: Array<{
    instId?: string;
    last?: string;
  }>;
}

interface OkxTokenSearchItem {
  tokenLogoUrl?: string;
}

interface OkxTokenSearchPayload {
  code?: string;
  msg?: string;
  data?: OkxTokenSearchItem[];
}

interface OkxHistoricalCandlesPayload {
  code?: string;
  msg?: string;
  data?: Array<[string, string, string, string, string, string, string, string]>;
}

const OKX_CANDLE_BAR_MS = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1H': 60 * 60_000,
  '4H': 4 * 60 * 60_000,
  '1D': 24 * 60 * 60_000,
} as const;

type OkxCandleBar = keyof typeof OKX_CANDLE_BAR_MS;

const OKX_CANDLE_BAR_FALLBACK_ORDER: OkxCandleBar[] = ['1m', '5m', '15m', '1H', '4H', '1D'];

export interface OkxHistoricalPricePoint {
  priceUsd: number;
  candleTimestampMs: number;
  bar: OkxCandleBar;
}

export interface OkxAddressAssetDetail {
  userId?: string;
  address: string;
  chain: ChainType;
  assetKey: string;
  tokenAddress: string;
  symbol: string;
  name: string | null;
  balance: number;
  priceUsd: number;
  valueUsd: number;
}

const OKX_NATIVE_TOKEN_ADDRESS_MAP: Record<ChainType, Record<string, string>> = {
  bsc: {
    BNB: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    WBNB: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  },
  ethereum: {
    ETH: '0xc02aa39b223fe8d0a0e5c4f27ead9083c756cc2',
    WETH: '0xc02aa39b223fe8d0a0e5c4f27ead9083c756cc2',
  },
  base: {
    ETH: '0x4200000000000000000000000000000000000006',
    WETH: '0x4200000000000000000000000000000000000006',
  },
  solana: {
    SOL: 'So11111111111111111111111111111111111111112',
    WSOL: 'So11111111111111111111111111111111111111112',
  },
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithEndpointRateLimit<T>(endpointKey: string, task: () => Promise<T>) {
  while (true) {
    const inFlight = endpointInFlight.get(endpointKey) ?? 0;
    const waitMs = Math.max(0, (endpointNextAvailableAt.get(endpointKey) ?? 0) - Date.now());

    if (inFlight < OKX_MAX_CONCURRENT_REQUESTS && waitMs <= 0) {
      endpointInFlight.set(endpointKey, inFlight + 1);
      endpointNextAvailableAt.set(endpointKey, Date.now() + OKX_REQUEST_INTERVAL_MS);
      break;
    }

    await sleep(waitMs > 0 ? waitMs : 25);
  }

  try {
    return await task();
  } finally {
    const inFlight = endpointInFlight.get(endpointKey) ?? 0;
    endpointInFlight.set(endpointKey, Math.max(0, inFlight - 1));
  }
}

function getOkxCredentials() {
  const apiKey = process.env.OKX_API_KEY?.trim();
  const secretKey = process.env.OKX_SECRET_KEY?.trim();
  const passphrase = process.env.OKX_API_PASSPHRASE?.trim();

  return {
    apiKey,
    secretKey,
    passphrase,
    configured: Boolean(apiKey && secretKey && passphrase),
  };
}

function createOkxHeaders(requestPathWithQuery: string) {
  const credentials = getOkxCredentials();

  if (!credentials.configured) {
    return null;
  }

  const timestamp = new Date().toISOString();
  const prehash = `${timestamp}GET${requestPathWithQuery}`;
  const sign = crypto
    .createHmac('sha256', credentials.secretKey as string)
    .update(prehash)
    .digest('base64');

  return {
    'Content-Type': 'application/json',
    'OK-ACCESS-KEY': credentials.apiKey as string,
    'OK-ACCESS-SIGN': sign,
    'OK-ACCESS-PASSPHRASE': credentials.passphrase as string,
    'OK-ACCESS-TIMESTAMP': timestamp,
  };
}

function extractTransactions(payload: unknown): OkxTransaction[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const okxPayload = payload as OkxPayload;

  if (Array.isArray(okxPayload.data)) {
    const first = okxPayload.data[0];

    if (Array.isArray(first?.transactionList)) {
      return first.transactionList;
    }

    if (Array.isArray(first?.transactions)) {
      return first.transactions;
    }
  }

  if (Array.isArray(okxPayload.transactions)) {
    return okxPayload.transactions;
  }

  return [];
}

export function getOkxConfigStatus() {
  return getOkxCredentials();
}

function parseOkxMarketPrice(payload: OkxMarketTickerPayload) {
  const last = payload.data?.[0]?.last;
  const parsed = typeof last === 'string' ? Number.parseFloat(last) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getMarketTickerInstId(symbol: string) {
  const normalized = symbol.trim().toUpperCase();
  if (normalized === 'SOL' || normalized === 'WSOL') {
    return 'SOL-USDT';
  }
  if (normalized === 'BNB' || normalized === 'WBNB') {
    return 'BNB-USDT';
  }
  return null;
}

export async function fetchOkxMarketUsdPrice(symbol: string) {
  const instId = getMarketTickerInstId(symbol);
  if (!instId) {
    return null;
  }

  const cached = marketPriceCache.get(instId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const existingTask = marketPriceInFlight.get(instId);
  if (existingTask) {
    return existingTask;
  }

  const task = (async () => {
    const requestPathWithQuery = `/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`;

    let response: Response;
    try {
      response = await runWithEndpointRateLimit('market-ticker', () => {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, OKX_REQUEST_TIMEOUT_MS);

        return fetch(`${OKX_MARKET_API_BASE}${requestPathWithQuery}`, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
        }).finally(() => {
          clearTimeout(timer);
        });
      });
    } catch {
      return null;
    }

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as OkxMarketTickerPayload;
    if (payload.code && payload.code !== '0') {
      return null;
    }

    return parseOkxMarketPrice(payload);
  })()
    .catch(() => null)
    .finally(() => {
      marketPriceInFlight.delete(instId);
    });

  marketPriceInFlight.set(instId, task);
  const value = await task;
  marketPriceCache.set(instId, {
    value,
    expiresAt: Date.now() + OKX_MARKET_PRICE_CACHE_TTL_MS,
  });
  return value;
}

function sanitizeTokenLogoUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

function parseHistoricalCandlePoint(
  row: [string, string, string, string, string, string, string, string] | undefined,
  bar: OkxCandleBar
): OkxHistoricalPricePoint | null {
  if (!Array.isArray(row) || row.length < 5) {
    return null;
  }

  const timestampMs = Number.parseInt(row[0], 10);
  const closePrice = Number.parseFloat(row[4]);

  if (!Number.isFinite(timestampMs) || !Number.isFinite(closePrice) || closePrice <= 0) {
    return null;
  }

  return {
    priceUsd: closePrice,
    candleTimestampMs: timestampMs,
    bar,
  };
}

async function fetchOkxHistoricalCandlePrice(
  chain: string,
  tokenAddress: string,
  timestampMs: number,
  bar: OkxCandleBar
) {
  const chainIndex = CHAIN_TO_OKX_INDEX[chain];
  if (!chainIndex) {
    return null;
  }

  const normalizedAddress = tokenAddress.trim();
  if (!normalizedAddress) {
    return null;
  }

  const normalizedTimestamp = Number.isFinite(timestampMs) ? Math.floor(timestampMs) : NaN;
  if (!Number.isFinite(normalizedTimestamp) || normalizedTimestamp <= 0) {
    return null;
  }

  const params = new URLSearchParams({
    chainIndex,
    tokenContractAddress: normalizedAddress,
    bar,
    before: String(normalizedTimestamp + OKX_CANDLE_BAR_MS[bar]),
    limit: '1',
  });
  const requestPathWithQuery = `/api/v6/dex/market/historical-candles?${params.toString()}`;
  const headers = createOkxHeaders(requestPathWithQuery);

  if (!headers) {
    return null;
  }

  let response: Response;
  try {
    response = await runWithEndpointRateLimit('market-historical-candles', () => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, OKX_REQUEST_TIMEOUT_MS);

      return fetch(`${OKX_API_BASE}${requestPathWithQuery}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
        signal: controller.signal,
      }).finally(() => {
        clearTimeout(timer);
      });
    });
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as OkxHistoricalCandlesPayload;
  if (payload.code && payload.code !== '0') {
    return null;
  }

  return parseHistoricalCandlePoint(payload.data?.[0], bar);
}

export async function fetchOkxTokenHistoricalPriceBeforeTimestamp(
  chain: string,
  tokenAddress: string,
  timestampMs: number
) {
  for (const bar of OKX_CANDLE_BAR_FALLBACK_ORDER) {
    const point = await fetchOkxHistoricalCandlePrice(chain, tokenAddress, timestampMs, bar);
    if (point) {
      return point;
    }
  }

  return null;
}

export async function fetchOkxTokenLogoByContract(chain: string, tokenAddress: string, tokenSymbol?: string) {
  const chainIndex = CHAIN_TO_OKX_INDEX[chain];
  if (!chainIndex) {
    return null;
  }

  const normalizedAddress = tokenAddress.trim();
  if (!normalizedAddress) {
    return null;
  }

  const params = new URLSearchParams({
    // OKX token search now requires `chains` + `search`.
    chains: chainIndex,
    search: normalizedAddress,
  });
  const requestPathWithQuery = `/api/v5/dex/market/token/search?${params.toString()}`;
  const headers = createOkxHeaders(requestPathWithQuery);
  if (!headers) {
    return null;
  }

  try {
    const response = await runWithEndpointRateLimit('market-token-search', () => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, OKX_REQUEST_TIMEOUT_MS);

      return fetch(`${OKX_API_BASE}${requestPathWithQuery}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
        signal: controller.signal,
      }).finally(() => {
        clearTimeout(timer);
      });
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as OkxTokenSearchPayload;
    if (payload.code && payload.code !== '0') {
      return null;
    }

    const exact = payload.data?.find((item) => sanitizeTokenLogoUrl(item.tokenLogoUrl));
    const exactLogo = sanitizeTokenLogoUrl(exact?.tokenLogoUrl);
    if (exactLogo) {
      return exactLogo;
    }
  } catch {
    // ignore and fallback
  }

  if (tokenSymbol && tokenSymbol.trim()) {
    const symbolQuery = tokenSymbol.trim().toUpperCase();
    const paramsBySymbol = new URLSearchParams({
      chains: chainIndex,
      search: symbolQuery,
    });
    const requestPathBySymbol = `/api/v5/dex/market/token/search?${paramsBySymbol.toString()}`;
    const headersBySymbol = createOkxHeaders(requestPathBySymbol);
    if (!headersBySymbol) {
      return null;
    }

    try {
      const response = await runWithEndpointRateLimit('market-token-search', () => {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, OKX_REQUEST_TIMEOUT_MS);

        return fetch(`${OKX_API_BASE}${requestPathBySymbol}`, {
          method: 'GET',
          headers: headersBySymbol,
          cache: 'no-store',
          signal: controller.signal,
        }).finally(() => {
          clearTimeout(timer);
        });
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as OkxTokenSearchPayload;
      if (payload.code && payload.code !== '0') {
        return null;
      }
      return sanitizeTokenLogoUrl(payload.data?.[0]?.tokenLogoUrl);
    } catch {
      return null;
    }
  }

  return null;
}

export async function fetchOkxTransactionsByAddress(
  address: string,
  chain: string,
  options?: { beginMs?: number; endMs?: number }
) {
  const chainIndex = CHAIN_TO_OKX_INDEX[chain];

  if (!chainIndex) {
    return {
      ok: false,
      configured: getOkxCredentials().configured,
      transactions: [] as OkxTransaction[],
      error: `暂不支持 ${chain}，当前仅支持 BSC / Ethereum / Base / Solana`,
    };
  }

  const now = Date.now();
  const defaultBegin = now - 72 * 60 * 60 * 1000;
  const beginMs = typeof options?.beginMs === 'number' ? Math.max(0, Math.floor(options.beginMs)) : defaultBegin;
  const endMs = typeof options?.endMs === 'number' ? Math.max(beginMs, Math.floor(options.endMs)) : now;

  const params = new URLSearchParams({
    address,
    chains: chainIndex,
    begin: beginMs.toString(),
    end: endMs.toString(),
    limit: '100',
  });

  const requestPathWithQuery = `/api/v6/dex/post-transaction/transactions-by-address?${params}`;
  const headers = createOkxHeaders(requestPathWithQuery);

  if (!headers) {
    return {
      ok: false,
      configured: false,
      transactions: [] as OkxTransaction[],
      error: '未配置 OKX API 凭证',
    };
  }

  let response: Response;
  try {
    response = await runWithEndpointRateLimit('transactions-by-address', () =>
      {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, OKX_REQUEST_TIMEOUT_MS);

        return fetch(`${OKX_API_BASE}${requestPathWithQuery}`, {
          method: 'GET',
          headers,
          cache: 'no-store',
          signal: controller.signal,
        }).finally(() => {
          clearTimeout(timer);
        });
      }
    );
  } catch (error) {
    return {
      ok: false,
      configured: true,
      transactions: [] as OkxTransaction[],
      error: `OKX 网络错误: ${
        error instanceof Error && error.name === 'AbortError'
          ? `请求超时（>${OKX_REQUEST_TIMEOUT_MS}ms）`
          : error instanceof Error
            ? error.message
            : '未知网络异常'
      }`,
    };
  }

  if (!response.ok) {
    const errorText = await response.text();

    return {
      ok: false,
      configured: true,
      transactions: [] as OkxTransaction[],
      error: `OKX API ${response.status}: ${errorText.slice(0, 120)}`,
    };
  }

  const payload = (await response.json()) as OkxPayload;

  if (payload.code && payload.code !== '0') {
    return {
      ok: false,
      configured: true,
      transactions: [] as OkxTransaction[],
      error: `OKX API 业务错误 ${payload.code}: ${payload.msg || '未知错误'}`,
    };
  }

  return {
    ok: true,
    configured: true,
    transactions: extractTransactions(payload),
    error: null,
  };
}

export async function fetchOkxTransactionDetailByTxHash(txHash: string, chain: string) {
  const chainIndex = CHAIN_TO_OKX_INDEX[chain];

  if (!chainIndex) {
    return {
      ok: false,
      configured: getOkxCredentials().configured,
      detail: null as OkxTransactionDetail | null,
      error: `暂不支持 ${chain}，当前仅支持 BSC / Ethereum / Base / Solana`,
    };
  }

  const params = new URLSearchParams({
    txHash,
    chainIndex,
  });
  const requestPathWithQuery = `/api/v6/dex/post-transaction/transaction-detail-by-txhash?${params}`;
  const headers = createOkxHeaders(requestPathWithQuery);

  if (!headers) {
    return {
      ok: false,
      configured: false,
      detail: null as OkxTransactionDetail | null,
      error: '未配置 OKX API 凭证',
    };
  }

  let response: Response;
  try {
    response = await runWithEndpointRateLimit('transaction-detail-by-txhash', () => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, OKX_REQUEST_TIMEOUT_MS);

      return fetch(`${OKX_API_BASE}${requestPathWithQuery}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
        signal: controller.signal,
      }).finally(() => {
        clearTimeout(timer);
      });
    });
  } catch (error) {
    return {
      ok: false,
      configured: true,
      detail: null as OkxTransactionDetail | null,
      error: `OKX 网络错误: ${
        error instanceof Error && error.name === 'AbortError'
          ? `请求超时（>${OKX_REQUEST_TIMEOUT_MS}ms）`
          : error instanceof Error
            ? error.message
            : '未知网络异常'
      }`,
    };
  }

  if (!response.ok) {
    const errorText = await response.text();
    return {
      ok: false,
      configured: true,
      detail: null as OkxTransactionDetail | null,
      error: `OKX API ${response.status}: ${errorText.slice(0, 120)}`,
    };
  }

  const payload = (await response.json()) as OkxTransactionDetailPayload;

  if (payload.code && payload.code !== '0') {
    return {
      ok: false,
      configured: true,
      detail: null as OkxTransactionDetail | null,
      error: `OKX API 业务错误 ${payload.code}: ${payload.msg || '未知错误'}`,
    };
  }

  return {
    ok: true,
    configured: true,
    detail: Array.isArray(payload.data) && payload.data.length > 0 ? payload.data[0] : null,
    error: null as string | null,
  };
}

function parseTotalAssetUsd(payload: OkxTotalValuePayload): number | null {
  if (!Array.isArray(payload.data) || payload.data.length === 0) {
    return 0;
  }

  const first = payload.data[0];
  const rawValue = first.totalAssetUsd ?? first.totalAssetValue ?? first.totalValue ?? '0';
  const parsed = Number.parseFloat(rawValue);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOkxNumber(value: unknown) {
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

function normalizeOkxAssetTokenAddress(chain: ChainType, asset: OkxAddressAssetPayload) {
  const rawAddress =
    asset.tokenAddress ??
    asset.tokenContractAddress ??
    asset.tokenAddr ??
    asset.contractAddress ??
    asset.contractAddr ??
    asset.tokenContract ??
    asset.tokenContractAddr ??
    null;

  if (typeof rawAddress === 'string' && rawAddress.trim()) {
    const trimmed = rawAddress.trim();
    return chain === 'solana' ? trimmed : trimmed.toLowerCase();
  }

  const symbol = (asset.symbol || asset.tokenSymbol || '').trim().toUpperCase();
  const nativeMappedAddress = OKX_NATIVE_TOKEN_ADDRESS_MAP[chain]?.[symbol];
  if (nativeMappedAddress) {
    return nativeMappedAddress;
  }

  return symbol ? `native:${chain}:${symbol.toLowerCase()}` : null;
}

function buildOkxAddressAssetDetail(
  address: string,
  chain: ChainType,
  asset: OkxAddressAssetPayload
): OkxAddressAssetDetail | null {
  const tokenAddress = normalizeOkxAssetTokenAddress(chain, asset);
  if (!tokenAddress) {
    return null;
  }

  const symbol = (asset.symbol || asset.tokenSymbol || '').trim() || 'UNKNOWN';
  const balance = parseOkxNumber(asset.balance) ?? 0;
  const priceUsd = parseOkxNumber(asset.tokenPrice ?? asset.price) ?? 0;
  const valueUsd =
    parseOkxNumber(asset.valueUsd ?? asset.assetValue ?? asset.totalValue ?? asset.holdAmountUsd) ??
    balance * priceUsd;

  if (!Number.isFinite(valueUsd) || valueUsd <= 0) {
    return null;
  }

  return {
    address,
    chain,
    assetKey: `${chain}:${chain === 'solana' ? tokenAddress : tokenAddress.toLowerCase()}`,
    tokenAddress,
    symbol,
    name: typeof asset.tokenName === 'string' && asset.tokenName.trim() ? asset.tokenName.trim() : null,
    balance: Number.isFinite(balance) && balance > 0 ? balance : 0,
    priceUsd: Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : 0,
    valueUsd,
  };
}

export async function fetchOkxTotalValueByAddress(address: string, chain: string) {
  const chainIndex = CHAIN_TO_OKX_INDEX[chain];

  if (!chainIndex) {
    return {
      ok: false,
      configured: getOkxCredentials().configured,
      totalAssetUsd: null as number | null,
      error: `暂不支持 ${chain}，当前仅支持 BSC / Ethereum / Base / Solana`,
    };
  }

  const params = new URLSearchParams({
    address,
    chains: chainIndex,
  });
  const requestPathWithQuery = `/api/v5/dex/balance/total-value-by-address?${params}`;
  const headers = createOkxHeaders(requestPathWithQuery);

  if (!headers) {
    return {
      ok: false,
      configured: false,
      totalAssetUsd: null as number | null,
      error: '未配置 OKX API 凭证',
    };
  }

  let response: Response;
  try {
    response = await runWithEndpointRateLimit('total-value-by-address', () => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, OKX_REQUEST_TIMEOUT_MS);

      return fetch(`${OKX_API_BASE}${requestPathWithQuery}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
        signal: controller.signal,
      }).finally(() => {
        clearTimeout(timer);
      });
    });
  } catch (error) {
    return {
      ok: false,
      configured: true,
      totalAssetUsd: null as number | null,
      error: `OKX 网络错误: ${
        error instanceof Error && error.name === 'AbortError'
          ? `请求超时（>${OKX_REQUEST_TIMEOUT_MS}ms）`
          : error instanceof Error
            ? error.message
            : '未知网络异常'
      }`,
    };
  }

  if (!response.ok) {
    const errorText = await response.text();
    return {
      ok: false,
      configured: true,
      totalAssetUsd: null as number | null,
      error: `OKX API ${response.status}: ${errorText.slice(0, 120)}`,
    };
  }

  const payload = (await response.json()) as OkxTotalValuePayload;

  if (payload.code && payload.code !== '0') {
    return {
      ok: false,
      configured: true,
      totalAssetUsd: null as number | null,
      error: `OKX API 业务错误 ${payload.code}: ${payload.msg || '未知错误'}`,
    };
  }

  const totalAssetUsd = parseTotalAssetUsd(payload);
  if (totalAssetUsd === null) {
    return {
      ok: false,
      configured: true,
      totalAssetUsd: null as number | null,
      error: 'OKX 返回资产数值无法解析',
    };
  }

  return {
    ok: true,
    configured: true,
    totalAssetUsd,
    error: null as string | null,
  };
}

export async function fetchOkxAddressAssetDetails(address: string, chain: ChainType) {
  const chainIndex = CHAIN_TO_OKX_INDEX[chain];
  if (!chainIndex) {
    return {
      ok: false,
      configured: getOkxCredentials().configured,
      totalAssetUsd: null as number | null,
      assets: [] as OkxAddressAssetDetail[],
      error: `暂不支持 ${chain}，当前仅支持 BSC / Ethereum / Base / Solana`,
    };
  }

  const params = new URLSearchParams({
    address,
    chains: chainIndex,
  });
  const requestPathWithQuery = `/api/v6/dex/balance/all-token-balances-by-address?${params.toString()}`;
  const headers = createOkxHeaders(requestPathWithQuery);

  if (!headers) {
    return {
      ok: false,
      configured: false,
      totalAssetUsd: null as number | null,
      assets: [] as OkxAddressAssetDetail[],
      error: '未配置 OKX API 凭证',
    };
  }

  let response: Response;
  try {
    response = await runWithEndpointRateLimit('all-token-balances-by-address', () => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, OKX_REQUEST_TIMEOUT_MS);

      return fetch(`${OKX_API_BASE}${requestPathWithQuery}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
        signal: controller.signal,
      }).finally(() => {
        clearTimeout(timer);
      });
    });
  } catch (error) {
    return {
      ok: false,
      configured: true,
      totalAssetUsd: null as number | null,
      assets: [] as OkxAddressAssetDetail[],
      error: `OKX 网络错误: ${
        error instanceof Error && error.name === 'AbortError'
          ? `请求超时（>${OKX_REQUEST_TIMEOUT_MS}ms）`
          : error instanceof Error
            ? error.message
            : '未知网络异常'
      }`,
    };
  }

  if (!response.ok) {
    const errorText = await response.text();
    return {
      ok: false,
      configured: true,
      totalAssetUsd: null as number | null,
      assets: [] as OkxAddressAssetDetail[],
      error: `OKX API ${response.status}: ${errorText.slice(0, 120)}`,
    };
  }

  const payload = (await response.json()) as OkxAddressAssetDetailsPayload;
  if (payload.code && payload.code !== '0') {
    return {
      ok: false,
      configured: true,
      totalAssetUsd: null as number | null,
      assets: [] as OkxAddressAssetDetail[],
      error: `OKX API 业务错误 ${payload.code}: ${payload.msg || '未知错误'}`,
    };
  }

  const assets = (payload.data || [])
    .flatMap((row) => row.tokenAssets || [])
    .map((asset) => buildOkxAddressAssetDetail(address, chain, asset))
    .filter((asset): asset is OkxAddressAssetDetail => Boolean(asset))
    .sort((left, right) => right.valueUsd - left.valueUsd || left.assetKey.localeCompare(right.assetKey));

  const totalAssetUsd = assets.reduce((sum, asset) => sum + asset.valueUsd, 0);

  return {
    ok: true,
    configured: true,
    totalAssetUsd,
    assets,
    error: null as string | null,
  };
}
