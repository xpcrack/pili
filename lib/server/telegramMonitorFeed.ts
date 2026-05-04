import 'server-only';

import {
  listRecentTelegramMonitorFallbackEventsWithoutTxState,
  updateTelegramMonitorEventProjectedActivityIfMissing,
  type TelegramMonitorFeedEvent,
} from '@/lib/server/telegramMonitorRepo';
import { scoreFeedRowsAgainstDatabase } from '@/lib/server/activityImportanceService';
import { persistHealedTelegramMonitorActivity } from '@/lib/server/eventsRepo';
import {
  listRecentTelegramMonitorTxStates,
  type TelegramMonitorTxState,
} from '@/lib/server/telegramMonitorTxStateRepo';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import {
  buildActivityFromSnapshot,
  repairCollapsedCanonicalActivity,
} from '@/lib/server/telegramMonitorActivity';
import {
  buildTrackedAddressIndex,
  dedupeTelegramMonitorFeedRows,
  pickMonitoredUser,
} from '@/lib/server/telegramMonitorFeedHelpers';
import { parseXxyyTelegramText } from '@/lib/server/xxyyTelegramParser';
import type { Activity, User } from '@/types';

export interface TelegramMonitorFeedRow {
  user: User;
  activity: Activity;
}

export interface BidOnchainEventCursor {
  eventTimeMs: number;
  eventId: string;
}

export interface BidOnchainEvent {
  eventId: string;
  userId: string;
  chain: string;
  trackedWalletAddress: string;
  trackedWalletAddressRaw: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  txHash: string | null;
  action: 'buy' | 'sell' | 'send' | null;
  actionVariant: 'open' | 'add' | 'reduce' | 'close' | 'send' | null;
  eventTimeMs: number;
  walletAliasLabel: string | null;
  walletGroupLabel: string | null;
  marketCapUsd: number | null;
  messageLinks: string[];
}

function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

async function buildProjectedTelegramMonitorFeedRow(params: {
  user: User;
  chain: string;
  tokenAddress: string;
  tokenSymbol: string;
  txHash: string | null;
  marketCapUsd: number | null;
  quoteAmount: number | null;
  quoteSymbol: string | null;
  tokenAmount: number | null;
  explicitPriceUsd: number | null;
  rawText: string | null;
  action: 'buy' | 'sell' | 'send';
  actionLabel: '建仓' | '加仓' | '减仓' | '清仓' | '发送' | null;
  actionVariant: 'open' | 'add' | 'reduce' | 'close' | 'send' | null;
  walletLabel: string | null;
  walletGroupLabel: string | null;
  walletAliasLabel: string | null;
  eventTimeMs: number;
  trackedAddress: string | null;
  monitorReconciliationStatus: Activity['metadata']['monitorReconciliationStatus'] | undefined;
  monitorReconciledSource: Activity['metadata']['monitorReconciledSource'] | null;
}): Promise<TelegramMonitorFeedRow> {
  const { user } = params;

  return {
    user,
    activity: await buildActivityFromSnapshot({
      user,
      chain: params.chain,
      tokenAddress: params.tokenAddress,
      tokenSymbol: params.tokenSymbol,
      txHash: params.txHash,
      marketCapUsd: params.marketCapUsd,
      quoteAmount: params.quoteAmount,
      quoteSymbol: params.quoteSymbol,
      tokenAmount: params.tokenAmount,
      explicitPriceUsd: params.explicitPriceUsd,
      rawText: params.rawText,
      action: params.action,
      actionLabel: params.actionLabel,
      actionVariant: params.actionVariant,
      walletLabel: params.walletLabel,
      walletGroupLabel: params.walletGroupLabel,
      walletAliasLabel: params.walletAliasLabel,
      eventTimeMs: params.eventTimeMs,
      trackedAddress: params.trackedAddress,
      monitorReconciliationStatus: params.monitorReconciliationStatus,
      monitorReconciledSource: params.monitorReconciledSource,
    }),
  };
}

