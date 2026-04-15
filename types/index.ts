export type ActivitySource = 'twitter' | 'telegram' | 'blockchain';
export type ActivityType = 'post' | 'transfer' | 'swap' | 'nft_trade' | 'mint';

export type ChainType = 'bsc' | 'solana';

export interface AddressInfo {
  address: string;
  name: string;
  chain: ChainType;
}

export interface User {
  id: string;
  name: string;
  handle: string;
  avatar: string;
  twitter?: string;
  telegram?: string;
  addresses: AddressInfo[];
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
    media?: string[];
    likes?: number;
    replies?: number;
    views?: string;
    chain?: string;
    fromAddress?: string;
    toAddress?: string;
    txStatus?: string;
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
