import { Activity, ActivityType, User, type AddressInfo } from '@/types';
import {
  fetchOkxTransactionDetailByTxHash,
  fetchOkxTransactionsByAddress,
  type OkxTransaction,
  type OkxTransactionDetail,
} from '@/lib/okx';

export interface AddressDiagnostic {
  userId: string;
  userName: string;
  address: string;
  addressName: string;
  chain: string;
  ok: boolean;
  transactionCount: number;
  error: string | null;
}

export interface ActivityFeedSummary {
  userCount: number;
  addressCount: number;
  transactionCount: number;
  successfulAddressCount: number;
  failedAddressCount: number;
  emptyAddressCount: number;
  completedAt: number;
}

export interface AddressAssetSnapshot {
  userId?: string;
  address: string;
  chain: string;
  token: string;
  tokenAddress: string;
  balance: string;
  valueUsd: number;
  totalAssetUsd: number;
  updatedAt: number;
}

export interface UserAssetSnapshot {
  userId: string;
  totalValueUsd: number;
  totalAssetUsd: number;
  updatedAt: number;
}

export interface BuildActivityFeedOptions {
  beginMs?: number;
  endMs?: number;
  requireTrackedInitiator?: boolean;
}

interface GroupedTransaction {
  txHash: string;
  entries: OkxTransaction[];
}

interface TokenFlow {
  direction: 'in' | 'out';
  symbol: string;
  tokenAddress: string;
  amount: number;
  fromAddress: string;
  toAddress: string;
  rawType: string;
  native: boolean;
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
const SOLANA_RPC_TIMEOUT_MS = 5000;
const SOLANA_NATIVE_MINTS = new Set(['so11111111111111111111111111111111111111111', 'so11111111111111111111111111111111111111112']);
const NATIVE_SYMBOLS_BY_CHAIN: Record<string, Set<string>> = {
  bsc: new Set(['bnb', 'wbnb']),
  solana: new Set(['sol', 'wsol']),
};

const solanaNetChangeCache = new Map<string, Promise<number | null>>();
const okxDetailFlowCache = new Map<string, Promise<TokenFlow[]>>();

function normalize(value: string | undefined | null) {
  return (value || '').trim().toLowerCase();
}

function parseTimestamp(tx: OkxTransaction) {
  const parsed = tx.txTime ? Number.parseInt(tx.txTime, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Date.now();
  }
  return parsed;
}

function parseAmount(value: string | undefined) {
  const parsed = Number.parseFloat((value || '').trim());
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return parsed;
}

function formatAmount(value: number) {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return value.toFixed(9).replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '');
}

function getAddresses(entries: Array<{ address: string; amount: string }> | undefined) {
  const addresses = new Set<string>();
  if (!Array.isArray(entries)) {
    return addresses;
  }
  for (const entry of entries) {
    const normalized = normalize(entry?.address);
    if (!normalized) continue;
    addresses.add(normalized);
  }
  return addresses;
}

function getSignerAddresses(tx: OkxTransaction) {
  const signers = new Set<string>();
  const candidate = tx as OkxTransaction & {
    signer?: string;
    signAddress?: string;
    signers?: Array<string | { address?: string }>;
  };

  const push = (value: string | undefined) => {
    const normalized = normalize(value);
    if (!normalized) return;
    signers.add(normalized);
  };

  push(candidate.signer);
  push(candidate.signAddress);

  if (Array.isArray(candidate.signers)) {
    for (const signer of candidate.signers) {
      if (typeof signer === 'string') {
        push(signer);
      } else {
        push(signer?.address);
      }
    }
  }

  return signers;
}

function isNativeAsset(chain: string, symbol: string, tokenAddress: string) {
  const normalizedChain = normalize(chain);
  const normalizedSymbol = normalize(symbol);
  const normalizedTokenAddress = normalize(tokenAddress);

  if (normalizedChain === 'solana' && SOLANA_NATIVE_MINTS.has(normalizedTokenAddress)) {
    return true;
  }

  return NATIVE_SYMBOLS_BY_CHAIN[normalizedChain]?.has(normalizedSymbol) ?? false;
}

