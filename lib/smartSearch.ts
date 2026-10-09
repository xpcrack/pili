import type { Activity, User } from '@/types';
import { isTradeDisplayAction } from '@/lib/tradeDisplay';

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
    telegram: boolean;
    fomo: boolean;
    news: boolean;
  };
  minTradeAmountUsd: string;
  minTradeMarketCapUsd: string;
  /**
   * CA 搜索扩展（两个独立开关，只在关键词像地址时有意义）：
   * - expandTicker：把「正文只提 ticker 没贴 CA」的推文也并进命中集。
   *   ticker 一定有（币必有 symbol），推文不一定贴 CA —— 所以和官推扩展分开。
   * - expandOfficialTweets：把「官推相关」的推文也并进命中集（正文 @ 官推 + 官推自己发的推）。
   *   官推不一定有（有的币没官推 / twitter_url 未填），所以也单独控制。
   */
  expandTicker: boolean;
  expandOfficialTweets: boolean;
}

export const DEFAULT_FEED_SEARCH_FILTERS: FeedSearchFilters = {
  keyword: '',
  typeFilters: {
    trade: true,
    // v1 交易 Feed 默认降权转账；需要时再手动打开
    transfer: false,
    twitter: true,
    telegram: true,
    fomo: true,
    news: false,
  },
  minTradeAmountUsd: '',
  minTradeMarketCapUsd: '',
  expandTicker: false,
  expandOfficialTweets: false,
};

export type FeedItemCategory = 'trade' | 'transfer' | 'twitter' | 'telegram' | 'fomo' | 'news' | 'other';

const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * 关键词是否像一个代币合约地址（EVM 0x40hex / Solana base58 32-44）。
 * 用于决定是否显示「CA 扩展」开关（含 Ticker 提及 / 含官推推文）。
 * Solana base58 与普通单词有重叠，只影响 UI 显隐，不影响服务端安全性 ——
 * 服务端扩展开关对非 CA 查询自动退化（mentions 表查无该地址 = 空扩展集）。
 */
export function looksLikeTokenAddress(keyword: string) {
  const trimmed = keyword.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (trimmed.toLowerCase().startsWith('ca:')) {
    return EVM_ADDRESS_PATTERN.test(trimmed.slice(3)) || SOLANA_ADDRESS_PATTERN.test(trimmed.slice(3));
  }
  return EVM_ADDRESS_PATTERN.test(trimmed) || SOLANA_ADDRESS_PATTERN.test(trimmed);
}

export function getRemoteFeedSource(
  typeFilters: FeedSearchFilters['typeFilters']
): Activity['source'] | null {
  const enabledSources: Activity['source'][] = [];

  if (typeFilters.trade || typeFilters.transfer) {
    enabledSources.push('blockchain');
  }
  if (typeFilters.twitter) {
    enabledSources.push('twitter');
  }
  if (typeFilters.telegram) {
    enabledSources.push('telegram');
  }
  if (typeFilters.fomo) {
    enabledSources.push('fomo');
  }

  return enabledSources.length === 1 ? enabledSources[0] : null;
}

function normalizeText(value: string | undefined | null) {
  return (value || '').trim().toLowerCase();
}

function getKeywordTerms(keyword: string) {
  return keyword
    .split(/\s+/)
    .map((term) => normalizeText(term))
    .filter(Boolean);
}

/** 空格 = 且；`|`/`｜` 分隔的组之间 = 或（每组内仍为且）。 */
function getKeywordGroups(keyword: string) {
  return keyword
    .split(/[|｜]/)
    .map((group) => getKeywordTerms(group))
    .filter((terms) => terms.length > 0);
}

export function getRemoteFeedSearchKeyword(keyword: string) {
  const terms = getKeywordTerms(keyword);
  if (terms.length !== 1) {
    return '';
  }

  const [term] = terms;
  if (
    term.startsWith('ticker:') ||
    term.startsWith('ca:') ||
    term.includes('|') ||
    term.includes('｜')
  ) {
    return '';
  }

  return term;
}

function collectCaValues(item: FeedItem) {
  const sentimentTokenAddresses = (item.activity.metadata.tokenSentiments || [])
    .map((entry) => entry.tokenAddress || '')
    .filter(Boolean);

  return [
    item.activity.metadata.tokenAddress,
    ...(item.activity.metadata.mentionedTokenAddresses || []),
    ...sentimentTokenAddresses,
  ]
    .map((value) => normalizeText(value))
    .filter(Boolean);
}

