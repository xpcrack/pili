import {
  type AddressInfo,
  type CanonicalAddress,
  type CanonicalEvent,
  type CanonicalTradeAction,
  type CanonicalUser,
  type ChainType,
  type Activity,
  type User,
} from '@/types';

function parseAmount(value: string | number | null | undefined) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.trim().replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeUrlLike(value: string | undefined | null) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function normalizeTwitterHandle(input?: string | null) {
  if (!input) return '';

  const trimmed = input.trim();
  if (!trimmed) {
    return '';
  }

  const withoutProtocol = trimmed.replace(/^https?:\/\//i, '');
  const withoutDomain = withoutProtocol.replace(/^(www\.)?(x|twitter)\.com\//i, '');
  const withoutAt = withoutDomain.replace(/^@/, '');

  return withoutAt.split('/')[0].split('?')[0].trim();
}

export function normalizeTwitterUrl(input?: string | null) {
  const raw = normalizeUrlLike(input);
  if (!raw) {
    return null;
  }

  const handle = normalizeTwitterHandle(raw);
  if (!handle) {
    return null;
  }

  return `https://x.com/${handle}`;
}

export function normalizeTelegramUrl(input?: string | null) {
  const raw = normalizeUrlLike(input);
  if (!raw) {
    return null;
  }

  const webTelegramHandleMatch = raw.match(/web\.telegram\.org\/[ak]\/#[^@]*@([A-Za-z0-9_]{3,})/i);
  if (webTelegramHandleMatch?.[1]) {
    return `https://t.me/${webTelegramHandleMatch[1]}`;
  }

  if (/web\.telegram\.org\//i.test(raw)) {
    return null;
  }

  const trimmed = raw.replace(/^https?:\/\//i, '').replace(/^t\.me\//i, '').replace(/^@/, '').trim();
  if (!trimmed) {
    return null;
  }

  return `https://t.me/${trimmed.split('/')[0].split('?')[0]}`;
}

export function extractTwitterHandleFromUrl(input?: string | null) {
  const url = normalizeTwitterUrl(input);
  if (!url) {
    return '';
  }
  return normalizeTwitterHandle(url);
}

export function extractTelegramHandleFromUrl(input?: string | null) {
  const url = normalizeTelegramUrl(input);
  if (!url) {
    return '';
  }

  return url.replace(/^https?:\/\/t\.me\//i, '').trim();
}

function synthesizeHandle(name: string, userId: string) {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^-\p{L}\p{N}_]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (normalized) {
    return normalized;
  }

  return `user-${userId.slice(0, 8)}`;
}

function amountUsdFromActivity(activity: Activity) {
  if (
    (activity.metadata.txAction === 'buy' || activity.metadata.txAction === 'sell') &&
    typeof activity.metadata.tradeAmountUsdAtTx === 'number' &&
    Number.isFinite(activity.metadata.tradeAmountUsdAtTx) &&
    activity.metadata.tradeAmountUsdAtTx > 0
  ) {
    return activity.metadata.tradeAmountUsdAtTx;
  }

  const tokenSymbol = (activity.metadata.token || '').trim().toUpperCase();
  const quoteToken = (activity.metadata.quoteToken || '').trim().toUpperCase();
  const tokenAmount = parseAmount(activity.metadata.value);
  const quoteAmount = parseAmount(activity.metadata.quoteAmount);

  if ((quoteToken === 'USDT' || quoteToken === 'USDC' || quoteToken === 'DAI') && quoteAmount !== null) {
    return quoteAmount;
  }

  if ((tokenSymbol === 'USDT' || tokenSymbol === 'USDC' || tokenSymbol === 'DAI') && tokenAmount !== null) {
    return tokenAmount;
  }

  return null;
}

function tradeActionFromActivity(activity: Activity): CanonicalTradeAction | null {
  const variant = activity.metadata.txActionVariant;
  if (variant === 'open' || variant === 'add' || variant === 'reduce' || variant === 'close') {
    return variant;
  }

  const label = activity.metadata.txActionLabel;
  if (label === '建仓') return 'open';
  if (label === '加仓') return 'add';
  if (label === '减仓') return 'reduce';
  if (label === '清仓') return 'close';

  if (activity.metadata.txAction === 'buy') {
    return 'open';
  }
  if (activity.metadata.txAction === 'sell') {
    return 'reduce';
  }

  return null;
}

function toCanonicalChain(chain: string | undefined): ChainType | null {
  return chain === 'bsc' || chain === 'solana' || chain === 'ethereum' || chain === 'base' ? chain : null;
}

export function legacyAddressToCanonical(userId: string, address: AddressInfo): CanonicalAddress {
  const normalizedAddress = address.address.trim().toLowerCase();
  return {
    id: `${userId}:${address.chain}:${normalizedAddress}`,
    userId,
    address: address.address,
    chain: address.chain,
  };
}

export function legacyUserToCanonical(user: User, hasUnread = false): CanonicalUser {
  return {
    id: user.id,
    name: user.name,
    avatar: user.avatar,
    currentBalanceUsd: typeof user.totalAssetUsd === 'number' ? user.totalAssetUsd : 0,
    maxBalanceUsd: typeof user.historicalMaxAssetUsd === 'number' ? user.historicalMaxAssetUsd : 0,
    hasUnread,
    twitterUrl: normalizeTwitterUrl(user.twitter),
    telegramUrl: normalizeTelegramUrl(user.telegram),
  };
}

export function canonicalUserToLegacy(user: CanonicalUser, addresses: CanonicalAddress[]): User {
  const twitterHandle = extractTwitterHandleFromUrl(user.twitterUrl);
  const telegramHandle = extractTelegramHandleFromUrl(user.telegramUrl);

  return {
    id: user.id,
    name: user.name,
    handle: synthesizeHandle(user.name, user.id),
    avatar: user.avatar,
    twitter: twitterHandle || undefined,
    telegram: telegramHandle || undefined,
    addresses: addresses.map((address, index) => ({
      address: address.address,
      chain: address.chain,
      name: `#${index + 1}`,
      totalAssetUsd: null,
      assetUpdatedAt: null,
    })),
    totalAssetUsd: user.currentBalanceUsd,
    historicalMaxAssetUsd: Math.max(user.maxBalanceUsd, user.currentBalanceUsd),
    assetUpdatedAt: null,
    tags: [],
  };
}

export function canonicalUsersToLegacy(users: CanonicalUser[], addressesByUserId: Record<string, CanonicalAddress[]>) {
  return users.map((user) => canonicalUserToLegacy(user, addressesByUserId[user.id] || []));
}

export function legacyFeedItemToCanonicalEvent(item: { user: User; activity: Activity }): CanonicalEvent | null {
  const { user, activity } = item;

  if (activity.source === 'twitter' && activity.metadata.tweetId && activity.metadata.tweetUrl) {
    return {
      id: activity.id,
      userId: user.id,
      type: 'twitter',
      tweetId: activity.metadata.tweetId,
      content: activity.content,
      url: activity.metadata.tweetUrl,
      action: 'post',
      timestamp: activity.timestamp,
    };
  }

  if (activity.source !== 'blockchain') {
    return null;
  }

  const tokenAmount = parseAmount(activity.metadata.value);
  if (tokenAmount === null || tokenAmount <= 0) {
    return null;
  }

  const chain = toCanonicalChain(activity.metadata.chain);
  const amountUsd = amountUsdFromActivity(activity);

  if (activity.metadata.txAction === 'send' || activity.metadata.txAction === 'receive') {
    return {
      id: activity.id,
      userId: user.id,
      type: 'transfer',
      txHash: activity.metadata.txHash || activity.id,
      fromAddress: activity.metadata.fromAddress || '',
      toAddress: activity.metadata.toAddress || '',
      tokenAddress: activity.metadata.tokenAddress || '',
      tokenSymbol: activity.metadata.token || 'UNKNOWN',
      tokenAmount,
      amountUsd,
      action: activity.metadata.txAction,
      timestamp: activity.timestamp,
      chain,
    };
  }

  const tradeAction = tradeActionFromActivity(activity);
  if (!tradeAction) {
    return null;
  }

  return {
    id: activity.id,
    userId: user.id,
    type: 'trade',
    txHash: activity.metadata.txHash || activity.id,
    walletAddress: activity.metadata.trackedAddress || activity.metadata.fromAddress || activity.metadata.toAddress || '',
    tokenAddress: activity.metadata.tokenAddress || '',
    tokenSymbol: activity.metadata.token || 'UNKNOWN',
    tokenAmount,
    amountUsd,
    priceUsd: amountUsd !== null && tokenAmount > 0 ? amountUsd / tokenAmount : null,
    marketCapUsd:
      typeof activity.metadata.marketCapAtTxUsd === 'number' ? activity.metadata.marketCapAtTxUsd : null,
    action: tradeAction,
    timestamp: activity.timestamp,
    chain,
    quoteSymbol: activity.metadata.quoteToken || null,
    quoteAmount: parseAmount(activity.metadata.quoteAmount),
    coHitUserCount: activity.metadata.coHitUserCount,
    coHitAddressCount: activity.metadata.coHitAddressCount,
  };
}

export function legacyUsersToCanonical(users: User[]) {
  const addressesByUserId: Record<string, CanonicalAddress[]> = {};

  const canonicalUsers = users.map((user) => {
    addressesByUserId[user.id] = user.addresses.map((address) => legacyAddressToCanonical(user.id, address));
    return legacyUserToCanonical(user);
  });

  return {
    users: canonicalUsers,
    addressesByUserId,
  };
}
