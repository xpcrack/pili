'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { User, Activity } from '@/types';
import { fetchAllActivities } from '@/lib/activitiesApi';
import {
  type ActivityFeedSummary,
  type AddressAssetSnapshot,
  type AddressDiagnostic,
  type UserAssetSnapshot,
} from '@/lib/activityFeed';
import { useUserStore } from '@/store/userStore';
import { useUsersDataStore } from '@/store/usersDataStore';

const REFRESH_TRIGGER_INTERVAL = 60 * 60 * 1000; // 1小时触发一次后台刷新
const SNAPSHOT_POLL_INTERVAL = 5 * 1000; // 每5秒读取一次本地快照，及时拿到后台刷新结果
const MAX_PERSISTED_FEED_ITEMS = 3000;
const USER_AUTO_BACKFILL_MAX_ROUNDS = 30;
const GLOBAL_AUTO_BACKFILL_MAX_ROUNDS = 8;

interface UseActivityPollingReturn {
  feed: { user: User; activity: Activity }[];
  userActivities: Map<string, Activity[]>;
  latestActivityAtByUser: Map<string, number>;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  historyComplete: boolean | null;
  localQualifiedCount: number;
  refetch: (options?: {
    targetCount?: number;
    selectedUserId?: string | null;
    searchQuery?: string;
    syncStrategy?: 'refresh' | 'local' | 'backfill';
    backfillScope?: 'global' | 'user';
  }) => Promise<{
    feedLength: number;
    selectedFeedLength: number;
    totalAvailable: number;
    success: boolean;
    error?: string;
    partialSyncWarning?: boolean;
    autoBackfillRounds?: number;
    hasMore?: boolean;
    historyComplete?: boolean | null;
    localQualifiedCount?: number;
  }>;
  lastUpdate: Date | null;
  summary: ActivityFeedSummary | null;
  diagnostics: AddressDiagnostic[];
}

interface FetchActivitiesOptions {
  targetCount?: number;
  selectedUserId?: string | null;
  searchQuery?: string;
  replace?: boolean;
  syncStrategy?: 'refresh' | 'local' | 'backfill';
  backfillScope?: 'global' | 'user';
}

interface PersistedFeedCache {
  savedAt: number;
  lastUpdate: number | null;
  feed: { user: User; activity: Activity }[];
  summary: ActivityFeedSummary | null;
  diagnostics: AddressDiagnostic[];
  addressAssets: AddressAssetSnapshot[];
  userAssets: UserAssetSnapshot[];
}
const CACHE_POISON_MIN_UNIQUE_RECIPIENTS = 3;
const CACHE_POISON_MIN_TRANSFER_COUNT = 3;
const CACHE_POISON_MAX_SENDER_ADDRESSES = 3;
const CACHE_POISON_REPEAT_MIN_TRANSFER_COUNT = 2;
const CACHE_POISON_REPEAT_TIME_WINDOW_MS = 48 * 60 * 60 * 1000;
const CACHE_POISON_SENDER_FANOUT_MIN_RECIPIENTS = 3;
const CACHE_POISON_SENDER_FANOUT_MIN_TRANSFERS = 3;

const CACHE_NATIVE_DUST_THRESHOLDS: Record<string, number> = {
  'solana|sol': 0.00002,
  'bsc|bnb': 0.00002,
};
const CACHE_NATIVE_UNCERTAIN_RECEIVE_MAX_AMOUNTS: Record<string, number> = {
  solana: 0.05,
  bsc: 0.005,
};
const CACHE_UNCERTAIN_LOW_VALUE_MAX_AMOUNTS: Record<string, number> = {
  solana: 0.1,
  bsc: 5,
};
const CACHE_NATIVE_SYMBOLS_BY_CHAIN: Record<string, Set<string>> = {
  solana: new Set(['sol', 'wsol']),
  bsc: new Set(['bnb', 'wbnb']),
};
const CACHE_SAFE_SYMBOLS = new Set(['sol', 'wsol', 'bnb', 'wbnb', 'usdt', 'usdc', 'dai']);

interface FeedDebugEntry {
  userId: string;
  userName: string;
  txHash: string;
  chain?: string;
  token?: string;
  tokenAddress?: string;
  value?: string;
  txAction?: Activity['metadata']['txAction'];
  uncertainFrom: boolean;
  matches: {
    nativeDust: boolean;
    uncertainNative: boolean;
    uncertainLowValueToken: boolean;
    uncertainUnknownToken: boolean;
  };
}

function buildActivitiesByUser(feed: { user: User; activity: Activity }[]) {
  const activitiesByUser = new Map<string, Activity[]>();
  feed.forEach(({ user, activity }) => {
    const existing = activitiesByUser.get(user.id) || [];
    activitiesByUser.set(user.id, [...existing, activity]);
  });
  return activitiesByUser;
}

