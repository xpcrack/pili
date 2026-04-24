import { fetchOkxTransactionsByAddress } from '@/lib/okx';
import { collectAddressAssetSnapshots } from '@/lib/addressAssetSnapshots';
import { evaluateActivityForFeed, getDefaultFilterEngineConfig } from '@/lib/filterEngine';
import { groupTransactionsByHash } from '@/lib/parsing/core';
import { convertToActivity, type ParseClassification } from '@/lib/parsing/toActivity';
import { resolveTransactionTimeMarketCap } from '@/lib/tokenLogo';
import { Activity, User } from '@/types';

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

async function fetchQualifiedWindowTransactions(
  address: string,
  chain: string,
  beginMs: number,
  endMs: number,
  depth = 0
): Promise<Awaited<ReturnType<typeof fetchOkxTransactionsByAddress>>> {
  const result = await fetchOkxTransactionsByAddress(address, chain, {
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
    fetchQualifiedWindowTransactions(address, chain, beginMs, middleMs, depth + 1),
    fetchQualifiedWindowTransactions(address, chain, middleMs + 1, endMs, depth + 1),
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
        const result = await fetchQualifiedWindowTransactions(addressInfo.address, addressInfo.chain, beginMs, endMs);
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
  const assetSnapshots = await collectAddressAssetSnapshots(users);
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