function inferTxAction(params: {
  rawType: string;
  symbol: string;
  userInFrom: boolean;
  userInTo: boolean;
  tx: OkxTransaction;
}) {
  const { rawType, symbol, userInFrom, userInTo, tx } = params;

  if (rawType === '1') {
    if (userInFrom && userInTo) {
      const fromAmount = tx.from?.[0]?.amount || '0';
      const toAmount = tx.to?.[0]?.amount || '0';
      const fromVal = Number.parseFloat(fromAmount);
      const toVal = Number.parseFloat(toAmount);
      const symbolLower = normalize(symbol);
      if (symbolLower === 'bnb' || symbolLower === 'sol') {
        return toVal > fromVal ? 'buy' : 'sell';
      }
      return fromVal > toVal ? 'sell' : 'buy';
    }

    if (userInTo && !userInFrom) {
      return 'buy';
    }

    return 'sell';
  }

  return userInTo ? 'receive' : 'send';
}

function groupTransactionsByHash(transactions: OkxTransaction[]) {
  const grouped = new Map<string, OkxTransaction[]>();
  const fallbackGroups: GroupedTransaction[] = [];

  transactions.forEach((tx, index) => {
    const txHash = (tx.txHash || '').trim();
    if (!txHash) {
      fallbackGroups.push({
        txHash: `__missing_hash__${index}`,
        entries: [tx],
      });
      return;
    }

    const key = txHash.toLowerCase();
    const existing = grouped.get(key);
    if (existing) {
      existing.push(tx);
      return;
    }
    grouped.set(key, [tx]);
  });

  const groupedByHash: GroupedTransaction[] = Array.from(grouped.values()).map((entries) => ({
    txHash: entries[0]?.txHash || '',
    entries,
  }));

  return [...groupedByHash, ...fallbackGroups];
}

function pickRepresentativeEntry(entries: OkxTransaction[], chain: string, userAddressLower: string) {
  let best = entries[0];
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    const symbol = entry.symbol || 'UNKNOWN';
    const tokenAddress = entry.tokenContractAddress || entry.tokenAddress || '';
    const amount = Math.abs(parseAmount(entry.amount));
    const rawType = entry.itype || entry.iType || '0';
    const fromHasUser = getAddresses(entry.from).has(userAddressLower);
    const toHasUser = getAddresses(entry.to).has(userAddressLower);

    let score = 0;
    if (!isNativeAsset(chain, symbol, tokenAddress)) {
      score += 20;
    }
    if (rawType === '2') {
      score += 10;
    } else if (rawType === '1') {
      score += 5;
    }
    if (fromHasUser || toHasUser) {
      score += 3;
    }
    if (amount > 0) {
      score += Math.log10(amount + 1);
    }

    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  return best;
}

function collectTokenFlows(entries: OkxTransaction[], chain: string, userAddressLower: string) {
  const flows: TokenFlow[] = [];

  for (const entry of entries) {
    const amount = parseAmount(entry.amount);
    if (amount <= 0) {
      continue;
    }

    const symbol = (entry.symbol || 'UNKNOWN').trim() || 'UNKNOWN';
    const tokenAddress = (entry.tokenContractAddress || entry.tokenAddress || '').trim();
    const fromAddress = entry.from?.[0]?.address || '';
    const toAddress = entry.to?.[0]?.address || '';
    const fromHasUser = getAddresses(entry.from).has(userAddressLower);
    const toHasUser = getAddresses(entry.to).has(userAddressLower);

    let direction: 'in' | 'out' | null = null;
    if (fromHasUser && !toHasUser) {
      direction = 'out';
    } else if (toHasUser && !fromHasUser) {
      direction = 'in';
    }

    if (!direction) {
      continue;
    }

    flows.push({
      direction,
      symbol,
      tokenAddress,
      amount,
      fromAddress,
      toAddress,
      rawType: entry.itype || entry.iType || '0',
      native: isNativeAsset(chain, symbol, tokenAddress),
    });
  }

  return flows;
}