function collectFallbackPersistCandidates(params: {
  events: TelegramMonitorFeedEvent[];
  projectedRows: Array<TelegramMonitorFeedRow | null>;
}) {
  const candidates: Array<{
    event: TelegramMonitorFeedEvent;
    row: TelegramMonitorFeedRow;
    stableId: string;
  }> = [];

  for (let index = 0; index < params.events.length; index += 1) {
    const event = params.events[index];
    const row = params.projectedRows[index];
    if (!row || event?.projectedActivity) {
      continue;
    }
    candidates.push({
      event,
      row,
      stableId: `fallback-${String(index).padStart(12, '0')}`,
    });
  }

  return candidates;
}

function scoreFallbackRowsForPersistence(candidates: Array<{
  event: TelegramMonitorFeedEvent;
  row: TelegramMonitorFeedRow;
  stableId: string;
}>) {
  if (candidates.length === 0) {
    return;
  }

  const scoredFallbackRows = scoreFeedRowsAgainstDatabase(
    candidates.map((item) => ({
      user: item.row.user,
      activity: item.row.activity,
      stableId: item.stableId,
    }))
  );
  const scoredByStableId = new Map(scoredFallbackRows.map((row) => [row.stableId || '', row] as const));

  for (const candidate of candidates) {
    const scored = scoredByStableId.get(candidate.stableId);
    if (!scored) {
      continue;
    }
    candidate.row.activity = scored.activity;
    updateTelegramMonitorEventProjectedActivityIfMissing({
      sourceChatId: candidate.event.sourceChatId ?? null,
      sourceMessageId: candidate.event.sourceMessageId ?? null,
      txHash: candidate.event.txHash ?? null,
      activity: scored.activity,
    });
  }
}

async function projectTelegramMonitorTxStateFeed(params: {
  users: User[];
  limit: number;
}): Promise<TelegramMonitorFeedRow[]> {
  const txStates = listRecentTelegramMonitorTxStates(params.limit);
  const projectedStates = await Promise.all(txStates.map((state) => projectTelegramMonitorTxState({ state, users: params.users })));
  return projectedStates.filter((item): item is TelegramMonitorFeedRow => Boolean(item));
}

async function projectTelegramMonitorFallbackFeed(params: {
  users: User[];
  limit: number;
}): Promise<TelegramMonitorFeedRow[]> {
  const fallbackEvents = listRecentTelegramMonitorFallbackEventsWithoutTxState(params.limit);
  const projectedFallbackEvents = await Promise.all(
    fallbackEvents.map((event) => projectTelegramMonitorEvent({ event, users: params.users }))
  );
  const fallbackPersistCandidates = collectFallbackPersistCandidates({
    events: fallbackEvents,
    projectedRows: projectedFallbackEvents,
  });

  scoreFallbackRowsForPersistence(fallbackPersistCandidates);

  return projectedFallbackEvents.filter((item): item is TelegramMonitorFeedRow => Boolean(item));
}

export async function projectTelegramMonitorEvent(params: {
  event: TelegramMonitorFeedEvent;
  users?: User[];
}): Promise<TelegramMonitorFeedRow | null> {
  const users = params.users || listTrackedUsers();
  const trackedAddressIndex = buildTrackedAddressIndex(users);
  const event = params.event;

  if (event.projectedActivity) {
    const persistedUser = users.find((candidate) => candidate.id === event.projectedActivity?.userId) || null;
    if (persistedUser) {
      return {
        user: persistedUser,
        activity: event.projectedActivity,
      };
    }
  }

  const fallbackParsed = event.rawText ? parseXxyyTelegramText(event.rawText, event.eventTimeMs, []) : null;

  const action = event.action || fallbackParsed?.action || null;
  const actionLabel = event.actionLabel || fallbackParsed?.actionLabel || null;
  const actionVariant = event.actionVariant || fallbackParsed?.actionVariant || null;
  const quoteAmount =
    event.quoteAmount ??
    (typeof fallbackParsed?.quoteAmount === 'number' && Number.isFinite(fallbackParsed.quoteAmount)
      ? fallbackParsed.quoteAmount
      : null);
  const quoteSymbol = event.quoteSymbol || fallbackParsed?.quoteSymbol || null;
  const tokenSymbol = event.tokenSymbol || fallbackParsed?.tokenSymbol || null;
  const tokenAmount =
    typeof fallbackParsed?.tokenAmount === 'number' && Number.isFinite(fallbackParsed.tokenAmount)
      ? fallbackParsed.tokenAmount
      : null;
  const explicitPriceUsd = event.priceUsd ?? fallbackParsed?.priceUsd ?? null;

  if (!action || !tokenSymbol) {
    return null;
  }

  const chain = normalize(event.chain) || 'bsc';
  const matched = pickMonitoredUser({
    eventWalletAliasLabel: event.walletAliasLabel || event.walletLabel,
    trackedWalletAddress: event.trackedWalletAddress,
    chain,
    users,
    trackedAddressIndex,
  });

  if (!matched?.user) {
    return null;
  }

  const user = matched.user;
  const trackedAddress = matched.trackedAddress || event.trackedWalletAddress || null;

  return buildProjectedTelegramMonitorFeedRow({
    user,
    chain,
    tokenAddress: event.tokenAddress,
    tokenSymbol,
    txHash: event.txHash,
    marketCapUsd: event.marketCapUsd,
    quoteAmount,
    quoteSymbol,
    tokenAmount,
    explicitPriceUsd,
    rawText: event.rawText,
    action,
    actionLabel,
    actionVariant,
    walletLabel: event.walletLabel,
    walletGroupLabel: event.walletGroupLabel,
    walletAliasLabel: event.walletAliasLabel,
    eventTimeMs: event.eventTimeMs,
    trackedAddress,
    monitorReconciliationStatus: event.txHash && trackedAddress ? 'pending' : undefined,
    monitorReconciledSource: event.txHash && trackedAddress ? 'xxyy' : null,
  });
}

