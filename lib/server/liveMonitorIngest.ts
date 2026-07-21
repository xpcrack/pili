/**
 * Project GMGN-normalized live trades into pili Activity + events.
 * id prefix: live-monitor: — never hardcode provider=xxyy.
 */
import 'server-only';

import { buildActivityFromSnapshotSync } from '@/lib/server/telegramMonitorActivity';
import { upsertEventsFromFeedRows } from '@/lib/server/eventsRepo';
import { getDb, withTransaction } from '@/lib/server/sqlite';
import type { NormalizedLiveTrade } from '@/lib/server/gmgnWalletActivity';
import type { Activity, User } from '@/types';

export const LIVE_MONITOR_ID_PREFIX = 'live-monitor:';
export const LIVE_MONITOR_INGEST_SOURCE = 'live-monitor-alchemy-gmgn';

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

function sideToAction(side: 'buy' | 'sell') {
  if (side === 'buy') {
    return {
      action: 'buy' as const,
      actionLabel: '加仓' as const,
      actionVariant: 'add' as const,
    };
  }
  return {
    action: 'sell' as const,
    actionLabel: '减仓' as const,
    actionVariant: 'reduce' as const,
  };
}

/** Lightweight stub so bulk backfill skips scoreFeedRowsAgainstDatabase (per-row COUNT on 2GB DB). */
const BACKFILL_IMPORTANCE_STUB = {
  version: 2,
  score: 0,
  formulaVersion: 'backfill-skip',
  factors: {},
  components: {},
} as const;

export function buildLiveMonitorActivity(params: {
  user: User;
  trade: NormalizedLiveTrade;
  /** When true, attach stub importance so eventsRepo skips DB history scoring. */
  skipImportanceScore?: boolean;
}): Activity {
  const { user, trade } = params;
  const { action, actionLabel, actionVariant } = sideToAction(trade.side);
  const quoteAmount =
    typeof trade.costUsd === 'number' && Number.isFinite(trade.costUsd) ? trade.costUsd : null;

  const base = buildActivityFromSnapshotSync({
    user,
    chain: trade.chain,
    tokenAddress: trade.tokenAddress,
    tokenSymbol: trade.tokenSymbol,
    txHash: trade.txHash,
    marketCapUsd: null,
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

  return {
    ...base,
    id: liveId,
    title: '链上监控交易',
    metadata: {
      ...base.metadata,
      liveSource: 'alchemy-gmgn',
      monitorTxAggregateKey: liveId,
      // do not claim telegram-monitor-exact MC
      marketCapAtTxSource: undefined,
      tradeAmountUsdAtTx: quoteAmount ?? base.metadata.tradeAmountUsdAtTx,
      ...(params.skipImportanceScore ? { importance: { ...BACKFILL_IMPORTANCE_STUB } } : {}),
    },
  };
}

export function upsertLiveMonitorTrades(params: {
  user: User;
  trades: NormalizedLiveTrade[];
  /** Bulk history backfill: skip per-row importance DB scans. */
  skipImportanceScore?: boolean;
  /**
   * Fast path for history backfill: plain INSERT OR REPLACE into events.
   * Skips conflict detection / logical rekey / telegram payload enrichment.
   * Safe for filling missing live-monitor rows; live realtime should use default path.
   */
  fastBulk?: boolean;
}) {
  if (params.trades.length === 0) {
    return { upserted: 0 };
  }
  if (params.fastBulk) {
    return upsertLiveMonitorTradesFast({
      user: params.user,
      trades: params.trades,
    });
  }
  const rows = params.trades.map((trade) => ({
    user: params.user,
    activity: buildLiveMonitorActivity({
      user: params.user,
      trade,
      skipImportanceScore: params.skipImportanceScore,
    }),
  }));
  upsertEventsFromFeedRows(rows, LIVE_MONITOR_INGEST_SOURCE);
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
