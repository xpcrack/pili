/**
 * Project GMGN-normalized live trades into pili Activity + events.
 * id prefix: live-monitor: — never hardcode provider=xxyy.
 */
import 'server-only';

import { buildActivityFromSnapshotSync } from '@/lib/server/telegramMonitorActivity';
import { upsertEventsFromFeedRows } from '@/lib/server/eventsRepo';
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
  if (chain && wallet && tx) {
    return `${LIVE_MONITOR_ID_PREFIX}${chain}:${wallet}:${tx}`;
  }
  const token = params.tokenAddress.trim().toLowerCase();
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

export function buildLiveMonitorActivity(params: {
  user: User;
  trade: NormalizedLiveTrade;
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
    },
  };
}

export function upsertLiveMonitorTrades(params: {
  user: User;
  trades: NormalizedLiveTrade[];
}) {
  if (params.trades.length === 0) {
    return { upserted: 0 };
  }
  const rows = params.trades.map((trade) => ({
    user: params.user,
    activity: buildLiveMonitorActivity({ user: params.user, trade }),
  }));
  upsertEventsFromFeedRows(rows, LIVE_MONITOR_INGEST_SOURCE);
  return { upserted: rows.length };
}