function collectTokenFlowsFromDetail(detail: OkxTransactionDetail, chain: string, userAddressLower: string) {
  const flows: TokenFlow[] = [];
  const transfers = Array.isArray(detail.tokenTransferDetails) ? detail.tokenTransferDetails : [];

  for (const transfer of transfers) {
    const amount = parseAmount(transfer.amount);
    if (amount <= 0) {
      continue;
    }

    const fromAddress = transfer.from || '';
    const toAddress = transfer.to || '';
    const fromHasUser = normalize(fromAddress) === userAddressLower;
    const toHasUser = normalize(toAddress) === userAddressLower;
    if (fromHasUser === toHasUser) {
      continue;
    }

    const tokenAddress = (transfer.tokenContractAddress || '').trim();
    const rawSymbol = (transfer.symbol || '').trim();
    const nativeByAddress = isNativeAsset(chain, '', tokenAddress);
    const symbol =
      rawSymbol ||
      (nativeByAddress ? (normalize(chain) === 'bsc' ? 'BNB' : 'SOL') : 'UNKNOWN');

    flows.push({
      direction: fromHasUser ? 'out' : 'in',
      symbol,
      tokenAddress,
      amount,
      fromAddress,
      toAddress,
      rawType: 'detail',
      native: isNativeAsset(chain, symbol, tokenAddress),
    });
  }

  return flows;
}

interface FlowSummary {
  outgoingNonNative: TokenFlow[];
  incomingNonNative: TokenFlow[];
  outgoingNativeTotal: number;
  incomingNativeTotal: number;
  dominantOutgoingNonNative: TokenFlow | null;
  dominantIncomingNonNative: TokenFlow | null;
}

function summarizeFlows(flows: TokenFlow[]): FlowSummary {
  const outgoingNonNative = flows.filter((flow) => flow.direction === 'out' && !flow.native);
  const incomingNonNative = flows.filter((flow) => flow.direction === 'in' && !flow.native);
  const outgoingNativeTotal = flows
    .filter((flow) => flow.direction === 'out' && flow.native)
    .reduce((sum, flow) => sum + flow.amount, 0);
  const incomingNativeTotal = flows
    .filter((flow) => flow.direction === 'in' && flow.native)
    .reduce((sum, flow) => sum + flow.amount, 0);

  return {
    outgoingNonNative,
    incomingNonNative,
    outgoingNativeTotal,
    incomingNativeTotal,
    dominantOutgoingNonNative: pickDominantFlow(outgoingNonNative),
    dominantIncomingNonNative: pickDominantFlow(incomingNonNative),
  };
}

function shouldProbeOkxDetail(params: {
  txHash: string;
  chain: string;
  fallbackAction: NonNullable<Activity['metadata']['txAction']>;
  symbol: string;
  tokenAddress: string;
  summary: FlowSummary;
}) {
  const { txHash, chain, fallbackAction, symbol, tokenAddress, summary } = params;
  if (!txHash || !chain) {
    return false;
  }
  if (isNativeAsset(chain, symbol, tokenAddress)) {
    return false;
  }

  if (fallbackAction === 'send') {
    return (
      summary.outgoingNonNative.length > 0 &&
      summary.incomingNativeTotal <= 0 &&
      summary.incomingNonNative.length <= 0
    );
  }
  if (fallbackAction === 'receive') {
    return (
      summary.incomingNonNative.length > 0 &&
      summary.outgoingNativeTotal <= 0 &&
      summary.outgoingNonNative.length <= 0
    );
  }
  return false;
}

async function fetchOkxDetailTokenFlows(txHash: string, chain: string, userAddressLower: string) {
  const cacheKey = `${normalize(chain)}|${txHash.toLowerCase()}|${userAddressLower}`;
  const existing = okxDetailFlowCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const task = (async () => {
    const result = await fetchOkxTransactionDetailByTxHash(txHash, chain);
    if (!result.ok || !result.detail) {
      return [] as TokenFlow[];
    }
    return collectTokenFlowsFromDetail(result.detail, chain, userAddressLower);
  })().catch(() => [] as TokenFlow[]);

  okxDetailFlowCache.set(cacheKey, task);
  return task;
}

