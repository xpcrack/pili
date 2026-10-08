import type { ChainType, User } from '@/types';

export const USER_HOLDINGS_THRESHOLD_USD = 5;

export interface UserHoldingRow {
  chain: ChainType | 'robinhood';
  tokenAddress: string;
  symbol: string;
  name: string | null;
  balance: number;
  priceUsd: number;
  valueUsd: number;
  liquidityUsd: number | null;
  /** true = 聚合的 Uniswap V4 LP 仓（tokenAddress 形如 lp:uniswap-v4:<wallet>），非真实 token */
  isLp?: boolean;
}

export interface UserHoldingsSummary {
  visibleCount: number;
  partial: boolean;
  successfulAddressCount: number;
  failedAddressCount: number;
}

export interface UserDetailsSuccessPayload {
  ok: true;
  user: User;
  holdings: UserHoldingRow[];
  holdingsUpdatedAt: number | null;
  holdingsThresholdUsd: typeof USER_HOLDINGS_THRESHOLD_USD;
  holdingsSummary: UserHoldingsSummary;
}

export interface UserDetailsErrorPayload {
  ok: false;
  error: string;
}
