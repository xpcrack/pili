import 'server-only';

import { buildTelegramMonitorTxAggregateKey } from '@/lib/telegramMonitorIdentity';
import {
  listRecentTelegramMonitorFallbackEventsWithoutTxState,
  type TelegramMonitorFeedEvent,
} from '@/lib/server/telegramMonitorRepo';
import {
  listRecentTelegramMonitorTxStates,
  type TelegramMonitorTxState,
} from '@/lib/server/telegramMonitorTxStateRepo';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import { parseXxyyTelegramText } from '@/lib/server/xxyyTelegramParser';
import { buildTradeDisplayMetadata } from '@/lib/tradeDisplay';
import { resolveTradeAmountUsdAtTx } from '@/lib/tradeUsd';
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

function normalizeAliasLabel(value: string | null | undefined) {
  return (value || '')
    .trim()
    .toLowerCase()
    .replace(/#/g, '');
}

function isEvmChain(chain: string | null | undefined) {
  return chain === 'bsc' || chain === 'ethereum' || chain === 'base';
}

function isCompatibleChain(addressChain: string, eventChain: string) {
  if (addressChain === eventChain) {
    return true;
  }
  return isEvmChain(addressChain) && isEvmChain(eventChain);
}

function buildTrackedAddressIndex(users: User[]) {
  const index = new Map<string, { user: User; trackedAddress: string }>();

  for (const user of users) {
    for (const address of user.addresses) {
      const key = `${normalize(address.chain)}|${normalize(address.address)}`;
      if (!key.endsWith('|')) {
        index.set(key, {
          user,
          trackedAddress: address.address,
        });

        if (isEvmChain(address.chain)) {
          for (const evmChain of ['bsc', 'ethereum', 'base']) {
            index.set(`${evmChain}|${normalize(address.address)}`, {
              user,
              trackedAddress: address.address,
            });
          }
        }
      }
    }
  }

  return index;
}

function pickMonitoredUser(params: {
  eventWalletAliasLabel: string | null;
  trackedWalletAddress: string | null;
  chain: string;
  users: User[];
  trackedAddressIndex: Map<string, { user: User; trackedAddress: string }>;
}) {
  const { eventWalletAliasLabel, trackedWalletAddress, chain, users, trackedAddressIndex } = params;
  const trackedKey = `${normalize(chain)}|${normalize(trackedWalletAddress)}`;
  const matchedByAddress = trackedAddressIndex.get(trackedKey);
  if (matchedByAddress) {
    return matchedByAddress;
  }

  const aliasLabel = normalizeAliasLabel(eventWalletAliasLabel);
  if (!aliasLabel) {
    return null;
  }

  for (const user of users) {
    const userName = normalizeAliasLabel(user.name);
    if (aliasLabel === userName) {
      return {
        user,
        trackedAddress: user.addresses[0]?.address || null,
      };
    }

    for (const address of user.addresses) {
      if (!isCompatibleChain(normalize(address.chain), normalize(chain))) {
        continue;
      }
      const alias = `${normalizeAliasLabel(user.name)}${normalizeAliasLabel(address.name)}`;
      const explicitAlias = address.name.startsWith('#')
        ? `${normalizeAliasLabel(user.name)}${normalizeAliasLabel(address.name)}`
        : `${normalizeAliasLabel(user.name)}${normalizeAliasLabel(`#${address.name}`)}`;
      if (aliasLabel === alias || aliasLabel === explicitAlias || aliasLabel === normalizeAliasLabel(address.name)) {
        return {
          user,
          trackedAddress: address.address,
        };
      }
    }
  }

  return null;
}

interface MonitorActivitySnapshot {
  user: User;
  chain: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  txHash: string | null;
  marketCapUsd: number | null;
  quoteAmount: number | null;
  quoteSymbol: string | null;
  tokenAmount: number | null;
  explicitPriceUsd: number | null;
  rawText: string | null;
  action: 'buy' | 'sell' | 'send' | null;
  actionLabel: '建仓' | '加仓' | '减仓' | '清仓' | '发送' | null;
  actionVariant: 'open' | 'add' | 'reduce' | 'close' | 'send' | null;
  walletLabel: string | null;
  walletGroupLabel: string | null;
  walletAliasLabel: string | null;
  eventTimeMs: number;
  trackedAddress: string | null;
  monitorReconciliationStatus?: 'pending' | 'reconciled' | 'failed';
  monitorReconciledSource?: 'xxyy' | 'okx-address' | 'okx-detail' | null;
}

async function buildActivityFromSnapshot(params: MonitorActivitySnapshot) {
  const {
    user,
    chain,
    tokenAddress,
    tokenSymbol,
    txHash,
    marketCapUsd,
    quoteAmount,
    quoteSymbol,
    tokenAmount,
    explicitPriceUsd,
    rawText,
    action,
    actionLabel,
    actionVariant,
    walletLabel,
    walletGroupLabel,
    walletAliasLabel,
    eventTimeMs,
    trackedAddress,
    monitorReconciliationStatus,
    monitorReconciledSource,
  } = params;

  const aggregateKey = buildTelegramMonitorTxAggregateKey(chain, trackedAddress, txHash);
  const actionText =
    actionLabel || (action === 'sell' ? '减仓' : action === 'buy' ? '建仓' : action === 'send' ? '发送' : '交易');
  const quoteText =
    typeof quoteAmount === 'number' && Number.isFinite(quoteAmount) && quoteSymbol
      ? `${quoteAmount}${quoteSymbol.toUpperCase()}`
      : '';
  const symbolText = (tokenSymbol || 'TOKEN').toUpperCase();
  const fallbackTokenText =
    typeof tokenAmount === 'number' && Number.isFinite(tokenAmount) ? `${tokenAmount} ${symbolText}` : symbolText;
  const displayMetadata = buildTradeDisplayMetadata({
    rawText,
    walletLabel,
    fallbackWalletLabel: user.name,
    actionVariant,
    txActionLabel: actionLabel,
    quoteAmount,
    quoteToken: quoteSymbol,
    value: typeof tokenAmount === 'number' && Number.isFinite(tokenAmount) ? String(tokenAmount) : null,
    tokenSymbol,
    marketCapUsd,
    tokenAddress,
  });
  const tradeAmountUsdAtTx =
    action === 'buy' || action === 'sell'
      ? await resolveTradeAmountUsdAtTx({
          chain,
          txTimestampMs: eventTimeMs,
          token: tokenSymbol,
          value: typeof tokenAmount === 'number' && Number.isFinite(tokenAmount) ? String(tokenAmount) : null,
          quoteToken: quoteSymbol,
          quoteAmount: typeof quoteAmount === 'number' && Number.isFinite(quoteAmount) ? String(quoteAmount) : null,
          explicitPriceUsd,
        })
      : null;

  return {
    id: aggregateKey || `xxyy-monitor:${chain}:${txHash || tokenAddress}:${eventTimeMs}`,
    userId: user.id,
    source: 'blockchain',
    type: 'transfer',
    title: 'XXYY监控交易',
    content: `${actionText}${quoteText ? quoteText : ` ${fallbackTokenText}`}`.trim(),
    timestamp: eventTimeMs,
    metadata: {
      txHash: txHash || undefined,
      token: tokenSymbol || undefined,
      tokenAddress,
      quoteAmount:
        typeof quoteAmount === 'number' && Number.isFinite(quoteAmount) ? String(quoteAmount) : undefined,
      quoteToken: quoteSymbol || undefined,
      chain,
      txAction: action || undefined,
      txActionLabel: actionLabel || undefined,
      txActionVariant: actionVariant || undefined,
      value: typeof tokenAmount === 'number' && Number.isFinite(tokenAmount) ? String(tokenAmount) : undefined,
      trackedAddress: trackedAddress || undefined,
      rawText: rawText || undefined,
      monitorWalletLabel: walletLabel || undefined,
      monitorWalletGroupLabel: walletGroupLabel || undefined,
      monitorWalletAliasLabel: walletAliasLabel || undefined,
      marketCapAtTxUsd:
        typeof marketCapUsd === 'number' && Number.isFinite(marketCapUsd) ? marketCapUsd : undefined,
      tradeAmountUsdAtTx: tradeAmountUsdAtTx ?? undefined,
      marketCapAtTxSource:
        typeof marketCapUsd === 'number' && Number.isFinite(marketCapUsd) ? 'telegram-monitor-exact' : undefined,
      monitorReconciliationStatus: monitorReconciliationStatus || undefined,
      monitorReconciledSource: monitorReconciledSource || undefined,
      monitorTxAggregateKey: aggregateKey || undefined,
      ...displayMetadata,
    },
  } satisfies Activity;
}

export async function projectTelegramMonitorEvent(params: {
  event: TelegramMonitorFeedEvent;
  users?: User[];
}): Promise<TelegramMonitorFeedRow | null> {
  const users = params.users || listTrackedUsers();
  const trackedAddressIndex = buildTrackedAddressIndex(users);
  const event = params.event;

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

  return {
    user,
    activity: await buildActivityFromSnapshot({
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
      monitorReconciliationStatus:
        event.txHash && trackedAddress
          ? 'pending'
          : undefined,
      monitorReconciledSource: event.txHash && trackedAddress ? 'xxyy' : null,
    }),
  };
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

  if (params.state.canonicalActivity) {
    return {
      user,
      activity: params.state.canonicalActivity,
    };
  }

  const provisionalAction = params.state.provisionalAction;
  const tokenSymbol = params.state.provisionalTokenSymbol || params.state.tokenSymbol;
  if (!provisionalAction || !params.state.tokenAddress || !tokenSymbol) {
    return null;
  }

  return {
    user,
    activity: await buildActivityFromSnapshot({
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
    }),
  };
}

export async function readTelegramMonitorFeed(limit = 200): Promise<TelegramMonitorFeedRow[]> {
  const users = listTrackedUsers();
  const txStates = listRecentTelegramMonitorTxStates(limit);
  const projectedStates = await Promise.all(txStates.map((state) => projectTelegramMonitorTxState({ state, users })));
  const stateFeed = projectedStates.filter((item): item is TelegramMonitorFeedRow => Boolean(item));

  const fallbackEvents = listRecentTelegramMonitorFallbackEventsWithoutTxState(limit);
  const projectedFallbackEvents = await Promise.all(
    fallbackEvents.map((event) => projectTelegramMonitorEvent({ event, users }))
  );
  const fallbackFeed = projectedFallbackEvents.filter((item): item is TelegramMonitorFeedRow => Boolean(item));

  const deduped = new Map<string, TelegramMonitorFeedRow>();
  for (const item of [...stateFeed, ...fallbackFeed]) {
    const key =
      item.activity.metadata.monitorTxAggregateKey ||
      [
        normalize(item.activity.metadata.chain),
        normalize(item.activity.metadata.trackedAddress),
        normalize(item.activity.metadata.txHash),
      ]
        .filter(Boolean)
        .join(':') ||
      item.activity.id;
    const existing = deduped.get(key);
    if (!existing || item.activity.timestamp >= existing.activity.timestamp) {
      deduped.set(key, item);
    }
  }

  return Array.from(deduped.values())
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