function pickDominantFlow(flows: TokenFlow[]) {
  if (flows.length === 0) {
    return null;
  }

  return flows.reduce((best, current) => (current.amount > best.amount ? current : best));
}

async function fetchSolanaNetSolDelta(txHash: string, trackedAddressLower: string) {
  const cacheKey = `${txHash.toLowerCase()}|${trackedAddressLower}`;
  const existing = solanaNetChangeCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const task = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, SOLANA_RPC_TIMEOUT_MS);

    try {
      const response = await fetch(SOLANA_RPC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [txHash, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
        }),
        cache: 'no-store',
        signal: controller.signal,
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as {
        error?: unknown;
        result?: {
          transaction?: {
            message?: {
              accountKeys?: Array<string | { pubkey?: string }>;
            };
          };
          meta?: {
            preBalances?: number[];
            postBalances?: number[];
          };
        } | null;
      };

      if (payload.error || !payload.result?.transaction?.message?.accountKeys || !payload.result.meta) {
        return null;
      }

      const keys = payload.result.transaction.message.accountKeys.map((item) =>
        typeof item === 'string' ? item : item.pubkey || ''
      );
      const matchedIndex = keys.findIndex((key) => normalize(key) === trackedAddressLower);
      if (matchedIndex < 0) {
        return null;
      }

      const pre = payload.result.meta.preBalances?.[matchedIndex];
      const post = payload.result.meta.postBalances?.[matchedIndex];
      if (typeof pre !== 'number' || typeof post !== 'number') {
        return null;
      }

      return (post - pre) / 1e9;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();

  solanaNetChangeCache.set(cacheKey, task);
  return task;
}

