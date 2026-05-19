import { fetchOkxTransactionsByAddress } from '@/lib/okx';
import { collectAddressAssetSnapshots } from '@/lib/addressAssetSnapshots';
import { evaluateActivityForFeed, getDefaultFilterEngineConfig } from '@/lib/filterEngine';
import { groupTransactionsByHash } from '@/lib/parsing/core';
import { convertToActivity, type ParseClassification } from '@/lib/parsing/toActivity';
import { sleep } from '@/lib/timing';
import { resolveTradeAmountUsdAtTx } from '@/lib/tradeUsd';
import { resolveTransactionTimeMarketCap } from '@/lib/tokenLogo';
import { Activity, User } from '@/types';

type OkxTransactionsByAddressResult = Awaited<ReturnType<typeof fetchOkxTransactionsByAddress>>;
type OkxTransactionsByAddressFetcher = (
  address: string,
  chain: string,
  options?: { beginMs?: number; endMs?: number }
) => Promise<OkxTransactionsByAddressResult>;
type AssetSnapshotCollection = Awaited<ReturnType<typeof collectAddressAssetSnapshots>>;

export interface AddressDiagnostic {
  userId: string;
  userName: string;
  address: string;
  addressName: string;
  chain: string;
  ok: boolean;
  transactionCount: number;
  error: string | null;
  fetchAttempts?: number;
  retryExhausted?: boolean;
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
  token?: string;
  tokenAddress?: string;
  balance?: string;
  valueUsd?: number;
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
  fetchTransactionsByAddress?: OkxTransactionsByAddressFetcher;
  retryPolicy?: BuildActivityFeedRetryPolicy;
  onAddressFetchRetryExhausted?: (failure: BuildActivityFeedFetchFailure) => Promise<void> | void;
  assetSnapshotCollector?: (users: User[]) => Promise<AssetSnapshotCollection>;
}

export interface BuildActivityFeedRetryPolicy {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  shouldRetry?: (error: string | null | undefined, attempt: number) => boolean;
}

export interface BuildActivityFeedFetchFailure {
  userId: string;
  userName: string;
  address: string;
  addressName: string;
  chain: string;
  attemptCount: number;
  error: string | null;
  beginMs: number;
  endMs: number;
}

export interface RawTransactionSnapshotRecord {
  chain: string;
  trackedAddress: string;
  txHash: string;
  txTime: number | null;
  payload: unknown;
}

export interface ActivityJudgmentRecord {
  chain: string;
  trackedAddress: string;
  txHash: string;
  txTime?: number | null;
  txAction: 'buy' | 'sell' | 'send' | 'receive';
  token?: string;
  value?: string;
  tokenAddress?: string;
  quoteToken?: string;
  quoteAmount?: string;
  fromAddress?: string;
  toAddress?: string;
  uncertainFrom: boolean;
  decision: 'visible' | 'hidden' | 'pending';
  reasonCode: string;
  reasonText: string;
  computedUsdValue?: number | null;
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const OKX_WINDOW_RESULT_LIMIT = 100;
const MIN_WINDOW_SPLIT_MS = 60 * 1000;
const MAX_WINDOW_SPLIT_DEPTH = 12;
const SKIP_TX_MARKET_CAP_BACKFILL = process.env.SKIP_TX_MARKET_CAP_BACKFILL === 'true';
const DEFAULT_OKX_RETRY_MAX_ATTEMPTS = readPositiveIntFromEnv('OKX_FETCH_MAX_ATTEMPTS', 3);
const DEFAULT_OKX_RETRY_BASE_DELAY_MS = readPositiveIntFromEnv('OKX_FETCH_RETRY_BASE_DELAY_MS', 1500);
const DEFAULT_OKX_RETRY_MAX_DELAY_MS = readPositiveIntFromEnv('OKX_FETCH_RETRY_MAX_DELAY_MS', 12000);

function readPositiveIntFromEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function defaultShouldRetryOkxError(error: string | null | undefined) {
  const normalized = (error || '').toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.includes('okx api 429')) {
    return true;
  }
  if (/okx api 5\d\d/.test(normalized)) {
    return true;
  }
  if (normalized.includes('okx 网络错误') || normalized.includes('network')) {
    return true;
  }
  if (normalized.includes('超时') || normalized.includes('timeout') || normalized.includes('fetch failed')) {
    return true;
  }
  return false;
}

