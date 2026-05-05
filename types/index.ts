import type { ActivityImportance } from '@/lib/activityImportance';

export type ActivitySource = 'twitter' | 'telegram' | 'blockchain';
export type ActivityType = 'post' | 'transfer' | 'swap' | 'nft_trade' | 'mint';

export type ChainType = 'bsc' | 'solana' | 'ethereum' | 'base';

export interface CanonicalAddress {
  id: string;
  userId: string;
  address: string;
  chain: ChainType;
}

export interface CanonicalUser {
  id: string;
  name: string;
  avatar: string;
  currentBalanceUsd: number;
  maxBalanceUsd: number;
  hasUnread: boolean;
  twitterUrl: string | null;
  telegramUrl: string | null;
}

export interface CanonicalBaseEvent {
  id: string;
  userId: string;
  timestamp: number;
}

export type CanonicalTradeAction = 'open' | 'add' | 'reduce' | 'close';
export type CanonicalTransferAction = 'send' | 'receive';

export interface CanonicalTradeEvent extends CanonicalBaseEvent {
  type: 'trade';
  txHash: string;
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenAmount: number;
  amountUsd: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  action: CanonicalTradeAction;
  chain: ChainType | null;
  quoteSymbol?: string | null;
  quoteAmount?: number | null;
  coHitUserCount?: number;
  coHitAddressCount?: number;
}

export interface CanonicalTransferEvent extends CanonicalBaseEvent {
  type: 'transfer';
  txHash: string;
  fromAddress: string;
  toAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenAmount: number;
  amountUsd: number | null;
  action: CanonicalTransferAction;
  chain: ChainType | null;
}

export interface CanonicalTwitterEvent extends CanonicalBaseEvent {
  type: 'twitter';
  tweetId: string;
  content: string;
  url: string;
  action: 'post';
}

export type CanonicalEvent = CanonicalTradeEvent | CanonicalTransferEvent | CanonicalTwitterEvent;

export interface AddressInfo {
  address: string;
  name: string;
  chain: ChainType;
  totalAssetUsd: number | null;
  assetUpdatedAt: number | null;
}

export interface User {
  id: string;
  name: string;
  handle: string;
  avatar: string;
  currentChainAssetTotal?: number;
  historicalMaxChainAssetTotal?: number;
  twitter?: string;
  twitterUserId?: string;
  twitterAvatarUrl?: string;
  telegram?: string;
  addresses: AddressInfo[];
  totalAssetUsd: number;
  historicalMaxAssetUsd: number;
  assetUpdatedAt: number | null;
  tags: string[];
  relayCoverage?: {
    latestTweetId: string;
    latestLastSeenAtMs: number;
    tweetCount: number;
  } | null;
}

export interface Activity {
  id: string;
  userId: string;
  source: ActivitySource;
  type: ActivityType;
  content: string;
  title?: string;
  timestamp: number;
  metadata: {
    tweetId?: string;
    tweetUrl?: string;
    tweetKind?: 'tweet' | 'reply' | 'quote';
    quotedTweetId?: string;
    quotedTweetUrl?: string;
    quotedTweetAuthorHandle?: string;
    quotedTweetContent?: string;
    translationZh?: string;
    translationStatus?: 'pending' | 'processing' | 'succeeded' | 'failed';
    mentionedTickers?: string[];
    mentionedTokenAddresses?: string[];
    tokenSentiments?: Array<{
      tokenSymbol?: string;
      tokenAddress?: string;
      chain?: string;
      sentiment: 'positive' | 'negative' | 'neutral';
      matchSource: 'ticker' | 'ca' | 'both';
    }>;
    referencedByEventCount?: number;
    txHash?: string;
    value?: string;
    token?: string;
    tokenAddress?: string;
    quoteToken?: string;
    quoteAmount?: string;
    media?: string[];
    likes?: number;
    replies?: number;
    telegramChatId?: string;
    telegramChannelUsername?: string;
    telegramChannelTitle?: string;
    telegramMessageId?: number;
    telegramPostUrl?: string;
    telegramGroupedId?: string;
    telegramViews?: number;
    telegramForwards?: number;
    telegramReplies?: number;
    telegramLinkUrls?: string[];
    telegramSyncSource?: 'telegram-channel';
    chain?: string;
    fromAddress?: string;
    toAddress?: string;
    txStatus?: string;
    uncertainFrom?: boolean;
    txAction?: 'buy' | 'sell' | 'send' | 'receive';
    txActionLabel?: '建仓' | '加仓' | '减仓' | '清仓' | '发送';
    txActionVariant?: 'open' | 'add' | 'reduce' | 'close' | 'send';
    trackedAddress?: string;
    monitorWalletLabel?: string;
    monitorWalletGroupLabel?: string;
    monitorWalletAliasLabel?: string;
    monitorReconciliationStatus?: 'pending' | 'reconciled' | 'failed';
    monitorReconciledSource?: 'xxyy' | 'okx-address' | 'okx-detail';
    monitorTxAggregateKey?: string;
    rawText?: string;
    coHitUserCount?: number;
    coHitAddressCount?: number;
    coHitUserNames?: string[];
    coHitAddresses?: string[];
    marketCapAtTxUsd?: number;
    tradeAmountUsdAtTx?: number;
    marketCapAtTxSource?: 'telegram-monitor-exact' | 'estimated' | 'snapshot';
    marketCapAtTxEstimated?: boolean;
    displayWalletLabel?: string;
    displayActionVariantLabel?: string;
    displayTradeAmountText?: string;
    displayTokenSymbol?: string;
    displayMarketCapText?: string;
    displayTokenAvatarTokenAddress?: string;
    mergedTradeCount?: number;
    mergedTradeWindowMs?: number;
    mergedTradeAverageMarketCapUsd?: number | null;
    importance?: ActivityImportance;
  };
}

export interface UserActivity {
  user: User;
  activities: Activity[];
  latestActivityAt: number;
  hasNew: boolean;
}

export const DEFAULT_USERS: User[] = [];

// 链选项配置
export const CHAIN_OPTIONS: { value: ChainType; label: string; color: string }[] = [
  { value: 'bsc', label: 'BSC', color: '#F0B90B' },
  { value: 'solana', label: 'Solana', color: '#14F195' },
  { value: 'ethereum', label: 'Ethereum', color: '#627EEA' },
  { value: 'base', label: 'Base', color: '#0052FF' },
];