async function convertToActivity(
  group: GroupedTransaction,
  user: User,
  addressInfo: AddressInfo,
  requireTrackedInitiator: boolean
): Promise<Activity | null> {
  const userAddressLower = normalize(addressInfo.address);
  const representative = pickRepresentativeEntry(group.entries, addressInfo.chain, userAddressLower);

  const timestamp = group.entries.reduce((max, entry) => Math.max(max, parseTimestamp(entry)), 0) || Date.now();
  const symbol = representative.symbol || 'UNKNOWN';
  const amount = representative.amount || '0';
  const tokenAddress = representative.tokenContractAddress || representative.tokenAddress || '';
  const fromAddress = representative.from?.[0]?.address || '';
  const toAddress = representative.to?.[0]?.address || '';
  const rawType = representative.itype || representative.iType || '0';
  const type: ActivityType = 'transfer';

  const fromAddresses = new Set<string>();
  const toAddresses = new Set<string>();
  const signerAddresses = new Set<string>();
  for (const entry of group.entries) {
    getAddresses(entry.from).forEach((address) => fromAddresses.add(address));
    getAddresses(entry.to).forEach((address) => toAddresses.add(address));
    getSignerAddresses(entry).forEach((address) => signerAddresses.add(address));
  }

  const initiatorMatchedFrom = fromAddresses.has(userAddressLower);
  const targetMatchedTo = toAddresses.has(userAddressLower);
  const initiatorMatchedSigner = signerAddresses.has(userAddressLower);
  const initiatedByTracked =
    initiatorMatchedFrom ||
    initiatorMatchedSigner ||
    // 某些合约交易在 OKX 列表中缺少 signer，仅能从 to 命中被跟踪地址。
    (rawType === '1' && targetMatchedTo);

  if (requireTrackedInitiator && !initiatedByTracked) {
    return null;
  }

  const txStatus = representative.txStatus;
  const fallbackAction = inferTxAction({
    rawType,
    symbol,
    userInFrom: initiatorMatchedFrom,
    userInTo: targetMatchedTo,
    tx: representative,
  });

  let txAction: NonNullable<Activity['metadata']['txAction']> = fallbackAction;
  let displayToken = symbol;
  let displayAmount = amount;
  let displayTokenAddress = tokenAddress;
  let displayFromAddress = fromAddress;
  let displayToAddress = toAddress;
  let quoteToken: string | undefined;
  let quoteAmount: string | undefined;

  let flows = collectTokenFlows(group.entries, addressInfo.chain, userAddressLower);
  let summary = summarizeFlows(flows);

  if (
    shouldProbeOkxDetail({
      txHash: group.txHash,
      chain: addressInfo.chain,
      fallbackAction,
      symbol,
      tokenAddress,
      summary,
    })
  ) {
    const detailFlows = await fetchOkxDetailTokenFlows(group.txHash, addressInfo.chain, userAddressLower);
    if (detailFlows.length > 0) {
      flows = detailFlows;
      summary = summarizeFlows(flows);
    }
  }

  const {
    outgoingNonNative,
    incomingNonNative,
    outgoingNativeTotal,
    incomingNativeTotal,
    dominantOutgoingNonNative,
    dominantIncomingNonNative,
  } = summary;

  const outgoingTradeHasCounterFlow = incomingNativeTotal > 0 || incomingNonNative.length > 0;
  const incomingTradeHasCounterFlow = outgoingNativeTotal > 0 || outgoingNonNative.length > 0;

  if (dominantOutgoingNonNative && outgoingTradeHasCounterFlow) {
    txAction = 'sell';
    displayToken = dominantOutgoingNonNative.symbol;
    displayAmount = formatAmount(dominantOutgoingNonNative.amount);
    displayTokenAddress = dominantOutgoingNonNative.tokenAddress;
    displayFromAddress = dominantOutgoingNonNative.fromAddress || displayFromAddress;
    displayToAddress = dominantOutgoingNonNative.toAddress || displayToAddress;

    let acquiredNative = incomingNativeTotal;
    const shouldUseSolanaRpcQuote =
      addressInfo.chain === 'solana' &&
      acquiredNative <= 0 &&
      outgoingNativeTotal > 0 &&
      Boolean(group.txHash);

    if (shouldUseSolanaRpcQuote) {
      const netDelta = await fetchSolanaNetSolDelta(group.txHash, userAddressLower);
      if (typeof netDelta === 'number' && netDelta > 0) {
        acquiredNative = netDelta + outgoingNativeTotal;
      }
    }

    if (acquiredNative > 0) {
      quoteToken = addressInfo.chain === 'bsc' ? 'BNB' : 'SOL';
      quoteAmount = formatAmount(acquiredNative);
    }
  } else if (dominantIncomingNonNative && incomingTradeHasCounterFlow) {
    txAction = 'buy';
    displayToken = dominantIncomingNonNative.symbol;
    displayAmount = formatAmount(dominantIncomingNonNative.amount);
    displayTokenAddress = dominantIncomingNonNative.tokenAddress;
    displayFromAddress = dominantIncomingNonNative.fromAddress || displayFromAddress;
    displayToAddress = dominantIncomingNonNative.toAddress || displayToAddress;

    let spentNative = outgoingNativeTotal;
    if (addressInfo.chain === 'solana' && spentNative <= 0 && incomingNativeTotal > 0 && group.txHash) {
      const netDelta = await fetchSolanaNetSolDelta(group.txHash, userAddressLower);
      if (typeof netDelta === 'number' && netDelta < 0) {
        spentNative = Math.abs(netDelta) + incomingNativeTotal;
      }
    }

    if (spentNative > 0) {
      quoteToken = addressInfo.chain === 'bsc' ? 'BNB' : 'SOL';
      quoteAmount = formatAmount(spentNative);
    }
  }

  let title = targetMatchedTo ? '收到转账' : '发送转账';

  if (rawType === '2') {
    title += ' (Token)';
  } else if (rawType === '1') {
    title += ' (合约)';
  } else if (rawType === '0') {
    title += ' (主链币)';
  }

  if (txAction === 'buy') {
    title = '买入资产';
  } else if (txAction === 'sell') {
    title = '卖出资产';
  }

  if (txStatus === 'fail') {
    title += ' [失败]';
  } else if (txStatus === 'pending') {
    title += ' [处理中]';
  }

  const uncertainFrom = !initiatorMatchedFrom && !initiatorMatchedSigner;

  const actionText =
    txAction === 'buy'
      ? '买入'
      : txAction === 'sell'
        ? '卖出'
        : txAction === 'receive'
          ? '收到'
          : '发送';

  const quoteText = quoteAmount && quoteToken ? `，${txAction === 'sell' ? '获得' : '花费'} ${quoteAmount} ${quoteToken}` : '';

  return {
    id: `${user.id}-${group.txHash || timestamp}-${Math.random().toString(36).slice(2, 11)}`,
    userId: user.id,
    source: 'blockchain',
    type,
    title,
    content: `${actionText} ${displayAmount} ${displayToken}${quoteText}`,
    timestamp,
    metadata: {
      txHash: group.txHash || representative.txHash,
      value: displayAmount,
      token: displayToken,
      tokenAddress: displayTokenAddress,
      quoteToken,
      quoteAmount,
      chain: addressInfo.chain,
      fromAddress: displayFromAddress,
      toAddress: displayToAddress,
      txStatus,
      txAction,
      trackedAddress: addressInfo.address,
      uncertainFrom,
    },
  };
}

