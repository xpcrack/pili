import 'server-only';

import { listMonitoredUsers } from '@/lib/server/trackedUsersRepo';
import {
  listFomoBoundUsers,
  upsertFomoTrade,
  insertFomoPositionSnapshot,
  upsertFomoUserStats,
  projectFomoTradesToFeed,
  type FomoBoundUser,
} from '@/lib/server/fomoRepo';
import {
  fetchUserTrades,
  fetchUserBalances,
  networkIdToChain,
  type FomoClosedTrade,
} from '@/lib/server/fomoClient';
import type { Activity, User } from '@/types';

const DEFAULT_TRADES_SLEEP_MS = 45_000; // 30-60s / 人
const DEFAULT_POSITIONS_SLEEP_MS = 30 * 60_000; // 30min
const DEFAULT_STATS_SLEEP_MS = 6 * 60 * 60_000; // 6h
const FOMO_PNL_PROJECTION_MIN_ABS_USD = 1; // 成交盈亏绝对值 ≥ 1 才投影到 feed

interface FomoRuntimeOptions {
  tradesIntervalMs?: number;
  positionsIntervalMs?: number;
  statsIntervalMs?: number;
  signal?: AbortSignal;
}

/** 建立 userId → 完整 User 的 map，用于投影。 */
function buildUserMap(): Map<string, User> {
  const map = new Map<string, User>();
  for (const user of listMonitoredUsers()) {
    map.set(user.id, user);
  }
  return map;
}

/** 从 FOMO 成交响应里提取一条成交的规范化字段。 */
function mapClosedTrade(
  trade: FomoClosedTrade,
  boundUser: FomoBoundUser
): {
  id: string;
  userId: string;
  userHandle: string;
  tokenAddress: string;
  tokenSymbol?: string;
  networkId?: number;
  side: string;
  humanTokenAmount?: number;
  avgEntryPrice?: number;
  avgExitPrice?: number;
  realizedPnlUsd?: number;
  sumSwapOpen?: number;
  sumSwapClosed?: number;
  openedAt?: number;
  closedAt?: number;
} | null {
  const t = trade.trade;
  if (!t?.id || !t?.tokenAddress) return null;
  const networkId = typeof t.networkId === 'number' ? t.networkId : undefined;
  const tokenMetadata = t.tokenMetadata;
  return {
    id: t.id,
    userId: boundUser.id,
    userHandle: boundUser.fomoHandle,
    tokenAddress: t.tokenAddress,
    tokenSymbol: tokenMetadata?.symbol,
    networkId,
    side: 'closed',
    humanTokenAmount: typeof t.humanTokenAmount === 'number' ? t.humanTokenAmount : undefined,
    avgEntryPrice: typeof t.avgEntryPrice === 'number' ? t.avgEntryPrice : undefined,
    avgExitPrice: typeof t.avgExitPrice === 'number' ? t.avgExitPrice : undefined,
    realizedPnlUsd: typeof t.realizedPnlUsd === 'number' ? t.realizedPnlUsd : undefined,
    sumSwapOpen: typeof t.sumSwapOpen === 'number' ? t.sumSwapOpen : undefined,
    sumSwapClosed: typeof t.sumSwapClosed === 'number' ? t.sumSwapClosed : undefined,
    openedAt: typeof t.createdAt === 'number' ? t.createdAt : undefined,
    closedAt: typeof t.closedAt === 'number' ? t.closedAt : undefined,
  };
}

