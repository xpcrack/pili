import type { Activity } from '@/types';

const FEED_SOURCE_DEFAULT_COLOR = '#71717A';
const FEED_SOCIAL_COLOR = '#1D9BF0';
const FEED_CHAIN_COLORS: Record<string, string> = {
  solana: '#9945FF',
  ethereum: '#627EEA',
  bsc: '#F3BA2F',
  base: '#0052FF',
  robinhood: '#CCFF00',
};
const FEED_CHAIN_ALIASES: Record<string, string> = {
  sol: 'solana',
  eth: 'ethereum',
  rh: 'robinhood',
};

export function getFeedSourceColor(activity: Pick<Activity, 'source' | 'metadata'>) {
  if (activity.source !== 'blockchain') return FEED_SOCIAL_COLOR;
  const normalizedChain = (activity.metadata.chain || '').trim().toLowerCase();
  const canonicalChain = FEED_CHAIN_ALIASES[normalizedChain] || normalizedChain;
  return FEED_CHAIN_COLORS[canonicalChain] || FEED_SOURCE_DEFAULT_COLOR;
}

const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  post: '发布',
  transfer: '转账',
  swap: '兑换',
  nft_trade: 'NFT交易',
  mint: '铸造',
};

export function collapseActivityCardText(text: string) {
  if (!text) return '';
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]*\n+/g, '\n')
    .trim();
}

const URL_PATTERN = /https?:\/\/\S+/gi;

export function cleanTwitterDisplayText(text: string) {
  if (!text) return '';

  const withoutUrls = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(URL_PATTERN, '').replace(/[ \t]{2,}/g, ' ').trimEnd())
    .join('\n');

  return collapseActivityCardText(withoutUrls);
}

export function usesSocialBodyLayout(source: Activity['source']) {
  return source === 'twitter' || source === 'telegram';
}

export function getActivityCardTypeLabel(params: {
  source: Activity['source'];
  activityType: Activity['type'];
  twitterKindLabel: string | null;
  isNews?: boolean;
}) {
  if (params.isNews) {
    return '新闻';
  }

  if (params.source === 'twitter') {
    return params.twitterKindLabel;
  }

  if (params.source === 'telegram') {
    return 'TG';
  }

  return ACTIVITY_TYPE_LABELS[params.activityType] || params.activityType;
}

export function getTelegramCardPrimaryText(content: string) {
  return collapseActivityCardText(content) || '(empty)';
}
