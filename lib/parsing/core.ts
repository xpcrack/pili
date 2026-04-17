import { fetchOkxTransactionDetailByTxHash, type OkxTransaction, type OkxTransactionDetail } from '@/lib/okx';
import type {
  FlowSummary,
  GroupedTransaction,
  InferTxActionParams,
  NormalizedTxAction,
  ParseGroupedTransactionParams,
  ParsedTransactionCore,
  ProbeOkxDetailParams,
  TokenFlow,
} from '@/lib/parsing/types';

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
const SOLANA_RPC_TIMEOUT_MS = 5000;
const SOLANA_NATIVE_MINTS = new Set([
  'so11111111111111111111111111111111111111111',
  'so11111111111111111111111111111111111111112',
]);
const NATIVE_SYMBOLS_BY_CHAIN: Record<string, Set<string>> = {
  bsc: new Set(['bnb', 'wbnb']),
  solana: new Set(['sol', 'wsol']),
};

const solanaNetChangeCache = new Map<string, Promise<number | null>>();
const okxDetailFlowCache = new Map<string, Promise<TokenFlow[]>>();

export function normalize(value: string | undefined | null) {
  return (value || '').trim().toLowerCase();
}

export function parseTimestamp(tx: OkxTransaction) {
  const parsed = tx.txTime ? Number.parseInt(tx.txTime, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Date.now();
  }
  return parsed;
}

export function parseAmount(value: string | undefined) {
  const parsed = Number.parseFloat((value || '').trim());
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return parsed;
}

export function formatAmount(value: number) {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return value.toFixed(9).replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '');
}

export function getAddresses(entries: Array<{ address?: string; amount?: string }> | undefined) {
  const addresses = new Set<string>();
  if (!Array.isArray(entries)) {
    return addresses;
  }

  for (const entry of entries) {
    const normalizedAddress = normalize(entry?.address);
    if (!normalizedAddress) {
      continue;
    }
    addresses.add(normalizedAddress);
  }

  return addresses;
}

