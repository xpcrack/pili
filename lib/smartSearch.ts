import type { Activity, User } from '@/types';

export interface FeedItem {
  user: User;
  activity: Activity;
}

export interface FeedSearchFilters {
  keyword: string;
  typeFilters: {
    trade: boolean;
    transfer: boolean;
    twitter: boolean;
  };
  minTradeAmountUsd: string;
  minTradeMarketCapUsd: string;
}

export const DEFAULT_FEED_SEARCH_FILTERS: FeedSearchFilters = {
  keyword: '',
  typeFilters: {
    trade: true,
    transfer: true,
    twitter: true,
  },
  minTradeAmountUsd: '',
  minTradeMarketCapUsd: '',
};

export type FeedItemCategory = 'trade' | 'transfer' | 'twitter' | 'other';

function normalizeText(value: string | undefined | null) {
  return (value || '').trim().toLowerCase();
}

function getKeywordTerms(keyword: string) {
  return keyword
    .split(/\s+/)
    .map((term) => normalizeText(term))
    .filter(Boolean);
}

function toComparableNumber(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const parsed = Number.parseFloat(trimmed.replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function getKeywordHaystack(item: FeedItem) {
  const values = [
    item.user.name,
    item.activity.metadata.tokenAddress,
    item.activity.metadata.fromAddress,
    item.activity.metadata.toAddress,
    item.activity.metadata.trackedAddress,
  ];

  if (item.activity.source === 'twitter') {
    values.push(item.activity.content);
  }

  return values
    .map((value) => normalizeText(value))
    .filter(Boolean);
}

function matchesKeyword(item: FeedItem, keyword: string) {
  const terms = getKeywordTerms(keyword);
  if (terms.length === 0) return true;

  const haystack = getKeywordHaystack(item);
  return terms.some((term) => haystack.some((value) => value.includes(term)));
}

function matchesTradeThreshold(
  actualValue: number | undefined,
  thresholdValue: string
) {
  const threshold = toComparableNumber(thresholdValue);
  if (threshold === null) return true;
  if (typeof actualValue !== 'number' || Number.isNaN(actualValue)) return false;
  return actualValue >= threshold;
}

export function getFeedItemCategory(item: FeedItem): FeedItemCategory {
  if (item.activity.source === 'twitter') {
    return 'twitter';
  }

  const action = item.activity.metadata.txAction;
  if (action === 'buy' || action === 'sell') {
    return 'trade';
  }
  if (action === 'send' || action === 'receive') {
    return 'transfer';
  }

  return 'other';
}

export function hasAnyEnabledFeedType(typeFilters: FeedSearchFilters['typeFilters']) {
  return typeFilters.trade || typeFilters.transfer || typeFilters.twitter;
}

export function matchesFeedSearchFilters(item: FeedItem, filters: FeedSearchFilters) {
  if (!matchesKeyword(item, filters.keyword)) {
    return false;
  }

  const category = getFeedItemCategory(item);
  if (category === 'trade' && !filters.typeFilters.trade) {
    return false;
  }
  if (category === 'transfer' && !filters.typeFilters.transfer) {
    return false;
  }
  if (category === 'twitter' && !filters.typeFilters.twitter) {
    return false;
  }
  if (category === 'other') {
    return false;
  }

  if (category !== 'trade') {
    return true;
  }

  return (
    matchesTradeThreshold(item.activity.metadata.tradeAmountUsdAtTx, filters.minTradeAmountUsd) &&
    matchesTradeThreshold(item.activity.metadata.marketCapAtTxUsd, filters.minTradeMarketCapUsd)
  );
}
