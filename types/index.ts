export type ActivitySource = 'twitter' | 'telegram' | 'blockchain';
export type ActivityType = 'post' | 'transfer' | 'swap' | 'nft_trade' | 'mint';

export type ChainType = 'bsc' | 'solana';

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
  twitter?: string;
  telegram?: string;
  addresses: AddressInfo[];
  totalAssetUsd: number;
  historicalMaxAssetUsd: number;
  assetUpdatedAt: number | null;
  tags: string[];
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
    txHash?: string;
    value?: string;
    token?: string;
    tokenAddress?: string;
    quoteToken?: string;
    quoteAmount?: string;
    media?: string[];
    likes?: number;
    replies?: number;
    views?: string;
    chain?: string;
    fromAddress?: string;
    toAddress?: string;
    txStatus?: string;
    uncertainFrom?: boolean;
    txAction?: 'buy' | 'sell' | 'send' | 'receive';
    trackedAddress?: string;
    coHitUserCount?: number;
    coHitAddressCount?: number;
    coHitUserNames?: string[];
    coHitAddresses?: string[];
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
];
