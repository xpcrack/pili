import type { Activity } from '@/types';
import { formatDisplayTradeAmount, normalizeDisplayTradeAmountText } from '@/lib/tradeDisplay';

function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

function encodeKeyPart(value: string | null | undefined) {
  return encodeURIComponent(normalize(value) || '-');
}

export interface BlockchainActivityIdentity {
  chain: string;
  trackedAddress: string;
  txHash: string;
  tokenIdentifier: string;
  actionIdentifier: string;
  amountIdentifier: string;
  scopedBaseKey: string;
  globalBaseKey: string;
  signatureSeed: string | null;
}

export function getBlockchainActivityIdentity(activity: Activity): BlockchainActivityIdentity | null {
  const chain = normalize(activity.metadata.chain);
  const trackedAddress = normalize(activity.metadata.trackedAddress);
  const txHash = normalize(activity.metadata.txHash);
  if (!chain || !trackedAddress || !txHash) {
    return null;
  }

  const tokenIdentifier = normalize(
    activity.metadata.displayTokenAvatarTokenAddress ||
      activity.metadata.tokenAddress ||
      activity.metadata.token ||
      activity.metadata.quoteToken
  );
  const actionIdentifier = normalize(
    activity.metadata.displayActionVariantLabel ||
      activity.metadata.txActionVariant ||
      activity.metadata.txActionLabel ||
      activity.metadata.txAction
  );
  const amountIdentifier = normalize(
    normalizeDisplayTradeAmountText(activity.metadata.displayTradeAmountText) ||
      formatDisplayTradeAmount(activity.metadata.quoteAmount, activity.metadata.quoteToken) ||
      formatDisplayTradeAmount(activity.metadata.value, activity.metadata.token)
  );

  const hasSignature = Boolean(tokenIdentifier || actionIdentifier || amountIdentifier);

  return {
    chain,
    trackedAddress,
    txHash,
    tokenIdentifier,
    actionIdentifier,
    amountIdentifier,
    scopedBaseKey: `${chain}:${trackedAddress}:${txHash}`,
    globalBaseKey: `${chain}:${txHash}`,
    signatureSeed: hasSignature ? [tokenIdentifier || '-', actionIdentifier || '-', amountIdentifier || '-'].join('|') : null,
  };
}

function buildSignatureSuffix(identity: BlockchainActivityIdentity) {
  if (!identity.signatureSeed) {
    return '';
  }

  return `:${encodeKeyPart(identity.tokenIdentifier)}:${encodeKeyPart(identity.actionIdentifier)}:${encodeKeyPart(identity.amountIdentifier)}`;
}

export function buildActivityScopedDedupKey(activity: Activity, userId?: string | null) {
  const tweetId = normalize(activity.metadata.tweetId);
  if (tweetId) {
    return `twitter:${tweetId}`;
  }

  const monitorAggregateKey = normalize(activity.metadata.monitorTxAggregateKey);
  if (monitorAggregateKey) {
    return monitorAggregateKey;
  }

  const blockchainIdentity = getBlockchainActivityIdentity(activity);
  if (blockchainIdentity) {
    return `${blockchainIdentity.scopedBaseKey}${buildSignatureSuffix(blockchainIdentity)}`;
  }

  const owner = normalize(userId) || normalize(activity.userId) || 'unknown-user';
  const activityId = normalize(activity.id) || `${Math.floor(activity.timestamp)}`;
  return `${owner}:${activityId}`;
}

export function buildActivityGlobalDedupKey(activity: Activity) {
  const tweetId = normalize(activity.metadata.tweetId);
  if (tweetId) {
    return `twitter:${tweetId}`;
  }

  const monitorAggregateKey = normalize(activity.metadata.monitorTxAggregateKey);
  if (monitorAggregateKey) {
    return monitorAggregateKey;
  }

  const blockchainIdentity = getBlockchainActivityIdentity(activity);
  if (blockchainIdentity) {
    return `${blockchainIdentity.globalBaseKey}${buildSignatureSuffix(blockchainIdentity)}`;
  }

  const activityId = normalize(activity.id) || `${Math.floor(activity.timestamp)}`;
  return `activity:${activityId}`;
}