/** 构造喊单/成交 content 和 metadata。 */
function buildTradeActivity(row: {
  boundUser: FomoBoundUser;
  user: User;
  trade: NonNullable<ReturnType<typeof mapClosedTrade>>;
}): { user: User; activity: Activity } {
  const { user, trade } = row;
  const symbol = trade.tokenSymbol ?? '';
  const pnlText =
    typeof trade.realizedPnlUsd === 'number'
      ? ` ${trade.realizedPnlUsd >= 0 ? '+' : ''}$${trade.realizedPnlUsd.toFixed(2)}`
      : '';
  const chain = networkIdToChain(trade.networkId);
  const content = `fomo成交 ${symbol}${pnlText}`;
  const activity: Activity = {
    id: `fomo-api:${trade.id}`,
    userId: user.id,
    source: 'blockchain',
    type: 'transfer',
    content,
    title: 'fomo成交',
    timestamp: trade.closedAt ?? trade.openedAt ?? Date.now(),
    metadata: {
      chain,
      token: symbol || undefined,
      tokenAddress: trade.tokenAddress,
      txAction: 'sell',
      displayActionVariantLabel: '卖出',
      displayWalletLabel: row.boundUser.fomoHandle,
      monitorWalletLabel: row.boundUser.fomoHandle,
      displayTokenSymbol: symbol || undefined,
      displayTradeAmountText: pnlText.trim() || undefined,
    },
  };
  return { user, activity };
}