export async function projectTelegramMonitorTxState(params: {
  state: TelegramMonitorTxState;
  users?: User[];
}): Promise<TelegramMonitorFeedRow | null> {
  const users = params.users || listTrackedUsers();
  const user = users.find((candidate) => candidate.id === params.state.userId);
  if (!user) {
    return null;
  }

  if (params.state.reconciliationStatus === 'reconciled' && params.state.canonicalActivity) {
    const repairedCanonicalActivity = await repairCollapsedCanonicalActivity({
      user,
      state: params.state,
      canonicalActivity: params.state.canonicalActivity,
    });
    persistHealedTelegramMonitorActivity({
      user,
      originalActivity: params.state.canonicalActivity,
      healedActivity: repairedCanonicalActivity,
    });
    return {
      user,
      activity: repairedCanonicalActivity,
    };
  }

  const provisionalAction = params.state.provisionalAction;
  const tokenSymbol = params.state.provisionalTokenSymbol || params.state.tokenSymbol;
  if (!provisionalAction || !params.state.tokenAddress || !tokenSymbol) {
    return null;
  }

  return buildProjectedTelegramMonitorFeedRow({
    user,
    chain: params.state.chain,
    tokenAddress: params.state.tokenAddress,
    tokenSymbol,
    txHash: params.state.txHash,
    marketCapUsd: params.state.provisionalMarketCapUsd,
    quoteAmount: params.state.provisionalQuoteAmount,
    quoteSymbol: params.state.provisionalQuoteSymbol,
    tokenAmount: params.state.provisionalTokenAmount,
    explicitPriceUsd: params.state.provisionalPriceUsd,
    rawText: params.state.provisionalRawText,
    action: provisionalAction,
    actionLabel: params.state.provisionalActionLabel,
    actionVariant: params.state.provisionalActionVariant,
    walletLabel: params.state.provisionalWalletLabel,
    walletGroupLabel: params.state.provisionalWalletGroupLabel,
    walletAliasLabel: params.state.provisionalWalletAliasLabel,
    eventTimeMs: params.state.eventTimeMs,
    trackedAddress: params.state.trackedWalletAddress,
    monitorReconciliationStatus: params.state.reconciliationStatus,
    monitorReconciledSource: params.state.reconciledSource || 'xxyy',
  });
}

export async function readTelegramMonitorFeed(limit = 200): Promise<TelegramMonitorFeedRow[]> {
  const users = listTrackedUsers();
  const stateFeed = await projectTelegramMonitorTxStateFeed({ users, limit });
  const fallbackFeed = await projectTelegramMonitorFallbackFeed({ users, limit });

  return dedupeTelegramMonitorFeedRows([...stateFeed, ...fallbackFeed])
    .sort((a, b) => b.activity.timestamp - a.activity.timestamp)
    .slice(0, Math.max(1, Math.min(2000, Math.floor(limit))));
}

