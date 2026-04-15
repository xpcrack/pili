import crypto from 'node:crypto';

const OKX_API_BASE = 'https://web3.okx.com';
const OKX_REQUEST_INTERVAL_MS = 1100;

const endpointQueue = new Map<string, Promise<void>>();
const endpointNextAvailableAt = new Map<string, number>();

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

interface OkxPayload {
  code?: string;
  msg?: string;
  data?: Array<{
    transactionList?: OkxTransaction[];
    transactions?: OkxTransaction[];
  }>;
  transactions?: OkxTransaction[];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithEndpointRateLimit<T>(endpointKey: string, task: () => Promise<T>) {
  const previousTask = endpointQueue.get(endpointKey) ?? Promise.resolve();
  let releaseCurrentTask!: () => void;
  const currentTask = new Promise<void>((resolve) => {
    releaseCurrentTask = resolve;
  });

  endpointQueue.set(
    endpointKey,
    previousTask
      .catch(() => undefined)
      .then(() => currentTask)
  );

  await previousTask.catch(() => undefined);

  const waitMs = Math.max(0, (endpointNextAvailableAt.get(endpointKey) ?? 0) - Date.now());

  if (waitMs > 0) {
    await sleep(waitMs);
  }

  endpointNextAvailableAt.set(endpointKey, Date.now() + OKX_REQUEST_INTERVAL_MS);

  try {
    return await task();
  } finally {
    releaseCurrentTask();
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

export async function fetchOkxTransactionsByAddress(address: string, chain: string) {
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
  const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;

  const params = new URLSearchParams({
    address,
    chains: chainIndex,
    begin: twentyFourHoursAgo.toString(),
    end: now.toString(),
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
      fetch(`${OKX_API_BASE}${requestPathWithQuery}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
      })
    );
  } catch (error) {
    return {
      ok: false,
      configured: true,
      transactions: [] as OkxTransaction[],
      error: `OKX 网络错误: ${error instanceof Error ? error.message : '未知网络异常'}`,
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
