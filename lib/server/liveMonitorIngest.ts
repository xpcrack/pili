/**
 * Project GMGN-normalized live trades into pili Activity + events.
 * id prefix: live-monitor: — never hardcode provider=xxyy.
 */
import 'server-only';

import { buildActivityFromSnapshotSync } from '@/lib/server/telegramMonitorActivity';
import { upsertEventsFromFeedRows } from '@/lib/server/eventsRepo';
import { getDb, withTransaction } from '@/lib/server/sqlite';
import { resolveAuthoritativePositionDelta } from '@/lib/server/positionDeltaService';
import type { NormalizedLiveTrade } from '@/lib/server/gmgnWalletActivity';
import type { ActivityImportance } from '@/lib/activityImportance';
import type { Activity, User } from '@/types';

export const LIVE_MONITOR_ID_PREFIX = 'live-monitor:';
export const LIVE_MONITOR_INGEST_SOURCE = 'live-monitor-alchemy-gmgn';
export const ALCHEMY_DIRECT_INGEST_SOURCE = 'live-monitor-alchemy';

export function buildLiveMonitorActivityId(params: {
  chain: string;
  trackedAddress: string;
  txHash: string | null;
  tokenAddress: string;
  eventTimeMs: number;
}) {
  const chain = params.chain.trim().toLowerCase();
  const wallet = params.trackedAddress.trim().toLowerCase();
  const tx = (params.txHash || '').trim().toLowerCase();
  const token = params.tokenAddress.trim().toLowerCase();
  // Include token so multi-leg swaps (same tx, different tokens) do not overwrite each other.
  if (chain && wallet && tx && token) {
    return `${LIVE_MONITOR_ID_PREFIX}${chain}:${wallet}:${tx}:${token}`;
  }
  if (chain && wallet && tx) {
    return `${LIVE_MONITOR_ID_PREFIX}${chain}:${wallet}:${tx}`;
  }
  return `${LIVE_MONITOR_ID_PREFIX}${chain}:${wallet || 'unknown'}:${token || 'token'}:${params.eventTimeMs}`;
}

export function isLiveMonitorActivityId(id: string | null | undefined) {
  return Boolean(id && id.startsWith(LIVE_MONITOR_ID_PREFIX));
}

export function isLiveOrXxyyMonitorActivityId(id: string | null | undefined) {
  return Boolean(
    id && (id.startsWith(LIVE_MONITOR_ID_PREFIX) || id.startsWith('xxyy-monitor:'))
  );
}

function sideToAction(side: 'buy' | 'sell', isOpenOrClose: boolean | null | undefined) {
  if (side === 'buy') {
    if (isOpenOrClose === true) {
      return {
        action: 'buy' as const,
        actionLabel: '建仓' as const,
        actionVariant: 'open' as const,
      };
    }
    return {
      action: 'buy' as const,
      actionLabel: '加仓' as const,
      actionVariant: 'add' as const,
    };
  }
  if (isOpenOrClose === true) {
    return {
      action: 'sell' as const,
      actionLabel: '清仓' as const,
      actionVariant: 'close' as const,
    };
  }
  return {
    action: 'sell' as const,
    actionLabel: '减仓' as const,
    actionVariant: 'reduce' as const,
  };
}

/** Lightweight stub so bulk backfill skips scoreFeedRowsAgainstDatabase (per-row COUNT on 2GB DB). */
const BACKFILL_IMPORTANCE_STUB: ActivityImportance = {
  version: 2,
  score: 0,
  formulaVersion: 'backfill-skip',
  sourceKind: 'wallet',
  sourceCount7d: 0,
  socialCount7d: 0,
  walletCount7d: 0,
  totalCount7d: 0,
  historicalMaxAssetUsd: null,
  sourceRarity: 0,
  assetWeight: 0,
  totalFrequencyFactor: 0,
  dataConfidenceFactor: 0,
};

