import type { Activity } from '@/types';

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
}) {
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