function filterFeedByExistingUsers(feed: { user: User; activity: Activity }[], users: User[]) {
  const userIdSet = new Set(users.map((user) => user.id));
  return feed.filter((item) => userIdSet.has(item.user.id));
}

function getActivityDedupKey(item: { user: User; activity: Activity }) {
  const tweetId = item.activity.metadata?.tweetId?.toLowerCase();
  if (tweetId) {
    return `twitter:${tweetId}`;
  }
  const txHash = item.activity.metadata?.txHash?.toLowerCase();
  if (txHash) {
    return `${item.user.id}:${txHash}`;
  }
  return `${item.user.id}:${item.activity.timestamp}:${item.activity.title}:${item.activity.content}`;
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

function cloneWithAction(
  item: { user: User; activity: Activity },
  nextAction: NonNullable<Activity['metadata']['txAction']>
) {
  return {
    ...item,
    activity: {
      ...item.activity,
      metadata: {
        ...item.activity.metadata,
        txAction: nextAction,
      },
    },
  };
}

function promoteTradeActionFromPair(
  left: { user: User; activity: Activity },
  right: { user: User; activity: Activity },
  selected: { user: User; activity: Activity }
) {
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

function chooseBetterTxRepresentative(
  current: { user: User; activity: Activity },
  candidate: { user: User; activity: Activity }
) {
  let selected: { user: User; activity: Activity };
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

function mergeFeedItems(
  previous: { user: User; activity: Activity }[],
  incoming: { user: User; activity: Activity }[]
) {
  const merged = new Map<string, { user: User; activity: Activity }>();

  for (const item of [...previous, ...incoming]) {
    const key = getActivityDedupKey(item);
    const existing = merged.get(key);
    merged.set(key, existing ? chooseBetterTxRepresentative(existing, item) : item);
  }

  const mergedFeed = Array.from(merged.values())
    .sort((a, b) => b.activity.timestamp - a.activity.timestamp)
    .slice(0, MAX_PERSISTED_FEED_ITEMS);

  return mergedFeed;
}

function normalizeCacheAddress(value: string | undefined) {
  return (value || '').trim().toLowerCase();
}

function parseCachePositiveAmount(value: string | undefined) {
  const parsed = Number.parseFloat((value || '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function getCacheNativeDustThreshold(chain: string, tokenAddress: string, tokenSymbol: string) {
  if (!chain || tokenAddress || !tokenSymbol) {
    return null;
  }
  return CACHE_NATIVE_DUST_THRESHOLDS[`${chain}|${tokenSymbol}`] ?? null;
}

function isCacheNativeDustPoison(item: { user: User; activity: Activity }) {
  const { activity } = item;
  if (activity.source !== 'blockchain') return false;
  if (!activity.metadata.uncertainFrom) return false;

  const chain = normalizeCacheAddress(activity.metadata.chain);
  const tokenAddress = normalizeCacheAddress(activity.metadata.tokenAddress);
  const tokenSymbol = normalizeCacheAddress(activity.metadata.token);
  const dustThreshold = getCacheNativeDustThreshold(chain, tokenAddress, tokenSymbol);
  if (dustThreshold === null) return false;

  const amount = parseCachePositiveAmount(activity.metadata.value);
  if (amount === null) return false;

  return amount <= dustThreshold;
}

function isCacheUncertainNativeReceivePoison(item: { user: User; activity: Activity }) {
  const { activity } = item;
  if (activity.source !== 'blockchain') return false;
  if (!activity.metadata.uncertainFrom) return false;

  const chain = normalizeCacheAddress(activity.metadata.chain);
  const tokenSymbol = normalizeCacheAddress(activity.metadata.token);
  if (!chain) return false;
  const nativeSymbols = CACHE_NATIVE_SYMBOLS_BY_CHAIN[chain];
  if (!nativeSymbols || !nativeSymbols.has(tokenSymbol)) return false;

  const maxAmount = CACHE_NATIVE_UNCERTAIN_RECEIVE_MAX_AMOUNTS[chain];
  if (typeof maxAmount !== 'number') return false;

  const amount = parseCachePositiveAmount(activity.metadata.value);
  if (amount === null) return false;
  return amount <= maxAmount;
}

function isCacheUncertainLowValueTokenPoison(item: { user: User; activity: Activity }) {
  const { activity } = item;
  if (activity.source !== 'blockchain') return false;
  if (!activity.metadata.uncertainFrom) return false;

  const chain = normalizeCacheAddress(activity.metadata.chain);
  const tokenSymbol = normalizeCacheAddress(activity.metadata.token);
  if (!chain || !tokenSymbol) return false;
  if (CACHE_SAFE_SYMBOLS.has(tokenSymbol)) return false;

  const maxAmount = CACHE_UNCERTAIN_LOW_VALUE_MAX_AMOUNTS[chain];
  if (typeof maxAmount !== 'number') return false;
  const amount = parseCachePositiveAmount(activity.metadata.value);
  if (amount === null) return false;
  return amount <= maxAmount;
}

function isCacheUncertainUnknownTokenReceivePoison(item: { user: User; activity: Activity }) {
  void item;
  // 与服务端过滤保持一致：未知 symbol 不再单独判投毒。
  return false;
}

function normalizeCacheTxHash(value: string | undefined) {
  const normalized = (value || '').trim();
  if (normalized.startsWith('0x') || normalized.startsWith('0X')) {
    return normalized.toLowerCase();
  }
  return normalized;
}

function buildFeedDebugEntries(feed: { user: User; activity: Activity }[], txHash: string) {
  const normalizedTxHash = normalizeCacheTxHash(txHash);
  return feed
    .filter((item) => normalizeCacheTxHash(item.activity.metadata.txHash) === normalizedTxHash)
    .map((item): FeedDebugEntry => ({
      userId: item.user.id,
      userName: item.user.name,
      txHash: item.activity.metadata.txHash || '',
      chain: item.activity.metadata.chain,
      token: item.activity.metadata.token,
      tokenAddress: item.activity.metadata.tokenAddress,
      value: item.activity.metadata.value,
      txAction: item.activity.metadata.txAction,
      uncertainFrom: Boolean(item.activity.metadata.uncertainFrom),
      matches: {
        nativeDust: isCacheNativeDustPoison(item),
        uncertainNative: isCacheUncertainNativeReceivePoison(item),
        uncertainLowValueToken: isCacheUncertainLowValueTokenPoison(item),
        uncertainUnknownToken: isCacheUncertainUnknownTokenReceivePoison(item),
      },
    }));
}

function filterPoisonFromFeed(feed: { user: User; activity: Activity }[]) {
  const tokenStats = new Map<
    string,
    {
      transferCount: number;
      recipientUsers: Set<string>;
      senderAddresses: Set<string>;
      amounts: number[];
    }
  >();
  const repeatStats = new Map<
    string,
    {
      chain: string;
      tokenAddress: string;
      tokenSymbol: string;
      transferCount: number;
      senderAddresses: Set<string>;
      amounts: number[];
      minTimestamp: number;
      maxTimestamp: number;
    }
  >();
  const senderFanOutStats = new Map<
    string,
    {
      transferCount: number;
      recipientUsers: Set<string>;
    }
  >();

  for (const item of feed) {
    const { activity } = item;
    if (activity.source !== 'blockchain') continue;
    if (activity.metadata.txAction !== 'receive') continue;
    if (!activity.metadata.uncertainFrom) continue;

    const chain = normalizeCacheAddress(activity.metadata.chain);
    const tokenAddress = normalizeCacheAddress(activity.metadata.tokenAddress);
    const tokenSymbol = normalizeCacheAddress(activity.metadata.token);
    const token = tokenAddress || tokenSymbol;
    if (!chain || !token) continue;

    const tokenKey = `${chain}|${token}`;
    const tokenExisting = tokenStats.get(tokenKey) ?? {
      transferCount: 0,
      recipientUsers: new Set<string>(),
      senderAddresses: new Set<string>(),
      amounts: [],
    };
    tokenExisting.transferCount += 1;
    tokenExisting.recipientUsers.add(item.user.id);
    const fromAddress = normalizeCacheAddress(activity.metadata.fromAddress);
    if (fromAddress) tokenExisting.senderAddresses.add(fromAddress);
    const amount = parseCachePositiveAmount(activity.metadata.value);
    if (amount !== null) tokenExisting.amounts.push(amount);
    tokenStats.set(tokenKey, tokenExisting);

    if (fromAddress) {
      const recipientAddress = normalizeCacheAddress(activity.metadata.toAddress) || item.user.id;
      const repeatKey = `${chain}|${token}|${fromAddress}|${recipientAddress}`;
      const repeatExisting = repeatStats.get(repeatKey) ?? {
        chain,
        tokenAddress,
        tokenSymbol,
        transferCount: 0,
        senderAddresses: new Set<string>(),
        amounts: [],
        minTimestamp: activity.timestamp,
        maxTimestamp: activity.timestamp,
      };
      repeatExisting.transferCount += 1;
      repeatExisting.senderAddresses.add(fromAddress);
      if (amount !== null) repeatExisting.amounts.push(amount);
      repeatExisting.minTimestamp = Math.min(repeatExisting.minTimestamp, activity.timestamp);
      repeatExisting.maxTimestamp = Math.max(repeatExisting.maxTimestamp, activity.timestamp);
      repeatStats.set(repeatKey, repeatExisting);
    }

    if (chain && fromAddress) {
      const senderKey = `${chain}|${fromAddress}`;
      const fanOutExisting = senderFanOutStats.get(senderKey) ?? {
        transferCount: 0,
        recipientUsers: new Set<string>(),
      };
      fanOutExisting.transferCount += 1;
      fanOutExisting.recipientUsers.add(item.user.id);
      senderFanOutStats.set(senderKey, fanOutExisting);
    }
  }

  const suspiciousTokenKeys = new Set(
    Array.from(tokenStats.entries())
      .filter(([, value]) => {
        const hasFanOut =
          value.transferCount >= CACHE_POISON_MIN_TRANSFER_COUNT &&
          value.recipientUsers.size >= CACHE_POISON_MIN_UNIQUE_RECIPIENTS;
        if (!hasFanOut) return false;
        const hasSenderPattern =
          value.senderAddresses.size > 0 && value.senderAddresses.size <= CACHE_POISON_MAX_SENDER_ADDRESSES;
        const amountSpreadRatio =
          value.amounts.length >= 2 ? Math.max(...value.amounts) / Math.min(...value.amounts) : null;
        const hasAmountPattern = typeof amountSpreadRatio === 'number' ? amountSpreadRatio <= 1.03 : false;
        return hasSenderPattern || hasAmountPattern;
      })
      .map(([key]) => key)
  );

  const suspiciousRepeatKeys = new Set(
    Array.from(repeatStats.entries())
      .filter(([, value]) => {
        if (value.transferCount < CACHE_POISON_REPEAT_MIN_TRANSFER_COUNT) return false;
        const dustThreshold = getCacheNativeDustThreshold(value.chain, value.tokenAddress, value.tokenSymbol);
        if (dustThreshold === null || value.amounts.length < CACHE_POISON_REPEAT_MIN_TRANSFER_COUNT) {
          return false;
        }
        if (Math.max(...value.amounts) > dustThreshold) return false;
        if (value.maxTimestamp - value.minTimestamp > CACHE_POISON_REPEAT_TIME_WINDOW_MS) return false;
        return true;
      })
      .map(([key]) => key)
  );
  const suspiciousSenderKeys = new Set(
    Array.from(senderFanOutStats.entries())
      .filter(([, value]) =>
        value.transferCount >= CACHE_POISON_SENDER_FANOUT_MIN_TRANSFERS &&
        value.recipientUsers.size >= CACHE_POISON_SENDER_FANOUT_MIN_RECIPIENTS
      )
      .map(([key]) => key)
  );

  if (suspiciousTokenKeys.size === 0 && suspiciousRepeatKeys.size === 0) {
    return feed;
  }

  return feed.filter((item) => {
    if (
      isCacheNativeDustPoison(item) ||
      isCacheUncertainNativeReceivePoison(item) ||
      isCacheUncertainLowValueTokenPoison(item) ||
      isCacheUncertainUnknownTokenReceivePoison(item)
    ) return false;

    const { activity } = item;
    if (activity.source !== 'blockchain') return true;
    if (activity.metadata.txAction !== 'receive') return true;
    if (!activity.metadata.uncertainFrom) return true;

    const chain = normalizeCacheAddress(activity.metadata.chain);
    const tokenAddress = normalizeCacheAddress(activity.metadata.tokenAddress);
    const tokenSymbol = normalizeCacheAddress(activity.metadata.token);
    const token = tokenAddress || tokenSymbol;
    const fromAddress = normalizeCacheAddress(activity.metadata.fromAddress);
    if (!chain || !token) return true;

    const tokenKey = `${chain}|${token}`;
    const recipientAddress = normalizeCacheAddress(activity.metadata.toAddress) || item.user.id;
    const repeatKey = fromAddress ? `${chain}|${token}|${fromAddress}|${recipientAddress}` : '';
    const senderKey = fromAddress ? `${chain}|${fromAddress}` : '';
    if (suspiciousTokenKeys.has(tokenKey)) return false;
    if (repeatKey && suspiciousRepeatKeys.has(repeatKey)) return false;
    if (senderKey && suspiciousSenderKeys.has(senderKey)) return false;
    return true;
  });
}

function readFeedCache(): PersistedFeedCache | null {
  return null;
}

export function useActivityPolling(
  activeSelectedUserId?: string | null,
  activeSearchQuery?: string
): UseActivityPollingReturn {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<{ user: User; activity: Activity }[]>([]);
  const [userActivities, setUserActivities] = useState<Map<string, Activity[]>>(new Map());
  const [latestActivityAtByUser, setLatestActivityAtByUser] = useState<Map<string, number>>(new Map());
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [summary, setSummary] = useState<ActivityFeedSummary | null>(null);
  const [diagnostics, setDiagnostics] = useState<AddressDiagnostic[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [historyComplete, setHistoryComplete] = useState<boolean | null>(null);
  const [localQualifiedCount, setLocalQualifiedCount] = useState(0);
  
  const { checkAndUpdateNewStatus } = useUserStore();
  const { users, upsertUserAssetSnapshot } = useUsersDataStore();
  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const snapshotPollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const judgmentStreamRef = useRef<EventSource | null>(null);
  const judgmentVersionRef = useRef<number>(0);
  const sseRefetchingRef = useRef(false);
  const isMountedRef = useRef(false);
  const requestIdRef = useRef(0);
  const isFetchingRef = useRef(false);
  const pendingRefetchRef = useRef(false);
  const pendingRefetchOptionsRef = useRef<FetchActivitiesOptions | undefined>(undefined);
  const hydratedFromCacheRef = useRef(false);
  const feedRef = useRef<{ user: User; activity: Activity }[]>([]);
  const usersRef = useRef(users);
  const activeSelectedUserIdRef = useRef<string | null>(activeSelectedUserId ?? null);
  const activeSearchQueryRef = useRef((activeSearchQuery || '').trim());
  const usersFingerprintRef = useRef('');
  const searchFingerprintRef = useRef((activeSearchQuery || '').trim());
  const usersFingerprint = useMemo(
    () => users.map((user) => `${user.id}:${user.addresses.length}`).join('|'),
    [users]
  );

  useEffect(() => {
    usersRef.current = users;
  }, [users]);

  useEffect(() => {
    activeSelectedUserIdRef.current = activeSelectedUserId ?? null;
  }, [activeSelectedUserId]);

  useEffect(() => {
    activeSearchQueryRef.current = (activeSearchQuery || '').trim();
  }, [activeSearchQuery]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const target = window as Window & {
      __feedDebug?: {
        findTx: (txHash: string) => {
          raw: FeedDebugEntry[];
          visibleAfterFilter: boolean;
          filtered: FeedDebugEntry[];
        };
      };
    };

    target.__feedDebug = {
      findTx: (txHash: string) => {
        const rawEntries = buildFeedDebugEntries(feedRef.current, txHash);
        const filteredFeed = filterPoisonFromFeed(feedRef.current);
        const filteredEntries = buildFeedDebugEntries(filteredFeed, txHash);
        return {
          raw: rawEntries,
          visibleAfterFilter: filteredEntries.length > 0,
          filtered: filteredEntries,
        };
      },
    };

    return () => {
      delete target.__feedDebug;
    };
  }, []);

  const applyNewStatusForActivities = useCallback(
    (activitiesByUser: Map<string, Activity[]>) => {
      activitiesByUser.forEach((activities, userId) => {
        const sorted = [...activities].sort((a, b) => b.timestamp - a.timestamp);
        const latestTime = sorted[0]?.timestamp || 0;
        checkAndUpdateNewStatus(userId, latestTime);
      });
    },
    [checkAndUpdateNewStatus]
  );

  // 获取并处理活动数据
  const fetchActivities = useCallback(async (
    options?: FetchActivitiesOptions
  ): Promise<{
    feedLength: number;
    selectedFeedLength: number;
    totalAvailable: number;
    success: boolean;
    error?: string;
    partialSyncWarning?: boolean;
    autoBackfillRounds?: number;
    hasMore?: boolean;
    historyComplete?: boolean | null;
    localQualifiedCount?: number;
  }> => {
    const targetCount = options?.targetCount;
    const hasSelectedUserOption =
      options && Object.prototype.hasOwnProperty.call(options, 'selectedUserId');
    const selectedUserId = hasSelectedUserOption
      ? options?.selectedUserId ?? null
      : activeSelectedUserIdRef.current ?? null;
    const searchQuery =
      typeof options?.searchQuery === 'string' ? options.searchQuery.trim() : activeSearchQueryRef.current;
    const replace = options?.replace === true;
    const syncStrategy = options?.syncStrategy ?? (typeof targetCount === 'number' ? 'local' : 'refresh');
    const backfillScope = options?.backfillScope ?? (selectedUserId ? 'user' : 'global');
    const currentSelectedFeedLength = selectedUserId
      ? feedRef.current.filter((item) => item.user.id === selectedUserId).length
      : feedRef.current.length;

    if (isFetchingRef.current) {
      pendingRefetchRef.current = true;
      pendingRefetchOptionsRef.current = options
        ? { ...options }
        : { selectedUserId: activeSelectedUserIdRef.current };
      console.log('[fetchActivities] 已在请求中，跳过');
        return {
          feedLength: feedRef.current.length,
          selectedFeedLength: currentSelectedFeedLength,
          totalAvailable: Math.max(feedRef.current.length, summary?.transactionCount ?? 0),
          success: false,
          error: '请求进行中',
          partialSyncWarning: false,
          autoBackfillRounds: 0,
          hasMore,
          historyComplete,
          localQualifiedCount,
        };
    }

    isFetchingRef.current = true;
    pendingRefetchRef.current = false;
    const requestId = ++requestIdRef.current;
    const currentUsers = usersRef.current;

    console.log('[fetchActivities] 开始请求，users 数量:', currentUsers.length, '严格模式: true');

    try {
      if (isMountedRef.current) {
        setLoading(true);
      }

      if (currentUsers.length === 0) {
        if (!isMountedRef.current || requestId !== requestIdRef.current) {
          return {
            feedLength: feedRef.current.length,
            selectedFeedLength: currentSelectedFeedLength,
            totalAvailable: Math.max(feedRef.current.length, summary?.transactionCount ?? 0),
            success: false,
            error: '请求状态已过期',
            partialSyncWarning: false,
            autoBackfillRounds: 0,
          };
        }

        console.log('[fetchActivities] users 为空，清空所有数据');
        feedRef.current = [];
        setFeed([]);
        setUserActivities(new Map());
        setLatestActivityAtByUser(new Map());
        setSummary({
          userCount: 0,
          addressCount: 0,
          transactionCount: 0,
          successfulAddressCount: 0,
          failedAddressCount: 0,
          emptyAddressCount: 0,
          completedAt: Date.now(),
        });
        setDiagnostics([]);
        setHasMore(false);
        setHistoryComplete(null);
        setLocalQualifiedCount(0);
        setLastUpdate(new Date());
        setError(null);
        return {
          feedLength: 0,
          selectedFeedLength: 0,
          totalAvailable: 0,
          success: true,
          autoBackfillRounds: 0,
          hasMore: false,
          historyComplete: null,
          localQualifiedCount: 0,
        };
      }

      const requestLimit = selectedUserId
        ? Math.max(targetCount ?? 50, 1)
        : Math.max(targetCount ?? 200, 200);
      console.log('[fetchActivities] 开始从 API 获取数据，strategy:', syncStrategy);

      const requestFeed = async (strategy: 'refresh' | 'local' | 'backfill') =>
        fetchAllActivities(currentUsers, {
          page: 1,
          pageSize: requestLimit,
          userId: selectedUserId,
          search: searchQuery,
          syncStrategy: strategy,
          backfillScope: strategy === 'backfill' ? backfillScope : undefined,
          backfillUserId: selectedUserId,
          reason:
            strategy === 'backfill'
              ? selectedUserId
                ? 'expand-user-backfill-7d'
                : 'expand-global-backfill-7d'
              : strategy === 'refresh'
                ? 'feed-refresh'
                : 'feed-local-read',
        });

      let result = await requestFeed(syncStrategy);
      let autoBackfillRounds = 0;

      if (syncStrategy === 'local' && typeof targetCount === 'number' && !searchQuery) {
        let loadedCount = result.total;

        const maxRounds = selectedUserId ? USER_AUTO_BACKFILL_MAX_ROUNDS : GLOBAL_AUTO_BACKFILL_MAX_ROUNDS;
        while (
          loadedCount < targetCount &&
          autoBackfillRounds < maxRounds &&
          (selectedUserId ? result.historyComplete !== true : true)
        ) {
          autoBackfillRounds += 1;
          console.log(
            `[fetchActivities] 本地数据不足，触发自动 backfill 第 ${autoBackfillRounds}/${maxRounds} 轮`
          );
          result = await requestFeed('backfill');
          loadedCount = result.total;
        }
      }

      // 服务端 feed 快照是权威源；默认以服务端结果替换，避免前端残留已删除交易。
      const serverMergedFeed = replace ? result.feed : mergeFeedItems([], result.feed);
      // 用户删除后立刻过滤本地不可见人物，避免历史动态残留。
      const mergedFeed = filterFeedByExistingUsers(serverMergedFeed, currentUsers);

      if (!isMountedRef.current || requestId !== requestIdRef.current) {
        console.log('[fetchActivities] 组件已卸载或请求过期，放弃更新');
        return {
          feedLength: feedRef.current.length,
          selectedFeedLength: currentSelectedFeedLength,
          totalAvailable: Math.max(feedRef.current.length, summary?.transactionCount ?? 0),
          success: false,
          error: '请求状态已过期',
          partialSyncWarning: false,
          autoBackfillRounds: 0,
          hasMore,
          historyComplete,
          localQualifiedCount,
        };
      }

      console.log('[fetchActivities] API 返回', result.feed.length, '条数据，合并后', mergedFeed.length, '条');
      feedRef.current = mergedFeed;
      setFeed(mergedFeed);
      setSummary(result.summary);
      setDiagnostics(result.diagnostics);
      setHasMore(result.hasMore);
      setHistoryComplete(result.historyComplete);
      setLocalQualifiedCount(result.localQualifiedCount);

      // Debug: Check if feed is being filtered by client-side poison detection
      const poisonFilteredFeed = filterPoisonFromFeed(mergedFeed);
      if (poisonFilteredFeed.length !== mergedFeed.length) {
        console.warn('[fetchActivities] 客户端投毒过滤统计:', {
          feedBeforeFilter: mergedFeed.length,
          feedAfterFilter: poisonFilteredFeed.length,
          filteredCount: mergedFeed.length - poisonFilteredFeed.length,
        });
      }
      result.userAssets.forEach((userAsset) => {
        upsertUserAssetSnapshot(userAsset.userId, {
          updatedAt: userAsset.updatedAt,
          addresses: result.addressAssets
            .filter((addressAsset) => addressAsset.userId === userAsset.userId)
            .map((addressAsset) => ({
              address: addressAsset.address,
              totalAssetUsd: addressAsset.totalAssetUsd,
              updatedAt: addressAsset.updatedAt,
            })),
        });
      });

      // 聚合每个用户的活动
      const activitiesByUser = buildActivitiesByUser(mergedFeed);
      setUserActivities(activitiesByUser);
      const latestMap = new Map<string, number>();
      if (result.latestActivityAtByUser) {
        Object.entries(result.latestActivityAtByUser).forEach(([userId, ts]) => {
          if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
            latestMap.set(userId, ts);
          }
        });
      }
      setLatestActivityAtByUser(latestMap);

      // 更新每个用户的红点状态
      applyNewStatusForActivities(activitiesByUser);

      const now = new Date();
      setLastUpdate(now);
      setError(null);
      const mergedSelectedFeedLength = selectedUserId
        ? mergedFeed.filter((item) => item.user.id === selectedUserId).length
        : mergedFeed.length;
      const partialSyncWarning = Boolean(
        result.sync?.latestRun &&
          typeof result.sync.latestRun.failedAddresses === 'number' &&
          result.sync.latestRun.failedAddresses > 0
      );
      return {
        feedLength: mergedFeed.length,
        selectedFeedLength: mergedSelectedFeedLength,
        totalAvailable: mergedFeed.length,
        success: true,
        partialSyncWarning,
        autoBackfillRounds,
        hasMore: result.hasMore,
        historyComplete: result.historyComplete,
        localQualifiedCount: result.localQualifiedCount,
      };
    } catch (err) {
      if (!isMountedRef.current || requestId !== requestIdRef.current) {
        return {
          feedLength: feedRef.current.length,
          selectedFeedLength: currentSelectedFeedLength,
          totalAvailable: Math.max(feedRef.current.length, summary?.transactionCount ?? 0),
          success: false,
          error: '请求状态已过期',
          partialSyncWarning: false,
          autoBackfillRounds: 0,
          hasMore,
          historyComplete,
          localQualifiedCount,
        };
      }

      const message = err instanceof Error ? err.message : '获取数据失败';
      setError(message);
      feedRef.current = [];
      setFeed([]);
      setUserActivities(new Map());
      setLatestActivityAtByUser(new Map());
      setSummary(null);
      setDiagnostics([]);
      setHasMore(false);
      setHistoryComplete(null);
      setLocalQualifiedCount(0);
      console.warn('拉取失败（严格模式，未兜底）:', err);
      return {
        feedLength: feedRef.current.length,
        selectedFeedLength: currentSelectedFeedLength,
        totalAvailable: Math.max(feedRef.current.length, summary?.transactionCount ?? 0),
        success: false,
        error: message,
        partialSyncWarning: false,
        autoBackfillRounds: 0,
        hasMore: false,
        historyComplete: null,
        localQualifiedCount: 0,
      };
    } finally {
      isFetchingRef.current = false;
      if (isMountedRef.current && requestId === requestIdRef.current) {
        setLoading(false);
      }

      if (pendingRefetchRef.current && isMountedRef.current) {
        pendingRefetchRef.current = false;
        const pendingOptions = pendingRefetchOptionsRef.current;
        pendingRefetchOptionsRef.current = undefined;
        void fetchActivities(
          pendingOptions ?? {
            selectedUserId: activeSelectedUserIdRef.current,
            searchQuery: activeSearchQueryRef.current,
          }
        );
      }
    }
  }, [
    applyNewStatusForActivities,
    hasMore,
    historyComplete,
    localQualifiedCount,
    summary?.transactionCount,
    upsertUserAssetSnapshot,
  ]);

  // 初始获取 - 先从缓存恢复，再发起请求
  useEffect(() => {
    isMountedRef.current = true;

    // 严格模式：不从本地缓存恢复，始终以本次 API 为准
    if (!hydratedFromCacheRef.current) {
      hydratedFromCacheRef.current = true;
      const cached = readFeedCache();
      void cached;
    }

    usersFingerprintRef.current = usersRef.current
      .map((user) => `${user.id}:${user.addresses.length}`)
      .join('|');
    void fetchActivities({
      selectedUserId: activeSelectedUserIdRef.current,
      searchQuery: activeSearchQueryRef.current,
    });

    return () => {
      isMountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, [fetchActivities, applyNewStatusForActivities, upsertUserAssetSnapshot]);

  useEffect(() => {
    if (!isMountedRef.current) {
      return;
    }

    if (usersFingerprint === usersFingerprintRef.current) {
      return;
    }

    usersFingerprintRef.current = usersFingerprint;
    void fetchActivities({
      replace: true,
      selectedUserId: activeSelectedUserIdRef.current,
      searchQuery: activeSearchQueryRef.current,
    });
  }, [usersFingerprint, fetchActivities]);

  useEffect(() => {
    if (!isMountedRef.current) {
      return;
    }

    const nextSearchFingerprint = (activeSearchQuery || '').trim();
    if (searchFingerprintRef.current === nextSearchFingerprint) {
      return;
    }

    searchFingerprintRef.current = nextSearchFingerprint;
    void fetchActivities({
      replace: true,
      selectedUserId: activeSelectedUserIdRef.current,
      searchQuery: nextSearchFingerprint,
    });
  }, [activeSearchQuery, fetchActivities]);

  // 高频本地快照轮询：不触发后台同步，只读取最新快照。
  useEffect(() => {
    snapshotPollIntervalRef.current = setInterval(() => {
      void fetchActivities({
        syncStrategy: 'local',
        selectedUserId: activeSelectedUserIdRef.current,
        searchQuery: activeSearchQueryRef.current,
      });
    }, SNAPSHOT_POLL_INTERVAL);

    return () => {
      if (snapshotPollIntervalRef.current) {
        clearInterval(snapshotPollIntervalRef.current);
      }
    };
  }, [fetchActivities]);

  // 低频后台刷新触发：维持原有周期性全量同步能力。
  useEffect(() => {
    refreshIntervalRef.current = setInterval(() => {
      void fetchActivities({
        syncStrategy: 'refresh',
        selectedUserId: activeSelectedUserIdRef.current,
        searchQuery: activeSearchQueryRef.current,
      });
    }, REFRESH_TRIGGER_INTERVAL);

    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
      }
    };
  }, [fetchActivities]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const stream = new EventSource('/api/debug/tx-judgment/stream');
    judgmentStreamRef.current = stream;

    stream.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { type?: string; version?: number };
        if (!payload || typeof payload.version !== 'number') {
          return;
        }
        if (payload.type === 'hello') {
          judgmentVersionRef.current = payload.version;
          return;
        }
        if (payload.type !== 'updated') {
          return;
        }
        if (payload.version === judgmentVersionRef.current) {
          return;
        }
        judgmentVersionRef.current = payload.version;
        if (sseRefetchingRef.current) {
          return;
        }
        sseRefetchingRef.current = true;
        void fetchActivities({
          selectedUserId: activeSelectedUserIdRef.current,
          searchQuery: activeSearchQueryRef.current,
        }).finally(() => {
          sseRefetchingRef.current = false;
        });
      } catch {
        // ignore malformed events
      }
    };

    stream.onerror = () => {
      // browser EventSource auto-reconnects
    };

    return () => {
      stream.close();
      if (judgmentStreamRef.current === stream) {
        judgmentStreamRef.current = null;
      }
    };
  }, [fetchActivities]);

  return {
    feed,
    userActivities,
    latestActivityAtByUser,
    loading,
    error,
    hasMore,
    historyComplete,
    localQualifiedCount,
    refetch: (options?: {
      targetCount?: number;
      selectedUserId?: string | null;
      searchQuery?: string;
      syncStrategy?: 'refresh' | 'local' | 'backfill';
      backfillScope?: 'global' | 'user';
    }) => {
      return fetchActivities({ ...options, replace: true });
    },
    lastUpdate,
    summary,
    diagnostics,
  };
}
