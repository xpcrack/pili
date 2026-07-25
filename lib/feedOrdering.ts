import type { Activity, User } from '@/types';
import { buildActivityGlobalDedupKey } from '@/lib/activityIdentity';
import {
  formatCompactMarketCap,
  formatDisplayTradeAmount,
  fillPositionDeltaRatios,
  resolveTradeTokenAmount,
} from '@/lib/tradeDisplay';

export interface FeedItem {
  user: User;
  activity: Activity;
}

const SHORT_TRADE_MERGE_WINDOW_MS = 5 * 60_000;

type MergeDirectionKey = 'buy' | 'sell' | 'send' | 'receive';
type MergeAmountSource = 'quoteAmount' | 'value';

interface TradeMergeDescriptor {
  signature: string;
  amountSource: MergeAmountSource;
  amountSymbol: string;
}

interface FeedEntry {
  item: FeedItem;
  originalIndex: number;
}

interface TradeMergeGroup {
  descriptor: TradeMergeDescriptor;
  entries: FeedEntry[];
  latestTimestamp: number;
}

function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

function parsePositiveAmount(value: string | number | null | undefined) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const parsed = Number.parseFloat(value.trim().replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveCounterpartyIdentifier(activity: Activity) {
  const trackedAddress = normalize(activity.metadata.trackedAddress);
  const fromAddress = normalize(activity.metadata.fromAddress);
  const toAddress = normalize(activity.metadata.toAddress);

  if (trackedAddress) {
    if (fromAddress === trackedAddress && toAddress) {
      return toAddress;
    }
    if (toAddress === trackedAddress && fromAddress) {
      return fromAddress;
    }
  }

  return toAddress || fromAddress || '';
}

function resolveTradeDirectionKey(activity: Activity): MergeDirectionKey | null {
  const displayLabel = normalize(activity.metadata.displayActionVariantLabel);
  if (displayLabel === '建仓' || displayLabel === '加仓') return 'buy';
  if (displayLabel === '减仓' || displayLabel === '清仓') return 'sell';

  const variant = normalize(activity.metadata.txActionVariant);
  if (variant === 'open' || variant === 'add') return 'buy';
  if (variant === 'reduce' || variant === 'close') return 'sell';

  const label = normalize(activity.metadata.txActionLabel);
  if (label === '建仓' || label === '加仓') return 'buy';
  if (label === '减仓' || label === '清仓') return 'sell';

  const action = normalize(activity.metadata.txAction);
  if (action === 'buy') return 'buy';
  if (action === 'sell') return 'sell';
  if (action === 'send') return 'send';
  if (action === 'receive') return 'receive';

  return null;
}

function buildTradeMergeDescriptor(item: FeedItem): TradeMergeDescriptor | null {
  const { activity, user } = item;
  if (activity.source !== 'blockchain' || activity.type !== 'transfer') {
    return null;
  }

  const directionKey = resolveTradeDirectionKey(activity);
  if (!directionKey) {
    return null;
  }

  const trackedAddress = normalize(activity.metadata.trackedAddress);
  const chain = normalize(activity.metadata.chain);
  const tokenIdentifier = normalize(
    activity.metadata.displayTokenAvatarTokenAddress ||
      activity.metadata.tokenAddress ||
      activity.metadata.token
  );
  const quoteToken = normalize(activity.metadata.quoteToken);
  const tokenSymbol = normalize(activity.metadata.token);
  const amountSymbol = quoteToken || tokenSymbol;
  const amountSource: MergeAmountSource = quoteToken ? 'quoteAmount' : 'value';
  const counterpartyIdentifier =
    directionKey === 'send' || directionKey === 'receive'
      ? resolveCounterpartyIdentifier(activity)
      : '';

  if (
    !trackedAddress ||
    !chain ||
    !tokenIdentifier ||
    !amountSymbol ||
    ((directionKey === 'send' || directionKey === 'receive') && !counterpartyIdentifier)
  ) {
    return null;
  }

  // Signature intentionally omits trackedAddress so multi-wallet same-user
  // same-token same-direction trades collapse to one card; address count is
  // still aggregated via coHitAddresses in mergeTradeGroup.
  return {
    signature: [
      user.id,
      chain,
      tokenIdentifier,
      directionKey,
      amountSource,
      amountSymbol,
      counterpartyIdentifier || '-',
    ].join(':'),
    amountSource,
    amountSymbol: amountSymbol.toUpperCase(),
  };
}

function sortFeedEntries(entries: FeedEntry[]) {
  return [...entries].sort((left, right) => {
    const timeDelta = right.item.activity.timestamp - left.item.activity.timestamp;
    if (timeDelta !== 0) {
      return timeDelta;
    }
    return left.originalIndex - right.originalIndex;
  });
}

export function mergeGlobalFeedByPrimaryKey(feed: FeedItem[]) {
  const merged = new Map<string, FeedItem>();

  for (const item of feed) {
    const key = buildActivityGlobalDedupKey(item.activity);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, item);
      continue;
    }

    const representative =
      item.activity.timestamp >= existing.activity.timestamp ? item : existing;
    const counterpart = representative === item ? existing : item;

    const userNames = new Set([
      ...(representative.activity.metadata.coHitUserNames || [representative.user.name]),
      ...(counterpart.activity.metadata.coHitUserNames || [counterpart.user.name]),
    ]);

    const addresses = new Set([
      ...(representative.activity.metadata.coHitAddresses || []).map((value) => value.toLowerCase()),
      ...(counterpart.activity.metadata.coHitAddresses || []).map((value) => value.toLowerCase()),
      representative.activity.metadata.trackedAddress?.toLowerCase() || '',
      counterpart.activity.metadata.trackedAddress?.toLowerCase() || '',
    ]);
    addresses.delete('');

    merged.set(key, {
      ...representative,
      activity: {
        ...representative.activity,
        metadata: {
          ...representative.activity.metadata,
          coHitUserCount: userNames.size,
          coHitAddressCount: addresses.size,
          coHitUserNames: Array.from(userNames),
          coHitAddresses: Array.from(addresses),
        },
      },
    });
  }

  return Array.from(merged.values()).sort((a, b) => b.activity.timestamp - a.activity.timestamp);
}