/** 轮询一个用户的成交，落库 + 投影新成交到 feed。 */
async function collectUserTrades(
  boundUser: FomoBoundUser,
  userMap: Map<string, User>,
  minPnlAbsUsd: number,
): Promise<{ inserted: number; projected: number; error: string | null }> {
  const user = userMap.get(boundUser.id);
  if (!user) {
    return { inserted: 0, projected: 0, error: 'user-not-found' };
  }

  const feedRows: Array<{ user: User; activity: Activity }> = [];
  let inserted = 0;
  let error: string | null = null;

  try {
    const response = await fetchUserTrades({ userId: boundUser.fomoUserId, orderBy: 'closedAt' });
    const closedTrades = response.closedTrades ?? [];
    for (const trade of closedTrades) {
      const row = mapClosedTrade(trade, boundUser);
      if (!row) continue;
      const result = upsertFomoTrade(row);
      inserted += result.inserted;

      // 投射到 feed：仅统计本次新插入且盈亏绝对值足够的成交。
      if (result.inserted > 0) {
        const pnlAbs = typeof row.realizedPnlUsd === 'number' ? Math.abs(row.realizedPnlUsd) : 0;
        if (pnlAbs >= minPnlAbsUsd) {
          const { user: u, activity } = buildTradeActivity({ boundUser, user, trade: row });
          feedRows.push({ user: u, activity });
        }
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (feedRows.length > 0) {
    try {
      projectFomoTradesToFeed(feedRows);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  return { inserted, projected: feedRows.length, error };
}

/** 轮询一个用户的当前持仓（balances），写快照。 */
async function collectUserPositions(
  boundUser: FomoBoundUser,
): Promise<{ snapshots: number; error: string | null }> {
  let snapshots = 0;
  let error: string | null = null;
  try {
    const balances = (await fetchUserBalances(boundUser.fomoUserId)) as {
      items?: Array<{
        tokenAddress?: string;
        tokenSymbol?: string;
        humanAmount?: number;
        valueUsd?: number;
        pnlUsd?: number;
        networkId?: number;
      }>;
    };
    const items = balances.items ?? [];
    for (const item of items) {
      if (!item.tokenAddress) continue;
      insertFomoPositionSnapshot({
        userId: boundUser.id,
        tokenAddress: item.tokenAddress,
        tokenSymbol: item.tokenSymbol,
        humanAmount: item.humanAmount,
        valueUsd: item.valueUsd,
        pnlUsd: item.pnlUsd,
        networkId: item.networkId,
      });
      snapshots += 1;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { snapshots, error };
}

/** 轮询一个用户的 7d 战绩（balances 汇总字段）。 */
async function collectUserStats(
  boundUser: FomoBoundUser,
): Promise<{ error: string | null }> {
  let error: string | null = null;
  try {
    const balances = (await fetchUserBalances(boundUser.fomoUserId)) as {
      realizedPnl7dUsd?: number;
      winRate7d?: number;
      numTrades7d?: number;
      totalVolume7d?: number;
    };
    upsertFomoUserStats({
      userId: boundUser.id,
      userHandle: boundUser.fomoHandle,
      realizedPnl7dUsd: balances.realizedPnl7dUsd,
      winRate7d: balances.winRate7d,
      numTrades7d: balances.numTrades7d,
      totalVolume7d: balances.totalVolume7d,
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { error };
}

export interface FomoCycleResult {
  sleepMs: number;
  status: 'idle' | 'busy' | 'partial' | 'error';
  detail: Record<string, unknown>;
}

/** 成交轮询 cycle。 */
export async function runFomoTradesCycle(options?: FomoRuntimeOptions): Promise<FomoCycleResult> {
  const boundUsers = listFomoBoundUsers();
  const userMap = buildUserMap();

  if (boundUsers.length === 0) {
    return {
      sleepMs: options?.tradesIntervalMs ?? DEFAULT_TRADES_SLEEP_MS,
      status: 'idle',
      detail: { boundCount: 0 },
    };
  }

  let inserted = 0;
  let projected = 0;
  let errored = 0;

  for (const boundUser of boundUsers) {
    if (options?.signal?.aborted) break;
    const result = await collectUserTrades(boundUser, userMap, FOMO_PNL_PROJECTION_MIN_ABS_USD);
    inserted += result.inserted;
    projected += result.projected;
    if (result.error) {
      errored += 1;
      console.warn(`[fomo-trades] ${boundUser.name}/${boundUser.fomoHandle}: ${result.error}`);
    }
  }

  return {
    sleepMs: options?.tradesIntervalMs ?? DEFAULT_TRADES_SLEEP_MS,
    status: errored > 0 ? 'partial' : 'idle',
    detail: { boundCount: boundUsers.length, inserted, projected, errored },
  };
}

/** 持仓快照轮询 cycle。 */
export async function runFomoPositionsCycle(options?: FomoRuntimeOptions): Promise<FomoCycleResult> {
  const boundUsers = listFomoBoundUsers();
  if (boundUsers.length === 0) {
    return {
      sleepMs: options?.positionsIntervalMs ?? DEFAULT_POSITIONS_SLEEP_MS,
      status: 'idle',
      detail: { boundCount: 0 },
    };
  }

  let snapshots = 0;
  let errored = 0;
  for (const boundUser of boundUsers) {
    if (options?.signal?.aborted) break;
    const result = await collectUserPositions(boundUser);
    snapshots += result.snapshots;
    if (result.error) {
      errored += 1;
      console.warn(`[fomo-positions] ${boundUser.name}/${boundUser.fomoHandle}: ${result.error}`);
    }
  }

  return {
    sleepMs: options?.positionsIntervalMs ?? DEFAULT_POSITIONS_SLEEP_MS,
    status: errored > 0 ? 'partial' : 'idle',
    detail: { boundCount: boundUsers.length, snapshots, errored },
  };
}

/** 战绩轮询 cycle。 */
export async function runFomoStatsCycle(options?: FomoRuntimeOptions): Promise<FomoCycleResult> {
  const boundUsers = listFomoBoundUsers();
  if (boundUsers.length === 0) {
    return {
      sleepMs: options?.statsIntervalMs ?? DEFAULT_STATS_SLEEP_MS,
      status: 'idle',
      detail: { boundCount: 0 },
    };
  }

  let errored = 0;
  for (const boundUser of boundUsers) {
    if (options?.signal?.aborted) break;
    const result = await collectUserStats(boundUser);
    if (result.error) {
      errored += 1;
      console.warn(`[fomo-stats] ${boundUser.name}/${boundUser.fomoHandle}: ${result.error}`);
    }
  }

  return {
    sleepMs: options?.statsIntervalMs ?? DEFAULT_STATS_SLEEP_MS,
    status: errored > 0 ? 'partial' : 'idle',
    detail: { boundCount: boundUsers.length, errored },
  };
}
