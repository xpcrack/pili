import { Activity, ActivityType, User, type AddressInfo } from '@/types';
import { fetchOkxTransactionsByAddress, type OkxTransaction } from '@/lib/okx';

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

function convertToActivity(
  tx: OkxTransaction,
  user: User,
  addressInfo: AddressInfo
): Activity {
  const timestamp = tx.txTime ? parseInt(tx.txTime, 10) : Date.now();
  const amount = tx.amount || '0';
  const symbol = tx.symbol || 'UNKNOWN';
  const fromAddress = tx.from?.[0]?.address || '';
  const toAddress = tx.to?.[0]?.address || '';
  const userAddress = addressInfo.address.toLowerCase();
  const isIncoming = toAddress.toLowerCase() === userAddress;
  const type: ActivityType = 'transfer';
  const rawType = tx.itype || tx.iType || '0';

  let title = isIncoming ? '收到转账' : '发送转账';

  if (rawType === '2') {
    title += ' (Token)';
  } else if (rawType === '1') {
    title += ' (合约)';
  } else if (rawType === '0') {
    title += ' (主链币)';
  }

  if (tx.txStatus === 'fail') {
    title += ' [失败]';
  } else if (tx.txStatus === 'pending') {
    title += ' [处理中]';
  }

  return {
    id: `${user.id}-${tx.txHash || timestamp}-${Math.random().toString(36).slice(2, 11)}`,
    userId: user.id,
    source: 'blockchain',
    type,
    title,
    content: isIncoming
      ? `收到 ${amount} ${symbol} 到 ${addressInfo.name}`
      : `发送 ${amount} ${symbol} 从 ${addressInfo.name}`,
    timestamp,
    metadata: {
      txHash: tx.txHash,
      value: amount,
      token: symbol,
      chain: addressInfo.chain,
      fromAddress,
      toAddress,
      txStatus: tx.txStatus,
    },
  };
}

export async function buildActivityFeed(users: User[]) {
  const feed: Array<{ user: User; activity: Activity }> = [];
  const diagnostics: AddressDiagnostic[] = [];

  for (const user of users) {
    for (const addressInfo of user.addresses) {
      try {
        const result = await fetchOkxTransactionsByAddress(addressInfo.address, addressInfo.chain);
        const transactions = result.ok ? result.transactions : [];

        diagnostics.push({
          userId: user.id,
          userName: user.name,
          address: addressInfo.address,
          addressName: addressInfo.name,
          chain: addressInfo.chain,
          ok: result.ok,
          transactionCount: transactions.length,
          error: result.error,
        });

        for (const tx of transactions) {
          feed.push({
            user,
            activity: convertToActivity(tx, user, addressInfo),
          });
        }
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
  };
}
