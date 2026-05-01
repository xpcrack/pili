import type { Activity, User } from '@/types';
import { buildActivityScopedDedupKey } from '@/lib/activityIdentity';

const MAX_PERSISTED_FEED_ITEMS = 3000;

export interface FeedItem {
  user: User;
  activity: Activity;
}

export function buildActivitiesByUser(feed: FeedItem[]) {
  const activitiesByUser = new Map<string, Activity[]>();
  feed.forEach(({ user, activity }) => {
    const existing = activitiesByUser.get(user.id) || [];
    activitiesByUser.set(user.id, [...existing, activity]);
  });
  return activitiesByUser;
}

export function filterFeedByExistingUsers(feed: FeedItem[], users: User[]) {
  const userIdSet = new Set(users.map((user) => user.id));
  return feed.filter((item) => userIdSet.has(item.user.id));
}

function getActivityDedupKey(item: FeedItem) {
  return buildActivityScopedDedupKey(item.activity, item.user.id);
}

function normalizeCacheAddress(value: string | undefined) {
  return (value || '').trim().toLowerCase();
}

function getActionPriority(action: Activity['metadata']['txAction']) {
  if (action === 'sell' || action === 'buy') return 4;
  if (action === 'send') return 3;
  if (action === 'receive') return 2;
  return 1;
}

function hasPositiveAmount(value: string | undefined) {
  const parsed = Number.parseFloat((value || '').trim());
  return Number.isFinite(parsed) && parsed > 0;
}

const CACHE_NATIVE_SYMBOLS_BY_CHAIN: Record<string, Set<string>> = {
  solana: new Set(['sol', 'wsol']),
  bsc: new Set(['bnb', 'wbnb']),
};

function isNativeTokenLike(activity: Activity) {
  const chain = normalizeCacheAddress(activity.metadata.chain);
  const symbol = normalizeCacheAddress(activity.metadata.token);
  if (!chain || !symbol) return false;
  return CACHE_NATIVE_SYMBOLS_BY_CHAIN[chain]?.has(symbol) ?? false;
}

function isIncomingLikeCacheAction(action: Activity['metadata']['txAction']) {
  return action === 'receive' || action === 'buy';
}

function isOutgoingLikeCacheAction(action: Activity['metadata']['txAction']) {
  return action === 'send' || action === 'sell';
}

function isNonNativeIncomingLikeToken(activity: Activity) {
  if (!isIncomingLikeCacheAction(activity.metadata.txAction)) return false;
  const hasAmount = hasPositiveAmount(activity.metadata.value);
  if (!hasAmount) return false;
  if (isNativeTokenLike(activity)) return false;
  const tokenAddress = normalizeCacheAddress(activity.metadata.tokenAddress);
  return Boolean(tokenAddress) || Boolean(normalizeCacheAddress(activity.metadata.token));
}

function isNonNativeOutgoingLikeToken(activity: Activity) {
  if (!isOutgoingLikeCacheAction(activity.metadata.txAction)) return false;
  const hasAmount = hasPositiveAmount(activity.metadata.value);
  if (!hasAmount) return false;
  if (isNativeTokenLike(activity)) return false;
  const tokenAddress = normalizeCacheAddress(activity.metadata.tokenAddress);
  return Boolean(tokenAddress) || Boolean(normalizeCacheAddress(activity.metadata.token));
}

function isNativeIncomingLikeToken(activity: Activity) {
  if (!isIncomingLikeCacheAction(activity.metadata.txAction)) return false;
  return hasPositiveAmount(activity.metadata.value) && isNativeTokenLike(activity);
}

function isNativeOutgoingLikeToken(activity: Activity) {
  if (!isOutgoingLikeCacheAction(activity.metadata.txAction)) return false;
  return hasPositiveAmount(activity.metadata.value) && isNativeTokenLike(activity);
}

function cloneWithAction(item: FeedItem, nextAction: NonNullable<Activity['metadata']['txAction']>) {
  return {
    ...item,
    activity: {
      ...item.activity,
      metadata: {
        ...item.activity.metadata,
        txAction: nextAction,
      },
    },
  } satisfies FeedItem;
}

function promoteTradeActionFromPair(left: FeedItem, right: FeedItem, selected: FeedItem) {
  if (isNonNativeOutgoingLikeToken(left.activity) && isNativeIncomingLikeToken(right.activity)) {
    return cloneWithAction(left, 'sell');
  }
  if (isNonNativeIncomingLikeToken(left.activity) && isNativeOutgoingLikeToken(right.activity)) {
    return cloneWithAction(left, 'buy');
  }
  if (isNonNativeOutgoingLikeToken(right.activity) && isNativeIncomingLikeToken(left.activity)) {
    return cloneWithAction(right, 'sell');
  }
  if (isNonNativeIncomingLikeToken(right.activity) && isNativeOutgoingLikeToken(left.activity)) {
    return cloneWithAction(right, 'buy');
  }

  return selected;
}

function chooseBetterTxRepresentative(current: FeedItem, candidate: FeedItem) {
  let selected: FeedItem;
  const currentActionPriority = getActionPriority(current.activity.metadata.txAction);
  const candidateActionPriority = getActionPriority(candidate.activity.metadata.txAction);
  if (candidateActionPriority !== currentActionPriority) {
    selected = candidateActionPriority > currentActionPriority ? candidate : current;
    return promoteTradeActionFromPair(current, candidate, selected);
  }

  const currentTokenAddress = normalizeCacheAddress(current.activity.metadata.tokenAddress);
  const candidateTokenAddress = normalizeCacheAddress(candidate.activity.metadata.tokenAddress);
  const currentHasTokenAddress = Boolean(currentTokenAddress);
  const candidateHasTokenAddress = Boolean(candidateTokenAddress);
  if (candidateHasTokenAddress !== currentHasTokenAddress) {
    selected = candidateHasTokenAddress ? candidate : current;
    return promoteTradeActionFromPair(current, candidate, selected);
  }

  const currentIsNative = isNativeTokenLike(current.activity);
  const candidateIsNative = isNativeTokenLike(candidate.activity);
  if (currentIsNative !== candidateIsNative) {
    selected = candidateIsNative ? current : candidate;
    return promoteTradeActionFromPair(current, candidate, selected);
  }

  const currentPositiveAmount = hasPositiveAmount(current.activity.metadata.value);
  const candidatePositiveAmount = hasPositiveAmount(candidate.activity.metadata.value);
  if (candidatePositiveAmount !== currentPositiveAmount) {
    selected = candidatePositiveAmount ? candidate : current;
    return promoteTradeActionFromPair(current, candidate, selected);
  }

  selected = candidate.activity.timestamp >= current.activity.timestamp ? candidate : current;
  return promoteTradeActionFromPair(current, candidate, selected);
}

export function mergeFeedItems(previous: FeedItem[], incoming: FeedItem[]) {
  const merged = new Map<string, FeedItem>();

  for (const item of [...previous, ...incoming]) {
    const key = getActivityDedupKey(item);
    const existing = merged.get(key);
    merged.set(key, existing ? chooseBetterTxRepresentative(existing, item) : item);
  }

  return Array.from(merged.values())
    .sort((a, b) => b.activity.timestamp - a.activity.timestamp)
    .slice(0, MAX_PERSISTED_FEED_ITEMS);
}
