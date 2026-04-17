import { fetchOkxTransactionsByAddress } from '@/lib/okx';
import { groupTransactionsByHash } from '@/lib/parsing/core';
import { convertToActivity, type ParseClassification } from '@/lib/parsing/toActivity';
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

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