function mergeTradeGroup(group: TradeMergeGroup): FeedItem {
  const representative = group.entries[0]!.item;
  if (group.entries.length <= 1) {
    return representative;
  }

  const coHitUserNames = new Set<string>();
  const coHitAddresses = new Set<string>();
  for (const entry of group.entries) {
    const names = entry.item.activity.metadata.coHitUserNames || [entry.item.user.name];
    for (const name of names) {
      if (name) {
        coHitUserNames.add(name);
      }
    }

    const addresses = entry.item.activity.metadata.coHitAddresses || [];
    for (const address of addresses) {
      const normalizedAddress = normalize(address);
      if (normalizedAddress) {
        coHitAddresses.add(normalizedAddress);
      }
    }

    const trackedAddress = normalize(entry.item.activity.metadata.trackedAddress);
    if (trackedAddress) {
      coHitAddresses.add(trackedAddress);
    }
  }

  const amountTotal = group.entries.reduce((sum, entry) => {
    const value =
      group.descriptor.amountSource === 'quoteAmount'
        ? parsePositiveAmount(entry.item.activity.metadata.quoteAmount)
        : parsePositiveAmount(entry.item.activity.metadata.value);
    return sum + (value ?? 0);
  }, 0);

  // When the preferred amount source is empty/zero (common on TG: quoteAmount=0 +
  // quoteToken=ETH), fall back to summing token `value` so the card shows a real
  // total instead of a single representative leg.
  let resolvedAmountTotal = amountTotal;
  let resolvedAmountSymbol = group.descriptor.amountSymbol;
  if (resolvedAmountTotal <= 0 && group.descriptor.amountSource === 'quoteAmount') {
    const valueTotal = group.entries.reduce((sum, entry) => {
      return sum + (parsePositiveAmount(entry.item.activity.metadata.value) ?? 0);
    }, 0);
    if (valueTotal > 0) {
      resolvedAmountTotal = valueTotal;
      const tokenSymbol = group.entries
        .map((entry) => (entry.item.activity.metadata.token || '').trim())
        .find((symbol) => symbol.length > 0);
      if (tokenSymbol) {
        resolvedAmountSymbol = tokenSymbol.toUpperCase();
      }
    }
  }

  const weightedMarketCap = group.entries.reduce(
    (accumulator, entry) => {
      let amount =
        group.descriptor.amountSource === 'quoteAmount'
          ? parsePositiveAmount(entry.item.activity.metadata.quoteAmount)
          : parsePositiveAmount(entry.item.activity.metadata.value);
      if ((!amount || amount <= 0) && group.descriptor.amountSource === 'quoteAmount') {
        amount = parsePositiveAmount(entry.item.activity.metadata.value);
      }
      const marketCap = entry.item.activity.metadata.marketCapAtTxUsd;
      if (!amount || typeof marketCap !== 'number' || !Number.isFinite(marketCap) || marketCap <= 0) {
        return accumulator;
      }

      return {
        weightedSum: accumulator.weightedSum + marketCap * amount,
        totalWeight: accumulator.totalWeight + amount,
      };
    },
    { weightedSum: 0, totalWeight: 0 }
  );

  const mergedAverageMarketCapUsd =
    weightedMarketCap.totalWeight > 0 ? weightedMarketCap.weightedSum / weightedMarketCap.totalWeight : null;
  const mergedTradeAmountText =
    resolvedAmountTotal > 0
      ? formatDisplayTradeAmount(resolvedAmountTotal, resolvedAmountSymbol)
      : representative.activity.metadata.displayTradeAmountText;

  // USD column is independent of displayTradeAmountText — sum every leg so
  // merged cards don't keep only the representative row's tradeAmountUsdAtTx.
  const mergedTradeAmountUsdAtTx = group.entries.reduce((sum, entry) => {
    const usd = entry.item.activity.metadata.tradeAmountUsdAtTx;
    if (typeof usd === 'number' && Number.isFinite(usd) && usd > 0) {
      return sum + usd;
    }
    return sum;
  }, 0);

  // Prefer combined position % vs balance before earliest leg (not latest-only).
  const chronological = [...group.entries].sort((left, right) => {
    const timeDelta = left.item.activity.timestamp - right.item.activity.timestamp;
    if (timeDelta !== 0) return timeDelta;
    return left.originalIndex - right.originalIndex;
  });
  let mergedPositionDeltaRatio =
    typeof representative.activity.metadata.positionDeltaRatio === 'number' &&
    Number.isFinite(representative.activity.metadata.positionDeltaRatio)
      ? representative.activity.metadata.positionDeltaRatio
      : null;
  const direction = resolveTradeDirectionKey(representative.activity);
  if (direction === 'buy' || direction === 'sell') {
    const first = chronological[0]!.item.activity;
    const firstRatio =
      typeof first.metadata.positionDeltaRatio === 'number' && Number.isFinite(first.metadata.positionDeltaRatio)
        ? first.metadata.positionDeltaRatio
        : null;
    const firstAmount = resolveTradeTokenAmount(first);
    const totalTokenAmount = chronological.reduce((sum, entry) => {
      return sum + (resolveTradeTokenAmount(entry.item.activity) ?? 0);
    }, 0);
    const anyClose = chronological.some((entry) => {
      const variant = normalize(entry.item.activity.metadata.txActionVariant);
      const label = normalize(
        entry.item.activity.metadata.displayActionVariantLabel || entry.item.activity.metadata.txActionLabel
      );
      return variant === 'close' || label === '清仓';
    });
    if (anyClose && direction === 'sell') {
      mergedPositionDeltaRatio = -1;
    } else if (firstRatio != null && firstAmount != null && firstAmount > 0 && totalTokenAmount > 0) {
      const before =
        direction === 'buy'
          ? firstRatio !== 0
            ? firstAmount / firstRatio
            : null
          : firstRatio !== 0
            ? firstAmount / -firstRatio
            : null;
      if (before != null && before > 0) {
        mergedPositionDeltaRatio = direction === 'buy' ? totalTokenAmount / before : -totalTokenAmount / before;
      }
    }
  }

  return {
    ...representative,
    activity: {
      ...representative.activity,
      metadata: {
        ...representative.activity.metadata,
        displayTradeAmountText: mergedTradeAmountText || representative.activity.metadata.displayTradeAmountText,
        ...(mergedTradeAmountUsdAtTx > 0 ? { tradeAmountUsdAtTx: mergedTradeAmountUsdAtTx } : {}),
        displayMarketCapText:
          mergedAverageMarketCapUsd && formatCompactMarketCap(mergedAverageMarketCapUsd)
            ? formatCompactMarketCap(mergedAverageMarketCapUsd) || undefined
            : undefined,
        coHitUserCount: coHitUserNames.size,
        coHitAddressCount: coHitAddresses.size,
        coHitUserNames: Array.from(coHitUserNames),
        coHitAddresses: Array.from(coHitAddresses),
        mergedTradeCount: group.entries.length,
        mergedTradeWindowMs: SHORT_TRADE_MERGE_WINDOW_MS,
        mergedTradeAverageMarketCapUsd: mergedAverageMarketCapUsd,
        ...(mergedPositionDeltaRatio != null ? { positionDeltaRatio: mergedPositionDeltaRatio } : {}),
      },
    },
  };
}