function buildBidEventId(params: {
  sourceChatId: string | null;
  sourceMessageId: number | null;
  chain: string;
  trackedWalletAddress: string | null;
  txHash: string | null;
  tokenAddress: string;
  eventTimeMs: number;
}) {
  if (params.sourceChatId && typeof params.sourceMessageId === 'number') {
    return `xxyy:${params.sourceChatId}:${params.sourceMessageId}`;
  }

  return [
    'xxyy',
    params.chain,
    params.trackedWalletAddress || '',
    params.txHash || '',
    params.tokenAddress,
    String(params.eventTimeMs),
  ].join(':');
}

export async function readBidOnchainEvents(params?: {
  userIds?: string[];
  fromMs?: number | null;
  toMs?: number | null;
  cursor?: BidOnchainEventCursor | null;
  limit?: number;
}): Promise<{ events: BidOnchainEvent[]; nextCursor: string | null }> {
  const { listTelegramMonitorEvents } = await import('@/lib/server/telegramMonitorRepo');

  const safeLimit = Math.max(1, Math.min(500, Math.floor(params?.limit || 100)));
  const users = listTrackedUsers();
  const trackedAddressIndex = buildTrackedAddressIndex(users);
  const requestedUserIds = new Set((params?.userIds || []).map((value) => value.trim()).filter(Boolean));
  const feedEvents = listTelegramMonitorEvents({
    limit: Math.max(safeLimit * 20, 2000),
    fromMs: params?.fromMs ?? null,
    toMs: params?.toMs ?? null,
    cursor: params?.cursor
      ? {
          eventTimeMs: params.cursor.eventTimeMs,
          eventKey: params.cursor.eventId,
        }
      : null,
  });

  const results: BidOnchainEvent[] = [];
  for (const event of feedEvents) {
    const fallbackParsed = event.rawText ? parseXxyyTelegramText(event.rawText, event.eventTimeMs, []) : null;
    const action = event.action || fallbackParsed?.action || null;
    const actionVariant = event.actionVariant || fallbackParsed?.actionVariant || null;
    const tokenSymbol = event.tokenSymbol || fallbackParsed?.tokenSymbol || null;
    if (!action || !actionVariant || !tokenSymbol) {
      continue;
    }

    const chain = normalize(event.chain) || 'bsc';
    const matched = pickMonitoredUser({
      eventWalletAliasLabel: event.walletAliasLabel || event.walletLabel,
      trackedWalletAddress: event.trackedWalletAddress,
      chain,
      users,
      trackedAddressIndex,
    });
    if (!matched?.user) {
      continue;
    }
    if (requestedUserIds.size > 0 && !requestedUserIds.has(matched.user.id)) {
      continue;
    }

    const trackedWalletAddress = matched.trackedAddress || event.trackedWalletAddress || '';
    if (!trackedWalletAddress) {
      continue;
    }

    const eventId = buildBidEventId({
      sourceChatId: event.sourceChatId ?? null,
      sourceMessageId: event.sourceMessageId ?? null,
      chain,
      trackedWalletAddress: event.trackedWalletAddress,
      txHash: event.txHash,
      tokenAddress: event.tokenAddress,
      eventTimeMs: event.eventTimeMs,
    });

    results.push({
      eventId,
      userId: matched.user.id,
      chain,
      trackedWalletAddress,
      trackedWalletAddressRaw: trackedWalletAddress,
      tokenAddress: event.tokenAddress,
      tokenSymbol,
      txHash: event.txHash,
      action,
      actionVariant,
      eventTimeMs: event.eventTimeMs,
      walletAliasLabel: event.walletAliasLabel,
      walletGroupLabel: event.walletGroupLabel,
      marketCapUsd: event.marketCapUsd,
      messageLinks: event.messageLinks || [],
    });

    if (results.length >= safeLimit) {
      break;
    }
  }

  const nextCursor =
    results.length === safeLimit
      ? JSON.stringify({
          eventTimeMs: results[results.length - 1].eventTimeMs,
          eventId: results[results.length - 1].eventId,
        })
      : null;

  return {
    events: results,
    nextCursor,
  };
}
