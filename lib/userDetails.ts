import type { ChainType, User } from '@/types';

export const USER_HOLDINGS_THRESHOLD_USD = 5;

/** 一条 LP 仓在该 token 上的腿明细（hover tooltip 数据源）。 */
export interface LpLegInfo {
  /** 该腿所属仓位的池子对，如 "AI/BONER" */
  poolSymbol: string;
  /** 另一腿的 symbol */
  otherSymbol: string;
  /** 费率百分数（fee/10000，如 0.9 表示 0.9%） */
  feePct: number | null;
  tickLower: number | null;
  tickUpper: number | null;
  fullRange: boolean;
  /** 该腿 token 数量（human 单位） */
  amountHuman: number | null;
  /** 该腿美元价值 */
  legUsd: number | null;
}

export interface UserHoldingRow {
  chain: ChainType | 'robinhood';
  tokenAddress: string;
  symbol: string;
  name: string | null;
  balance: number;
  priceUsd: number;
  /** 直接持有 + LP 腿合计美元（LP 部分单列在 lpUsd） */
  valueUsd: number;
  liquidityUsd: number | null;
  /** 该 token 在 LP 仓里的部分美元（直接持有部分 = valueUsd - lpUsd） */
  lpUsd?: number;
  /** LP 腿明细（存在即表示该行含 LP 持仓） */
  lpLegs?: LpLegInfo[];
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