export function mergeShortWindowSimilarTrades(feed: FeedItem[]) {
  const sortedEntries = sortFeedEntries(feed.map((item, originalIndex) => ({ item, originalIndex })));
  const openGroups = new Map<string, TradeMergeGroup>();
  const grouped: TradeMergeGroup[] = [];

  for (const entry of sortedEntries) {
    const descriptor = buildTradeMergeDescriptor(entry.item);
    if (!descriptor) {
      grouped.push({
        descriptor: {
          signature: `single:${entry.originalIndex}`,
          amountSource: 'value',
          amountSymbol: '',
        },
        entries: [entry],
        latestTimestamp: entry.item.activity.timestamp,
      });
      continue;
    }

    const existingGroup = openGroups.get(descriptor.signature);
    if (
      existingGroup &&
      existingGroup.latestTimestamp - entry.item.activity.timestamp <= SHORT_TRADE_MERGE_WINDOW_MS
    ) {
      existingGroup.entries.push(entry);
      continue;
    }

    const nextGroup: TradeMergeGroup = {
      descriptor,
      entries: [entry],
      latestTimestamp: entry.item.activity.timestamp,
    };
    openGroups.set(descriptor.signature, nextGroup);
    grouped.push(nextGroup);
  }

  return grouped
    .map((group) => ({
      item: mergeTradeGroup(group),
      originalIndex: group.entries[0]!.originalIndex,
    }))
    .sort((left, right) => {
      const timeDelta = right.item.activity.timestamp - left.item.activity.timestamp;
      if (timeDelta !== 0) {
        return timeDelta;
      }
      return left.originalIndex - right.originalIndex;
    })
    .map((entry) => entry.item);
}

export function prepareUserFeed(feed: FeedItem[]) {
  return mergeShortWindowSimilarTrades(fillPositionDeltaRatios(feed));
}

export function prepareGlobalFeed(feed: FeedItem[]) {
  return mergeShortWindowSimilarTrades(fillPositionDeltaRatios(mergeGlobalFeedByPrimaryKey(feed)));
}