function normalizeRetryPolicy(policy: BuildActivityFeedRetryPolicy | undefined) {
  const maxAttempts =
    typeof policy?.maxAttempts === 'number' && Number.isFinite(policy.maxAttempts)
      ? Math.max(1, Math.floor(policy.maxAttempts))
      : DEFAULT_OKX_RETRY_MAX_ATTEMPTS;
  const baseDelayMs =
    typeof policy?.baseDelayMs === 'number' && Number.isFinite(policy.baseDelayMs)
      ? Math.max(1, Math.floor(policy.baseDelayMs))
      : DEFAULT_OKX_RETRY_BASE_DELAY_MS;
  const maxDelayMs =
    typeof policy?.maxDelayMs === 'number' && Number.isFinite(policy.maxDelayMs)
      ? Math.max(baseDelayMs, Math.floor(policy.maxDelayMs))
      : DEFAULT_OKX_RETRY_MAX_DELAY_MS;

  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    sleep: policy?.sleep || sleep,
    shouldRetry: policy?.shouldRetry || ((error: string | null | undefined) => defaultShouldRetryOkxError(error)),
  };
}

function computeRetryDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number) {
  const retryIndex = Math.max(1, attempt);
  const raw = baseDelayMs * 2 ** (retryIndex - 1);
  return Math.min(maxDelayMs, raw);
}

function hasNumericTradeAmountUsdAtTx(activity: Activity) {
  return (
    typeof activity.metadata.tradeAmountUsdAtTx === 'number' &&
    Number.isFinite(activity.metadata.tradeAmountUsdAtTx)
  );
}

export async function backfillTradeAmountUsdAtTxForActivity(activity: Activity, fallbackChain?: string | null) {
  if (activity.metadata.txAction !== 'buy' && activity.metadata.txAction !== 'sell') {
    return null;
  }

  if (hasNumericTradeAmountUsdAtTx(activity)) {
    return activity.metadata.tradeAmountUsdAtTx ?? null;
  }

  const tradeAmountUsdAtTx = await resolveTradeAmountUsdAtTx({
    chain: activity.metadata.chain || fallbackChain || null,
    txTimestampMs: activity.timestamp,
    token: activity.metadata.token,
    value: activity.metadata.value,
    quoteToken: activity.metadata.quoteToken,
    quoteAmount: activity.metadata.quoteAmount,
  });

  if (typeof tradeAmountUsdAtTx === 'number' && Number.isFinite(tradeAmountUsdAtTx)) {
    activity.metadata.tradeAmountUsdAtTx = tradeAmountUsdAtTx;
    return tradeAmountUsdAtTx;
  }

  return null;
}

async function fetchQualifiedWindowTransactions(
  address: string,
  chain: string,
  beginMs: number,
  endMs: number,
  depth = 0,
  deps?: {
    fetchTransactionsByAddress?: OkxTransactionsByAddressFetcher;
  }
): Promise<OkxTransactionsByAddressResult> {
  const fetchTransactionsByAddress = deps?.fetchTransactionsByAddress || fetchOkxTransactionsByAddress;
  const result = await fetchTransactionsByAddress(address, chain, {
    beginMs,
    endMs,
  });

  if (!result.ok) {
    return result;
  }

  if (
    result.transactions.length < OKX_WINDOW_RESULT_LIMIT ||
    depth >= MAX_WINDOW_SPLIT_DEPTH ||
    endMs - beginMs <= MIN_WINDOW_SPLIT_MS
  ) {
    return result;
  }

  const middleMs = Math.floor((beginMs + endMs) / 2);
  if (middleMs <= beginMs || middleMs >= endMs) {
    return result;
  }

  const [left, right] = await Promise.all([
    fetchQualifiedWindowTransactions(address, chain, beginMs, middleMs, depth + 1, deps),
    fetchQualifiedWindowTransactions(address, chain, middleMs + 1, endMs, depth + 1, deps),
  ]);

  if (!left.ok) {
    return left;
  }

  if (!right.ok) {
    return right;
  }

  const merged = new Map<string, (typeof left.transactions)[number]>();
  for (const tx of [...left.transactions, ...right.transactions]) {
    const txHash = typeof tx.txHash === 'string' ? tx.txHash.trim() : '';
    const nonce = typeof tx.nonce === 'string' ? tx.nonce.trim() : '';
    const dedupKey = txHash || `${tx.txTime || ''}:${nonce}:${tx.symbol || ''}:${tx.amount || ''}`;
    if (!dedupKey) {
      continue;
    }
    merged.set(dedupKey, tx);
  }

  return {
    ...result,
    transactions: Array.from(merged.values()),
  };
}

