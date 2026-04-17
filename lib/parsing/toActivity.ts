import type { Activity } from '@/types';

export type ParseClassification = 'normal' | 'suspicious' | 'poison';

export interface ToActivityInput {
  id?: string;
  userId: string;
  txHash: string;
  timestamp: number;
  chain: string;
  rawType: string;
  txStatus?: string;
  txAction: NonNullable<Activity['metadata']['txAction']>;
  value: string;
  token: string;
  tokenAddress: string;
  quoteToken?: string;
  quoteAmount?: string;
  fromAddress: string;
  toAddress: string;
  trackedAddress: string;
  uncertainFrom: boolean;
  classification?: ParseClassification;
}

function buildActivityTitle(input: ToActivityInput) {
  let title = input.txAction === 'receive' ? '收到转账' : '发送转账';

  if (input.rawType === '2') {
    title += ' (Token)';
  } else if (input.rawType === '1') {
    title += ' (合约)';
  } else if (input.rawType === '0') {
    title += ' (主链币)';
  }

  if (input.txAction === 'buy') {
    title = '买入资产';
  } else if (input.txAction === 'sell') {
    title = '卖出资产';
  }

  if (input.txStatus === 'fail') {
    title += ' [失败]';
  } else if (input.txStatus === 'pending') {
    title += ' [处理中]';
  }

  return title;
}

function buildActivityContent(input: ToActivityInput) {
  const actionText =
    input.txAction === 'buy'
      ? '买入'
      : input.txAction === 'sell'
        ? '卖出'
        : input.txAction === 'receive'
          ? '收到'
          : '发送';

  const quoteText =
    input.quoteAmount && input.quoteToken
      ? `，${input.txAction === 'sell' ? '获得' : '花费'} ${input.quoteAmount} ${input.quoteToken}`
      : '';

  return `${actionText} ${input.value} ${input.token}${quoteText}`;
}

function buildActivityId(input: ToActivityInput) {
  return input.id ?? `${input.userId}-${input.txHash || input.timestamp}-${Math.random().toString(36).slice(2, 11)}`;
}

export function toActivity(input: ToActivityInput): Activity {
  return {
    id: buildActivityId(input),
    userId: input.userId,
    source: 'blockchain',
    type: 'transfer',
    title: buildActivityTitle(input),
    content: buildActivityContent(input),
    timestamp: input.timestamp,
    metadata: {
      txHash: input.txHash,
      value: input.value,
      token: input.token,
      tokenAddress: input.tokenAddress,
      quoteToken: input.quoteToken,
      quoteAmount: input.quoteAmount,
      chain: input.chain,
      fromAddress: input.fromAddress,
      toAddress: input.toAddress,
      txStatus: input.txStatus,
      txAction: input.txAction,
      trackedAddress: input.trackedAddress,
      uncertainFrom: input.uncertainFrom,
    },
  };
}