export async function buildActivityFeed(users: User[], options?: BuildActivityFeedOptions) {
  const now = Date.now();
  const endMs = typeof options?.endMs === 'number' ? Math.max(0, Math.floor(options.endMs)) : now;
  const beginMs =
    typeof options?.beginMs === 'number'
      ? Math.max(0, Math.min(Math.floor(options.beginMs), endMs))
      : Math.max(0, endMs - DEFAULT_WINDOW_MS);
  const requireTrackedInitiator = options?.requireTrackedInitiator !== false;

  const feed: Array<{ user: User; activity: Activity }> = [];
  const diagnostics: AddressDiagnostic[] = [];

  for (const user of users) {
    for (const addressInfo of user.addresses) {
      try {
        const result = await fetchOkxTransactionsByAddress(addressInfo.address, addressInfo.chain, {
          beginMs,
          endMs,
        });
        const transactions = result.ok ? result.transactions : [];
        const groups = groupTransactionsByHash(transactions);

        let convertedCount = 0;
        for (const group of groups) {
          const activity = await convertToActivity(group, user, addressInfo, requireTrackedInitiator);
          if (!activity) {
            continue;
          }
          convertedCount += 1;
          feed.push({
            user,
            activity,
          });
        }

        diagnostics.push({
          userId: user.id,
          userName: user.name,
          address: addressInfo.address,
          addressName: addressInfo.name,
          chain: addressInfo.chain,
          ok: result.ok,
          transactionCount: convertedCount,
          error: result.error,
        });
      } catch (error) {
        diagnostics.push({
          userId: user.id,
          userName: user.name,
          address: addressInfo.address,
          addressName: addressInfo.name,
          chain: addressInfo.chain,
          ok: false,
          transactionCount: 0,
          error: error instanceof Error ? error.message : '地址抓取异常',
        });
      }
    }
  }

  const sortedFeed = feed.sort((a, b) => b.activity.timestamp - a.activity.timestamp);
  const summary: ActivityFeedSummary = {
    userCount: users.length,
    addressCount: diagnostics.length,
    transactionCount: sortedFeed.length,
    successfulAddressCount: diagnostics.filter((item) => item.ok).length,
    failedAddressCount: diagnostics.filter((item) => !item.ok).length,
    emptyAddressCount: diagnostics.filter((item) => item.ok && item.transactionCount === 0).length,
    completedAt: Date.now(),
  };

  return {
    feed: sortedFeed,
    diagnostics,
    summary,
    rawTransactions: [],
    judgments: [],
    addressAssets: [],
    userAssets: [],
    window: {
      beginMs,
      endMs,
    },
  };
}