export function buildLiveMonitorActivity(params: {
  user: User;
  trade: NormalizedLiveTrade;
  /** When true, attach stub importance so eventsRepo skips DB history scoring. */
  skipImportanceScore?: boolean;
  /** When true, compute an authoritative positionDeltaRatio from full history
   * now, so the feed shows the real % immediately instead of a client estimate (`~`). */
  resolvePositionDelta?: boolean;
}): Activity {
  const { user, trade } = params;
  const isAlchemyDirect = trade.dataSource === 'alchemy';
  const { action, actionLabel, actionVariant } = sideToAction(trade.side, trade.isOpenOrClose);
  const quoteAmount =
    typeof trade.costUsd === 'number' && Number.isFinite(trade.costUsd) ? trade.costUsd : null;

  const marketCapUsd =
    typeof trade.marketCapUsd === 'number' && Number.isFinite(trade.marketCapUsd) && trade.marketCapUsd > 0
      ? trade.marketCapUsd
      : null;

  const base = buildActivityFromSnapshotSync({
    user,
    chain: trade.chain,
    tokenAddress: trade.tokenAddress,
    tokenSymbol: trade.tokenSymbol,
    txHash: trade.txHash,
    marketCapUsd,
    quoteAmount,
    quoteSymbol: quoteAmount != null ? 'USD' : null,
    tokenAmount: trade.tokenAmount,
    explicitPriceUsd: trade.priceUsd,
    rawText: null,
    action,
    actionLabel,
    actionVariant,
    walletLabel: user.name,
    walletGroupLabel: null,
    walletAliasLabel: null,
    eventTimeMs: trade.eventTimeMs,
    trackedAddress: trade.wallet,
  });

  const liveId = buildLiveMonitorActivityId({
    chain: trade.chain,
    trackedAddress: trade.wallet,
    txHash: trade.txHash,
    tokenAddress: trade.tokenAddress,
    eventTimeMs: trade.eventTimeMs,
  });

  // open → 建仓 (no ratio); close → -100%; add/reduce → compute from full
  // history so the feed shows the real % immediately (no client `~` estimate).
  // Failures fall back to undefined; the recurring backfill still catches it.
  let positionDeltaRatio: number | undefined;
  if (actionVariant === 'close') {
    positionDeltaRatio = -1;
  } else if (typeof base.metadata.positionDeltaRatio === 'number') {
    positionDeltaRatio = base.metadata.positionDeltaRatio;
  } else if (params.resolvePositionDelta) {
    try {
      positionDeltaRatio = resolveAuthoritativePositionDelta({ ...base, id: liveId }) ?? undefined;
    } catch {
      positionDeltaRatio = undefined;
    }
  }

  return {
    ...base,
    id: liveId,
    title: '链上监控交易',
    metadata: {
      ...base.metadata,
      liveSource: isAlchemyDirect ? 'alchemy' : 'alchemy-gmgn',
      monitorTxAggregateKey: liveId,
      // Prefer GMGN MC when present; never claim telegram-monitor-exact.
      marketCapAtTxSource: marketCapUsd != null
        ? isAlchemyDirect
          ? 'dexscreener'
          : 'gmgn-activity'
        : undefined,
      tradeAmountUsdAtTx: quoteAmount ?? base.metadata.tradeAmountUsdAtTx,
      ...(positionDeltaRatio !== undefined ? { positionDeltaRatio } : {}),
      ...(params.skipImportanceScore ? { importance: { ...BACKFILL_IMPORTANCE_STUB } } : {}),
    },
  };
}

/**
 * GMGN activity returns one item per swap leg. A multi-leg tx (aggregator
 * routing through several pools) emits N rows that all map to the same
 * event_id (`live-monitor:<chain>:<wallet>:<tx>:<token>` — no leg index), so
 * a per-item upsert keeps only the last leg's qty/cost and silently
 * undercounts the trade (2026-09-22: ROP musebook tx 0x957b71 recorded
 * $13.6K instead of $27.2K — 3 of 4 legs were overwritten). Merge legs per
 * (dataSource, chain, wallet, tx, token, side) before upsert: amounts and
 * costs sum, price is qty-weighted, MC keeps the max, open/close wins if any
 * leg reports it.
 */
export function aggregateLiveTradeLegs(trades: NormalizedLiveTrade[]): NormalizedLiveTrade[] {
  const byKey = new Map<string, NormalizedLiveTrade[]>();
  for (const trade of trades) {
    const key = [
      trade.dataSource ?? '',
      trade.chain,
      trade.wallet,
      trade.txHash ?? '',
      trade.tokenAddress,
      trade.side,
    ].join('|');
    const bucket = byKey.get(key);
    if (bucket) bucket.push(trade);
    else byKey.set(key, [trade]);
  }
  const out: NormalizedLiveTrade[] = [];
  for (const legs of byKey.values()) {
    const head = legs[0]!;
    if (legs.length === 1) {
      out.push(head);
      continue;
    }
    let tokenAmount: number | null = null;
    let costUsd: number | null = null;
    let priceWeighted = 0;
    let priceWeight = 0;
    let priceFallback: number | null = null;
    let marketCapUsd: number | null = null;
    let isOpenOrClose: boolean | null = null;
    let eventTimeMs = head.eventTimeMs;
    for (const leg of legs) {
      if (leg.tokenAmount != null && Number.isFinite(leg.tokenAmount)) {
        tokenAmount = (tokenAmount ?? 0) + leg.tokenAmount;
      }
      if (leg.costUsd != null && Number.isFinite(leg.costUsd)) {
        costUsd = (costUsd ?? 0) + leg.costUsd;
      }
      if (leg.priceUsd != null && Number.isFinite(leg.priceUsd)) {
        priceFallback ??= leg.priceUsd;
        const qty = leg.tokenAmount != null && Number.isFinite(leg.tokenAmount) ? leg.tokenAmount : 0;
        priceWeighted += leg.priceUsd * qty;
        priceWeight += qty;
      }
      if (leg.marketCapUsd != null && (marketCapUsd == null || leg.marketCapUsd > marketCapUsd)) {
        marketCapUsd = leg.marketCapUsd;
      }
      if (leg.isOpenOrClose === true) isOpenOrClose = true;
      else if (isOpenOrClose == null && leg.isOpenOrClose != null) isOpenOrClose = leg.isOpenOrClose;
      if (leg.eventTimeMs < eventTimeMs) eventTimeMs = leg.eventTimeMs;
    }
    out.push({
      ...head,
      tokenAmount,
      costUsd,
      priceUsd: priceWeight > 0 ? priceWeighted / priceWeight : priceFallback,
      marketCapUsd,
      isOpenOrClose,
      eventTimeMs,
    });
  }
  return out;
}