async function fetchQualifiedWindowTransactionsWithRetry(input: {
  address: string;
  chain: string;
  beginMs: number;
  endMs: number;
  fetchTransactionsByAddress?: OkxTransactionsByAddressFetcher;
  retryPolicy?: BuildActivityFeedRetryPolicy;
}) {
  const retryPolicy = normalizeRetryPolicy(input.retryPolicy);
  let attemptCount = 0;
  let lastResult: OkxTransactionsByAddressResult | null = null;
  let retryExhausted = false;

  while (attemptCount < retryPolicy.maxAttempts) {
    attemptCount += 1;
    let result: OkxTransactionsByAddressResult;
    try {
      result = await fetchQualifiedWindowTransactions(
        input.address,
        input.chain,
        input.beginMs,
        input.endMs,
        0,
        {
          fetchTransactionsByAddress: input.fetchTransactionsByAddress,
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'unknown error');
      result = {
        ok: false,
        configured: true,
        transactions: [],
        error: `OKX 拉取失败：${message}`,
      };
    }
    lastResult = result;
    if (result.ok) {
      retryExhausted = false;
      break;
    }

    const retryable = retryPolicy.shouldRetry(result.error, attemptCount);
    if (!retryable) {
      retryExhausted = false;
      break;
    }
    if (attemptCount >= retryPolicy.maxAttempts) {
      retryExhausted = true;
      break;
    }

    const delayMs = computeRetryDelayMs(attemptCount, retryPolicy.baseDelayMs, retryPolicy.maxDelayMs);
    await retryPolicy.sleep(delayMs);
  }

  return {
    result:
      lastResult ||
      ({
        ok: false,
        configured: true,
        transactions: [],
        error: 'OKX 拉取失败：未知错误',
      } satisfies OkxTransactionsByAddressResult),
    attemptCount,
    retryExhausted,
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
  const filterConfig = getDefaultFilterEngineConfig();

  const feed: Array<{ user: User; activity: Activity }> = [];
  const diagnostics: AddressDiagnostic[] = [];
  const rawTransactions: RawTransactionSnapshotRecord[] = [];
  const judgments: ActivityJudgmentRecord[] = [];
  const totalAddresses = users.reduce((sum, user) => sum + user.addresses.length, 0);
  let scannedAddresses = 0;

  for (const user of users) {
    for (const addressInfo of user.addresses) {
      scannedAddresses += 1;
      if (scannedAddresses === 1 || scannedAddresses % 20 === 0 || scannedAddresses === totalAddresses) {
        console.info(
          `[buildActivityFeed] progress ${scannedAddresses}/${totalAddresses} user=${user.name} chain=${addressInfo.chain}`
        );
      }
      try {
        const { result, attemptCount, retryExhausted } = await fetchQualifiedWindowTransactionsWithRetry({
          address: addressInfo.address,
          chain: addressInfo.chain,
          beginMs,
          endMs,
          fetchTransactionsByAddress: options?.fetchTransactionsByAddress,
          retryPolicy: options?.retryPolicy,
        });
        if (!result.ok && retryExhausted && options?.onAddressFetchRetryExhausted) {
          try {
            await options.onAddressFetchRetryExhausted({
              userId: user.id,
              userName: user.name,
              address: addressInfo.address,
              addressName: addressInfo.name,
              chain: addressInfo.chain,
              attemptCount,
              error: result.error,
              beginMs,
              endMs,
            });
          } catch (callbackError) {
            console.error(
              `[buildActivityFeed] onAddressFetchRetryExhausted failed user=${user.name} address=${addressInfo.address}:`,
              callbackError
            );
          }
        }
        const transactions = result.ok ? result.transactions : [];
        for (const tx of transactions) {
          const txHash = typeof tx.txHash === 'string' ? tx.txHash.trim() : '';
          if (!txHash) {
            continue;
          }
          const txTime = typeof tx.txTime === 'string' ? Number.parseInt(tx.txTime, 10) : Number.NaN;
          rawTransactions.push({
            chain: addressInfo.chain,
            trackedAddress: addressInfo.address,
            txHash,
            txTime: Number.isFinite(txTime) && txTime > 0 ? txTime : null,
            payload: tx,
          });
        }
        const groups = groupTransactionsByHash(transactions);

        let convertedCount = 0;
        for (const group of groups) {
          const classification: ParseClassification = 'normal';
          const activity = await convertToActivity({
            group,
            user,
            addressInfo,
            requireTrackedInitiator,
            classification,
          });
          if (!activity) {
            continue;
          }

          await backfillTradeAmountUsdAtTxForActivity(activity, addressInfo.chain);

          if (
            !SKIP_TX_MARKET_CAP_BACKFILL &&
            activity.source === 'blockchain' &&
            activity.type === 'transfer' &&
            activity.metadata.txAction !== 'receive' &&
            !activity.metadata.marketCapAtTxUsd
          ) {
            const chain = activity.metadata.chain || addressInfo.chain;
            const tokenAddress = activity.metadata.tokenAddress || '';
            if (chain && tokenAddress) {
              const marketCapResolution = await resolveTransactionTimeMarketCap({
                chain,
                tokenAddress,
                txHash: activity.metadata.txHash || null,
                txTimestampMs: activity.timestamp,
              });

              if (marketCapResolution.marketCapAtTxUsd && marketCapResolution.marketCapAtTxUsd > 0) {
                activity.metadata.marketCapAtTxUsd = marketCapResolution.marketCapAtTxUsd;
                activity.metadata.marketCapAtTxEstimated = marketCapResolution.marketCapAtTxEstimated;
                activity.metadata.marketCapAtTxSource = marketCapResolution.marketCapAtTxSource;
              }
            }
          }

          const verdict = await evaluateActivityForFeed(activity, filterConfig);
          judgments.push({
            chain: addressInfo.chain,
            trackedAddress: addressInfo.address,
            txHash: activity.metadata.txHash || group.txHash || '',
            txTime: activity.timestamp,
            txAction: activity.metadata.txAction || 'send',
            token: activity.metadata.token,
            value: activity.metadata.value,
            tokenAddress: activity.metadata.tokenAddress,
            quoteToken: activity.metadata.quoteToken,
            quoteAmount: activity.metadata.quoteAmount,
            fromAddress: activity.metadata.fromAddress,
            toAddress: activity.metadata.toAddress,
            uncertainFrom: activity.metadata.uncertainFrom === true,
            decision: verdict.decision,
            reasonCode: verdict.reasonCode,
            reasonText: verdict.reasonText,
            computedUsdValue: verdict.computedUsdValue,
          });
          if (verdict.decision !== 'visible') {
            continue;
          }
          convertedCount += 1;
          feed.push({ user, activity });
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
          fetchAttempts: attemptCount,
          retryExhausted: result.ok ? false : retryExhausted,
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
          fetchAttempts: undefined,
          retryExhausted: false,
        });
      }
    }
  }

  const sortedFeed = feed.sort((a, b) => b.activity.timestamp - a.activity.timestamp);
  const collectAssets = options?.assetSnapshotCollector || collectAddressAssetSnapshots;
  const assetSnapshots = await collectAssets(users);
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
    rawTransactions,
    judgments,
    addressAssets: assetSnapshots.addressAssets,
    userAssets: assetSnapshots.userAssets,
    window: {
      beginMs,
      endMs,
    },
  };
}
