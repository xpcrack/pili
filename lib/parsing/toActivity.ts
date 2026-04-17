import { parseGroupedTransaction } from '@/lib/parsing/core';
import type { GroupedTransaction } from '@/lib/parsing/types';
import { Activity, ActivityType, User, type AddressInfo } from '@/types';

export type ParseClassification = 'normal' | 'suspicious' | 'poison';

interface ConvertToActivityParams {
  group: GroupedTransaction;
  user: User;
  addressInfo: AddressInfo;
  requireTrackedInitiator: boolean;
  classification?: ParseClassification;
}

export function isVisibleByDefault(classification: ParseClassification = 'normal') {
  return classification !== 'poison';
}

function buildTitle(params: {
  txAction: NonNullable<Activity['metadata']['txAction']>;
  rawType: string;
  targetMatchedTo: boolean;
  txStatus?: string;
}) {
  const { txAction, rawType, targetMatchedTo, txStatus } = params;

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

  return title;
}

function buildActionText(txAction: NonNullable<Activity['metadata']['txAction']>) {
  if (txAction === 'buy') {
    return '买入';
  }
  if (txAction === 'sell') {
    return '卖出';
  }
  if (txAction === 'receive') {
    return '收到';
  }
  return '发送';
}

export async function convertToActivity({
  group,
  user,
  addressInfo,
  requireTrackedInitiator,
  classification = 'normal',
}: ConvertToActivityParams): Promise<Activity | null> {
  const parsed = await parseGroupedTransaction({
    group,
    chain: addressInfo.chain,
    trackedAddress: addressInfo.address,
    requireTrackedInitiator,
  });

  if (!parsed || !isVisibleByDefault(classification)) {
    return null;
  }

  const type: ActivityType = 'transfer';
  const title = buildTitle({
    txAction: parsed.txAction,
    rawType: parsed.rawType,
    targetMatchedTo: parsed.addressMatch.targetMatchedTo,
    txStatus: parsed.txStatus,
  });
  const actionText = buildActionText(parsed.txAction);
  const quoteText = parsed.quoteAsset
    ? `，${parsed.txAction === 'sell' ? '获得' : '花费'} ${parsed.quoteAsset.amount} ${parsed.quoteAsset.token}`
    : '';

  return {
    id: `${user.id}-${group.txHash || parsed.timestamp}-${Math.random().toString(36).slice(2, 11)}`,
    userId: user.id,
    source: 'blockchain',
    type,
    title,
    content: `${actionText} ${parsed.primaryAsset.amount} ${parsed.primaryAsset.symbol}${quoteText}`,
    timestamp: parsed.timestamp,
    metadata: {
      txHash: parsed.txHash || parsed.representative.txHash,
      value: parsed.primaryAsset.amount,
      token: parsed.primaryAsset.symbol,
      tokenAddress: parsed.primaryAsset.tokenAddress,
      quoteToken: parsed.quoteAsset?.token,
      quoteAmount: parsed.quoteAsset?.amount,
      chain: addressInfo.chain,
      fromAddress: parsed.primaryAsset.fromAddress,
      toAddress: parsed.primaryAsset.toAddress,
      txStatus: parsed.txStatus,
      txAction: parsed.txAction,
      trackedAddress: addressInfo.address,
      uncertainFrom: parsed.addressMatch.uncertainFrom,
    },
  };
}
