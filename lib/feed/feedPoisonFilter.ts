import type { Activity } from '@/types';
import type { FeedItem } from '@/lib/feed/feedItemMerge';

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

export interface FeedDebugEntry {
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

function isCacheNativeDustPoison(item: FeedItem) {
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

function isCacheUncertainNativeReceivePoison(item: FeedItem) {
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

function isCacheUncertainLowValueTokenPoison(item: FeedItem) {
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

function isCacheUncertainUnknownTokenReceivePoison(item: FeedItem) {
  void item;
  return false;
}

function normalizeCacheTxHash(value: string | undefined) {
  const normalized = (value || '').trim();
  if (normalized.startsWith('0x') || normalized.startsWith('0X')) {
    return normalized.toLowerCase();
  }
  return normalized;
}

export function buildFeedDebugEntries(feed: FeedItem[], txHash: string) {
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

export function filterPoisonFromFeed(feed: FeedItem[]) {
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

  if (
    suspiciousTokenKeys.size === 0 &&
    suspiciousRepeatKeys.size === 0 &&
    suspiciousSenderKeys.size === 0
  ) {
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