export function upsertLiveMonitorTrades(params: {
  user: User;
  trades: NormalizedLiveTrade[];
  /** Bulk history backfill: skip per-row importance DB scans. */
  skipImportanceScore?: boolean;
  /**
   * Compute the exact position ratio synchronously from the full events
   * history. Keep this off for realtime ingest: a large events table can turn
   * one doorbell into a multi-second synchronous SQLite scan and block the
   * worker before it can ack the queue. The scheduled position-delta pass
   * fills the authoritative ratio shortly afterwards.
   */
  resolvePositionDelta?: boolean;
  /**
   * Fast path for history backfill: plain INSERT OR REPLACE into events.
   * Skips conflict detection / logical rekey / telegram payload enrichment.
   * Safe for filling missing live-monitor rows; live realtime should use default path.
   */
  fastBulk?: boolean;
}) {
  const trades = aggregateLiveTradeLegs(params.trades);
  if (trades.length === 0) {
    return { upserted: 0 };
  }
  if (params.fastBulk) {
    return upsertLiveMonitorTradesFast({
      user: params.user,
      trades,
    });
  }
  const rows = trades.map((trade) => ({
    user: params.user,
    activity: buildLiveMonitorActivity({
      user: params.user,
      trade,
      skipImportanceScore: params.skipImportanceScore,
      resolvePositionDelta: params.resolvePositionDelta === true,
    }),
  }));
  const ingestSource = trades.every((trade) => trade.dataSource === 'alchemy')
    ? ALCHEMY_DIRECT_INGEST_SOURCE
    : LIVE_MONITOR_INGEST_SOURCE;
  upsertEventsFromFeedRows(rows, ingestSource);
  return { upserted: rows.length };
}

/**
 * Minimal bulk writer for GMGN history backfill.
 * ~100x faster than upsertEventsFromFeedRows on a large events table.
 */
export function upsertLiveMonitorTradesFast(params: {
  user: User;
  trades: NormalizedLiveTrade[];
}) {
  if (params.trades.length === 0) return { upserted: 0 };
  const now = Date.now();
  const userJson = JSON.stringify(params.user);

  withTransaction(() => {
    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO events (
         event_id, source, kind, timestamp, user_id, user_name,
         chain, address, content, url, action, token, tweet_id, tx_hash,
         ingest_source, dedup_key, metadata_json, payload_json,
         user_json, activity_json, indexed_at, created_at, updated_at
       ) VALUES (
         ?, 'blockchain', 'transfer', ?, ?, ?,
         ?, ?, ?, NULL, ?, ?, NULL, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?, ?
       )
       ON CONFLICT(event_id) DO UPDATE SET
         timestamp = excluded.timestamp,
         content = excluded.content,
         action = excluded.action,
         token = excluded.token,
         tx_hash = excluded.tx_hash,
         ingest_source = excluded.ingest_source,
         metadata_json = excluded.metadata_json,
         payload_json = excluded.payload_json,
         user_json = excluded.user_json,
         activity_json = excluded.activity_json,
         indexed_at = excluded.indexed_at,
         updated_at = excluded.updated_at`
    );

    for (const trade of params.trades) {
      const activity = buildLiveMonitorActivity({
        user: params.user,
        trade,
        skipImportanceScore: true,
      });
      const eventId = activity.id;
      const chain = trade.chain;
      const address = trade.wallet;
      const action = trade.side;
      const token = trade.tokenSymbol || null;
      const txHash = trade.txHash;
      const content = activity.content || '';
      const activityJson = JSON.stringify(activity);
      const metadataJson = JSON.stringify(activity.metadata || {});
      const payloadJson = JSON.stringify({
        schemaVersion: 1,
        ingestSource: LIVE_MONITOR_INGEST_SOURCE,
        originalType: 'gmgn-wallet-activity-backfill',
        trade,
      });

      stmt.run(
        eventId,
        trade.eventTimeMs,
        params.user.id,
        params.user.name || null,
        chain,
        address,
        content,
        action,
        token,
        txHash,
        LIVE_MONITOR_INGEST_SOURCE,
        eventId,
        metadataJson,
        payloadJson,
        userJson,
        activityJson,
        now,
        now,
        now
      );
    }
  });

  return { upserted: params.trades.length };
}
