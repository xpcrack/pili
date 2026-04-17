import crypto from 'node:crypto';

const OKX_API_BASE = 'https://web3.okx.com';
const OKX_REQUEST_INTERVAL_MS = 250;
const OKX_MAX_CONCURRENT_REQUESTS = 4;
const OKX_REQUEST_TIMEOUT_MS = 8000;

const endpointNextAvailableAt = new Map<string, number>();
const endpointInFlight = new Map<string, number>();

export const CHAIN_TO_OKX_INDEX: Record<string, string> = {
  bsc: '56',
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

interface OkxTransactionDetailPayload {
  code?: string;
  msg?: string;
  data?: OkxTransactionDetail[];
}

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
      error: `暂不支持 ${chain}，当前仅支持 BSC 和 Solana`,
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
      error: `暂不支持 ${chain}，当前仅支持 BSC 和 Solana`,
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

export async function fetchOkxTotalValueByAddress(address: string, chain: string) {
  const chainIndex = CHAIN_TO_OKX_INDEX[chain];

  if (!chainIndex) {
    return {
      ok: false,
      configured: getOkxCredentials().configured,
      totalAssetUsd: null as number | null,
      error: `暂不支持 ${chain}，当前仅支持 BSC 和 Solana`,
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
