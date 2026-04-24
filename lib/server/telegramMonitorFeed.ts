import 'server-only';

import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import { listRecentTelegramMonitorEvents, type TelegramMonitorFeedEvent } from '@/lib/server/telegramMonitorRepo';
import { buildTradeDisplayMetadata } from '@/lib/tradeDisplay';
import { resolveTradeAmountUsdAtTx } from '@/lib/tradeUsd';
import { parseXxyyTelegramText } from '@/lib/server/xxyyTelegramParser';
import type { Activity, User } from '@/types';

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
            const evmKey = `${evmChain}|${normalize(address.address)}`;
            index.set(evmKey, {
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

async function buildActivityFromEvent(params: {
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
}) {
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
  } = params;

  const actionText = actionLabel || (action === 'sell' ? '减仓' : action === 'buy' ? '建仓' : action === 'send' ? '发送' : '交易');
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

  const activity: Activity = {
    id: `xxyy-monitor:${chain}:${txHash || tokenAddress}:${eventTimeMs}`,
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
      ...displayMetadata,
    },
  };

  return activity;
}

export async function projectTelegramMonitorEvent(params: {
  event: TelegramMonitorFeedEvent;
  users?: User[];
}) {
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
    activity: await buildActivityFromEvent({
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
    }),
  };
}

export async function readTelegramMonitorFeed(limit = 200) {
  const events = listRecentTelegramMonitorEvents(limit);
  const users = listTrackedUsers();
  const projected = await Promise.all(events.map((event) => projectTelegramMonitorEvent({ event, users })));
  const feed = projected.filter((item): item is { user: User; activity: Activity } => Boolean(item));

  const deduped = new Map<string, { user: User; activity: Activity }>();
  for (const item of feed) {
    const txKey = item.activity.metadata.txHash?.toLowerCase();
    const key = txKey ? `tx:${txKey}` : `event:${item.activity.id}`;
    const existing = deduped.get(key);
    if (!existing || item.activity.timestamp >= existing.activity.timestamp) {
      deduped.set(key, item);
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => b.activity.timestamp - a.activity.timestamp)
    .slice(0, Math.max(1, Math.min(2000, Math.floor(limit))));
}