export function getSignerAddresses(tx: OkxTransaction) {
  const signers = new Set<string>();
  const candidate = tx as OkxTransaction & {
    signer?: string;
    signAddress?: string;
    signers?: Array<string | { address?: string }>;
  };

  const push = (value: string | undefined) => {
    const normalizedValue = normalize(value);
    if (!normalizedValue) {
      return;
    }
    signers.add(normalizedValue);
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

export function isNativeAsset(chain: string, symbol: string, tokenAddress: string) {
  const normalizedChain = normalize(chain);
  const normalizedSymbol = normalize(symbol);
  const normalizedTokenAddress = normalize(tokenAddress);

  if (normalizedChain === 'solana' && SOLANA_NATIVE_MINTS.has(normalizedTokenAddress)) {
    return true;
  }

  return NATIVE_SYMBOLS_BY_CHAIN[normalizedChain]?.has(normalizedSymbol) ?? false;
}

export function inferTxAction(params: InferTxActionParams): NormalizedTxAction {
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

export function groupTransactionsByHash(transactions: OkxTransaction[]): GroupedTransaction[] {
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

  const groupedByHash = Array.from(grouped.values()).map((entries) => ({
    txHash: entries[0]?.txHash || '',
    entries,
  }));

  return [...groupedByHash, ...fallbackGroups];
}

export function pickRepresentativeEntry(entries: OkxTransaction[], chain: string, userAddressLower: string) {
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

export function collectTokenFlows(entries: OkxTransaction[], chain: string, userAddressLower: string) {
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

    let direction: TokenFlow['direction'] | null = null;
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

export function collectTokenFlowsFromDetail(detail: OkxTransactionDetail, chain: string, userAddressLower: string) {
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
    const symbol = rawSymbol || (nativeByAddress ? (normalize(chain) === 'bsc' ? 'BNB' : 'SOL') : 'UNKNOWN');

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

export function pickDominantFlow(flows: TokenFlow[]) {
  if (flows.length === 0) {
    return null;
  }

  return flows.reduce((best, current) => (current.amount > best.amount ? current : best));
}

export function summarizeFlows(flows: TokenFlow[]): FlowSummary {
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

export function shouldProbeOkxDetail(params: ProbeOkxDetailParams) {
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

export async function fetchOkxDetailTokenFlows(txHash: string, chain: string, userAddressLower: string) {
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

export async function fetchSolanaNetSolDelta(txHash: string, trackedAddressLower: string) {
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

export async function parseGroupedTransaction(params: ParseGroupedTransactionParams): Promise<ParsedTransactionCore | null> {
  const { group, chain, trackedAddress, requireTrackedInitiator = true } = params;
  const trackedAddressLower = normalize(trackedAddress);
  const representative = pickRepresentativeEntry(group.entries, chain, trackedAddressLower);

  const timestamp = group.entries.reduce((max, entry) => Math.max(max, parseTimestamp(entry)), 0) || Date.now();
  const symbol = representative.symbol || 'UNKNOWN';
  const amount = representative.amount || '0';
  const tokenAddress = representative.tokenContractAddress || representative.tokenAddress || '';
  const fromAddress = representative.from?.[0]?.address || '';
  const toAddress = representative.to?.[0]?.address || '';
  const rawType = representative.itype || representative.iType || '0';

  const fromAddresses = new Set<string>();
  const toAddresses = new Set<string>();
  const signerAddresses = new Set<string>();
  for (const entry of group.entries) {
    getAddresses(entry.from).forEach((address) => fromAddresses.add(address));
    getAddresses(entry.to).forEach((address) => toAddresses.add(address));
    getSignerAddresses(entry).forEach((address) => signerAddresses.add(address));
  }

  const initiatorMatchedFrom = fromAddresses.has(trackedAddressLower);
  const targetMatchedTo = toAddresses.has(trackedAddressLower);
  const initiatorMatchedSigner = signerAddresses.has(trackedAddressLower);
  const initiatedByTracked =
    initiatorMatchedFrom ||
    initiatorMatchedSigner ||
    (rawType === '1' && targetMatchedTo);

  if (requireTrackedInitiator && !initiatedByTracked) {
    return null;
  }

  const fallbackAction = inferTxAction({
    rawType,
    symbol,
    userInFrom: initiatorMatchedFrom,
    userInTo: targetMatchedTo,
    tx: representative,
  });

  let txAction: NormalizedTxAction = fallbackAction;
  let primaryAsset = {
    symbol,
    amount,
    tokenAddress,
    fromAddress,
    toAddress,
  };
  let quoteAsset: ParsedTransactionCore['quoteAsset'];

  let flows = collectTokenFlows(group.entries, chain, trackedAddressLower);
  let flowSummary = summarizeFlows(flows);
  let usedDetailProbe = false;

  if (
    shouldProbeOkxDetail({
      txHash: group.txHash,
      chain,
      fallbackAction,
      symbol,
      tokenAddress,
      summary: flowSummary,
    })
  ) {
    const detailFlows = await fetchOkxDetailTokenFlows(group.txHash, chain, trackedAddressLower);
    if (detailFlows.length > 0) {
      flows = detailFlows;
      flowSummary = summarizeFlows(flows);
      usedDetailProbe = true;
    }
  }

  const {
    outgoingNonNative,
    incomingNonNative,
    outgoingNativeTotal,
    incomingNativeTotal,
    dominantOutgoingNonNative,
    dominantIncomingNonNative,
  } = flowSummary;

  const outgoingTradeHasCounterFlow = incomingNativeTotal > 0 || incomingNonNative.length > 0;
  const incomingTradeHasCounterFlow = outgoingNativeTotal > 0 || outgoingNonNative.length > 0;

  if (dominantOutgoingNonNative && outgoingTradeHasCounterFlow) {
    txAction = 'sell';
    primaryAsset = {
      symbol: dominantOutgoingNonNative.symbol,
      amount: formatAmount(dominantOutgoingNonNative.amount),
      tokenAddress: dominantOutgoingNonNative.tokenAddress,
      fromAddress: dominantOutgoingNonNative.fromAddress || primaryAsset.fromAddress,
      toAddress: dominantOutgoingNonNative.toAddress || primaryAsset.toAddress,
    };

    let acquiredNative = incomingNativeTotal;
    const shouldUseSolanaRpcQuote =
      chain === 'solana' &&
      acquiredNative <= 0 &&
      outgoingNativeTotal > 0 &&
      Boolean(group.txHash);

    if (shouldUseSolanaRpcQuote) {
      const netDelta = await fetchSolanaNetSolDelta(group.txHash, trackedAddressLower);
      if (typeof netDelta === 'number' && netDelta > 0) {
        acquiredNative = netDelta + outgoingNativeTotal;
      }
    }

    if (acquiredNative > 0) {
      quoteAsset = {
        token: chain === 'bsc' ? 'BNB' : 'SOL',
        amount: formatAmount(acquiredNative),
      };
    }
  } else if (dominantIncomingNonNative && incomingTradeHasCounterFlow) {
    txAction = 'buy';
    primaryAsset = {
      symbol: dominantIncomingNonNative.symbol,
      amount: formatAmount(dominantIncomingNonNative.amount),
      tokenAddress: dominantIncomingNonNative.tokenAddress,
      fromAddress: dominantIncomingNonNative.fromAddress || primaryAsset.fromAddress,
      toAddress: dominantIncomingNonNative.toAddress || primaryAsset.toAddress,
    };

    let spentNative = outgoingNativeTotal;
    if (chain === 'solana' && spentNative <= 0 && incomingNativeTotal > 0 && group.txHash) {
      const netDelta = await fetchSolanaNetSolDelta(group.txHash, trackedAddressLower);
      if (typeof netDelta === 'number' && netDelta < 0) {
        spentNative = Math.abs(netDelta) + incomingNativeTotal;
      }
    }

    if (spentNative > 0) {
      quoteAsset = {
        token: chain === 'bsc' ? 'BNB' : 'SOL',
        amount: formatAmount(spentNative),
      };
    }
  }

  return {
    txHash: group.txHash || representative.txHash || '',
    representative,
    timestamp,
    rawType,
    txStatus: representative.txStatus,
    addressMatch: {
      initiatorMatchedFrom,
      targetMatchedTo,
      initiatorMatchedSigner,
      initiatedByTracked,
      uncertainFrom: !initiatorMatchedFrom && !initiatorMatchedSigner,
    },
    fallbackAction,
    txAction,
    primaryAsset,
    quoteAsset,
    flows,
    flowSummary,
    usedDetailProbe,
  };
}