function collectTickerValues(item: FeedItem) {
  const sentimentTokenSymbols = (item.activity.metadata.tokenSentiments || [])
    .map((entry) => entry.tokenSymbol || '')
    .filter(Boolean);

  return [
    item.activity.metadata.token,
    ...(item.activity.metadata.mentionedTickers || []),
    ...sentimentTokenSymbols,
  ]
    .map((value) => normalizeText(value))
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
    item.activity.metadata.token,
    ...collectTickerValues(item),
    ...collectCaValues(item),
    item.activity.metadata.fromAddress,
    item.activity.metadata.toAddress,
    item.activity.metadata.trackedAddress,
    item.activity.metadata.txActionLabel,
  ];

  if (
    item.activity.source === 'twitter' ||
    item.activity.source === 'telegram' ||
    item.activity.source === 'fomo'
  ) {
    values.push(item.activity.content);
  }

  return values
    .map((value) => normalizeText(value))
    .filter(Boolean);
}

function matchesKeyword(item: FeedItem, keyword: string) {
  const groups = getKeywordGroups(keyword);
  if (groups.length === 0) return true;

  const haystack = getKeywordHaystack(item);
  const tickerValues = collectTickerValues(item);
  const caValues = collectCaValues(item);

  const matchesTerm = (term: string) => {
    if (term.startsWith('ticker:')) {
      const tickerTerm = normalizeText(term.slice('ticker:'.length));
      if (!tickerTerm) return false;
      return tickerValues.some((value) => value.includes(tickerTerm));
    }

    if (term.startsWith('ca:')) {
      const caTerm = normalizeText(term.slice('ca:'.length));
      if (!caTerm) return false;
      return caValues.some((value) => value.includes(caTerm));
    }

    return haystack.some((value) => value.includes(term));
  };

  // 任一组全部命中即可（组内且，组间或）
  return groups.some((terms) => terms.every(matchesTerm));
}

/**
 * CA 扩展通过通道：扩展开关打开 + 关键词是一个合约地址时，
 * 服务端已把「ticker 提及 / 官推相关」的推文并进了远端命中集 —— 这些推的正文
 * 不含 CA 字面量，普通 haystack 匹配会把它们滤掉。这里按结构化字段
 * （mentionedTokenAddresses / tokenSentiments / metadata.tokenAddress，即 caValues）
 * 放行：条目确实提到这个 CA 就算命中。
 * 开关关闭 / keyword 不是纯地址 → 返回 false，行为与原来完全一致。
 */
function matchesCaExpandPass(item: FeedItem, filters: FeedSearchFilters) {
  if (!filters.expandTicker && !filters.expandOfficialTweets) return false;
  const keyword = filters.keyword.trim();
  if (!keyword || /\s/.test(keyword)) return false;
  const term = normalizeText(keyword.startsWith('ca:') ? keyword.slice(3) : keyword);
  if (!term) return false;
  return collectCaValues(item).some((value) => value.includes(term));
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
  if (item.user.tags.includes('news')) {
    return 'news';
  }

  if (item.activity.source === 'twitter') {
    return 'twitter';
  }
  if (item.activity.source === 'telegram') {
    return 'telegram';
  }
  if (item.activity.source === 'fomo') {
    return 'fomo';
  }

  if (isTradeDisplayAction(item.activity.metadata)) {
    return 'trade';
  }

  const action = item.activity.metadata.txAction;
  if (action === 'send' || action === 'receive') {
    return 'transfer';
  }

  return 'other';
}

export function hasAnyEnabledFeedType(typeFilters: FeedSearchFilters['typeFilters']) {
  return (
    typeFilters.trade ||
    typeFilters.transfer ||
    typeFilters.twitter ||
    typeFilters.telegram ||
    typeFilters.fomo ||
    typeFilters.news
  );
}

export function matchesFeedSearchFilters(item: FeedItem, filters: FeedSearchFilters) {
  if (!matchesKeyword(item, filters.keyword) && !matchesCaExpandPass(item, filters)) {
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
  if (category === 'telegram' && !filters.typeFilters.telegram) {
    return false;
  }
  if (category === 'fomo' && !filters.typeFilters.fomo) {
    return false;
  }
  if (category === 'news' && !filters.typeFilters.news) {
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
