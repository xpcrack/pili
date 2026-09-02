import 'server-only';

import { getDb, withTransaction } from '@/lib/server/sqlite';
import { upsertEventsFromFeedRows } from '@/lib/server/eventsRepo';
import {
  fetchHodlersTop,
  fetchUserTrades,
  fetchUserByHandle,
  fetchFuzzySearch,
  networkIdToChain,
  type FomoClosedTrade,
  type FomoHolder,
} from '@/lib/server/fomoClient';
import type { Activity, User } from '@/types';

const INGEST_SOURCE = 'fomo-api';

export interface FomoBoundUser {
  id: string;
  name: string;
  handle: string;
  fomoUserId: string;
  fomoHandle: string;
}

/** 从 tracked_users 读所有已绑定 FOMO 身份的用户。 */
export function listFomoBoundUsers(): FomoBoundUser[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, name, handle, COALESCE(fomo_user_id, '') AS fomo_user_id, COALESCE(fomo_handle, '') AS fomo_handle
       FROM tracked_users
       WHERE fomo_user_id IS NOT NULL AND fomo_user_id != ''`
    )
    .all() as Array<{
    id: string;
    name: string;
    handle: string;
    fomo_user_id: string;
    fomo_handle: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    handle: row.handle,
    fomoUserId: row.fomo_user_id,
    fomoHandle: row.fomo_handle,
  }));
}

/** 绑定 FOMO 身份（user_id + handle）到 tracked_users。存在则更新，不存在则提示。 */
export function bindFomoIdentity(params: {
  userId: string;
  fomoUserId: string;
  fomoHandle: string;
}): boolean {
  const db = getDb();
  const info = db
    .prepare(
      `UPDATE tracked_users SET fomo_user_id = ?, fomo_handle = ? WHERE id = ?`
    )
    .run(params.fomoUserId, params.fomoHandle, params.userId);
  return info.changes > 0;
}

/** 按 FOMO handle 反查 tracked_users（宽松匹配 handle / name / twitter）。 */
export function findTrackedUserByFomoHandle(handle: string) {
  const db = getDb();
  const normalized = handle.trim().toLowerCase();
  return db
    .prepare(
      `SELECT id, name, handle, COALESCE(twitter, '') AS twitter FROM tracked_users
       WHERE LOWER(COALESCE(fomo_handle, '')) = ?
          OR LOWER(COALESCE(handle, '')) = ?
          OR LOWER(COALESCE(name, '')) = ?
          OR LOWER(COALESCE(twitter, '')) = ?
       LIMIT 1`
    )
    .get(normalized, normalized, normalized, normalized) as
    | { id: string; name: string; handle: string; twitter: string }
    | undefined;
}

export interface FomoUpsertTradeResult {
  inserted: number;
  updated: number;
}

/** 落库一条 FOMO 成交。event_id 供喊单投影去重。 */
export function upsertFomoTrade(trade: {
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
  eventId?: string;
}): FomoUpsertTradeResult {
  const db = getDb();
  const now = Date.now();
  const chain = networkIdToChain(trade.networkId);
  const previous = db
    .prepare('SELECT event_id FROM fomo_trades WHERE id = ? LIMIT 1')
    .get(trade.id) as { event_id: string | null } | undefined;
  const info = db
    .prepare(
      `INSERT INTO fomo_trades (
         id, user_id, user_handle, token_address, token_symbol, network_id, chain, side,
         human_token_amount, avg_entry_price, avg_exit_price, realized_pnl_usd,
         sum_swap_open, sum_swap_closed, opened_at, closed_at, created_at, updated_at, event_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         user_id = excluded.user_id,
         user_handle = excluded.user_handle,
         token_address = excluded.token_address,
         token_symbol = excluded.token_symbol,
         network_id = excluded.network_id,
         chain = excluded.chain,
         side = excluded.side,
         human_token_amount = excluded.human_token_amount,
         avg_entry_price = excluded.avg_entry_price,
         avg_exit_price = excluded.avg_exit_price,
         realized_pnl_usd = excluded.realized_pnl_usd,
         sum_swap_open = excluded.sum_swap_open,
         sum_swap_closed = excluded.sum_swap_closed,
         opened_at = excluded.opened_at,
         closed_at = excluded.closed_at,
         updated_at = excluded.updated_at,
         event_id = COALESCE(excluded.event_id, fomo_trades.event_id)`
    )
    .run(
      trade.id,
      trade.userId,
      trade.userHandle,
      trade.tokenAddress,
      trade.tokenSymbol ?? null,
      trade.networkId ?? null,
      chain ?? null,
      trade.side,
      trade.humanTokenAmount ?? null,
      trade.avgEntryPrice ?? null,
      trade.avgExitPrice ?? null,
      trade.realizedPnlUsd ?? null,
      trade.sumSwapOpen ?? null,
      trade.sumSwapClosed ?? null,
      trade.openedAt ?? null,
      trade.closedAt ?? null,
      now,
      now,
      trade.eventId ?? null
    );
  return {
    inserted: info.changes > 0 && !previous ? 1 : 0,
    updated: info.changes > 0 && previous ? 1 : 0,
  };
}

/** 写持仓快照（时间序列）。 */
export function insertFomoPositionSnapshot(snapshot: {
  userId: string;
  tokenAddress: string;
  tokenSymbol?: string;
  humanAmount?: number;
  valueUsd?: number;
  pnlUsd?: number;
  networkId?: number;
  snapshotAt?: number;
}) {
  const db = getDb();
  const chain = networkIdToChain(snapshot.networkId);
  db.prepare(
    `INSERT INTO fomo_position_snapshots (
       user_id, token_address, token_symbol, human_amount, value_usd, pnl_usd,
       network_id, chain, snapshot_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    snapshot.userId,
    snapshot.tokenAddress,
    snapshot.tokenSymbol ?? null,
    snapshot.humanAmount ?? null,
    snapshot.valueUsd ?? null,
    snapshot.pnlUsd ?? null,
    snapshot.networkId ?? null,
    chain ?? null,
    snapshot.snapshotAt ?? Date.now()
  );
}

/** 写用户战绩快照（7d PnL / 胜率 / 笔数 / 成交量）。 */
export function upsertFomoUserStats(stats: {
  userId: string;
  userHandle: string;
  realizedPnl7dUsd?: number;
  winRate7d?: number;
  numTrades7d?: number;
  totalVolume7d?: number;
  snapshotAt?: number;
}) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO fomo_user_stats (
       user_id, user_handle, realized_pnl_7d_usd, win_rate_7d, num_trades_7d,
       total_volume_7d, snapshot_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       user_handle = excluded.user_handle,
       realized_pnl_7d_usd = excluded.realized_pnl_7d_usd,
       win_rate_7d = excluded.win_rate_7d,
       num_trades_7d = excluded.num_trades_7d,
       total_volume_7d = excluded.total_volume_7d,
       snapshot_at = excluded.snapshot_at,
       updated_at = excluded.updated_at`
  ).run(
    stats.userId,
    stats.userHandle,
    stats.realizedPnl7dUsd ?? null,
    stats.winRate7d ?? null,
    stats.numTrades7d ?? null,
    stats.totalVolume7d ?? null,
    stats.snapshotAt ?? now,
    now
  );
}

/**
 * 把一条 FOMO 成交投影到 events feed（喊单/成交与推文并列展示）。
 * 仅投影有新成交的行；已存在于 events（同 event_id）则跳过。
 */
export function projectFomoTradeToFeed(input: {
  user: User;
  tradeId: string;
  content: string;
  timestamp: number;
  metadata: Activity['metadata'];
}) {
  const activity: Activity = {
    id: `fomo-api:${input.tradeId}`,
    userId: input.user.id,
    source: 'blockchain',
    type: 'transfer',
    content: input.content,
    title: 'fomo喊单',
    timestamp: input.timestamp,
    metadata: input.metadata,
  };
  upsertEventsFromFeedRows([{ user: input.user, activity }], INGEST_SOURCE);
}

/** 把一条 FOMO 成交 batch 投影到 feed。 */
export function projectFomoTradesToFeed(rows: Array<{ user: User; activity: Activity }>) {
  if (rows.length === 0) return;
  upsertEventsFromFeedRows(rows, INGEST_SOURCE);
}
