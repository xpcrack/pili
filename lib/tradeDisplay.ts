import type { Activity } from '@/types';
import { formatTradeAmountUsdLabel } from '@/lib/assetFormat';

export type TradeValueDisplayMode = 'native' | 'usd';

const ACTION_VARIANT_LABELS: Record<string, string> = {
  open: '建仓',
  add: '加仓',
  reduce: '减仓',
  close: '清仓',
  send: '发送',
};

function normalize(value: string | null | undefined) {
  return (value || '').trim();
}

export function normalizeTradeValueDisplayMode(
  value: string | null | undefined
): TradeValueDisplayMode {
  return value === 'usd' ? 'usd' : 'native';
}

export function formatCompactMarketCap(marketCapUsd: number | null | undefined) {
  if (marketCapUsd === null || marketCapUsd === undefined || !Number.isFinite(marketCapUsd) || marketCapUsd <= 0) {
    return null;
  }

  const formatCompact = (value: number, unit: string) => {
    const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return `$${value.toFixed(decimals).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1')}${unit}`;
  };

  if (marketCapUsd >= 1_000_000_000) return formatCompact(marketCapUsd / 1_000_000_000, 'B');
  if (marketCapUsd >= 1_000_000) return formatCompact(marketCapUsd / 1_000_000, 'M');
  if (marketCapUsd >= 1_000) return formatCompact(marketCapUsd / 1_000, 'K');
  return `$${Math.round(marketCapUsd)}`;
}

function sanitizeTradeAmount(value: string | number | null | undefined) {
  const amount =
    typeof value === 'number'
      ? String(value)
      : normalize(value).replace(/,/g, '');
  const parsed = Number.parseFloat(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return { raw: parsed, normalized: amount };
}

function formatTradeAmountDigits(value: string | number | null | undefined) {
  const sanitized = sanitizeTradeAmount(value);
  if (!sanitized) return null;

  const integerDigits = Math.max(1, Math.trunc(Math.abs(sanitized.raw))).toString().length;
  const decimals = Math.max(0, 4 - integerDigits);
  return sanitized.raw
    .toFixed(decimals)
    .replace(/\.0+$|(\.\d*[1-9])0+$/, '$1');
}

export function formatDisplayTradeAmount(value: string | number | null | undefined, symbol: string | null | undefined) {
  const amount = formatTradeAmountDigits(value);
  const token = normalize(symbol).toUpperCase();
  if (!amount || !token) return null;
  return `${amount} ${token}`;
}

export function getTradeHeadlineDisplayText(params: {
  mode: TradeValueDisplayMode;
  nativeAmountText: string | null | undefined;
  tradeAmountUsdAtTx: number | null | undefined;
}) {
  if (params.mode === 'usd') {
    return formatTradeAmountUsdLabel(params.tradeAmountUsdAtTx);
  }

  return normalize(params.nativeAmountText) || formatTradeAmountUsdLabel(params.tradeAmountUsdAtTx);
}

export function normalizeDisplayTradeAmountText(text: string | null | undefined) {
  const normalized = normalize(text);
  if (!normalized) return null;

  const match = normalized.match(/^([0-9][0-9.,]*)\s*([A-Za-z]+)$/);
  if (!match?.[1] || !match?.[2]) {
    return normalized;
  }

  return formatDisplayTradeAmount(match[1], match[2]) || normalized;
}

function extractRawTradeAmount(rawText: string) {
  const patterns = [
    /\bSell\s+Part\s+([0-9][0-9.,]*)\s*([A-Za-z]+)/i,
    /\bSell\s+All\s+([0-9][0-9.,]*)\s*([A-Za-z]+)/i,
    /\bNew\s+sell\s+([0-9][0-9.,]*)\s*([A-Za-z]+)/i,
    /\bBuy\s+more\s+([0-9][0-9.,]*)\s*([A-Za-z]+)/i,
    /\bBuy\s+All\s+([0-9][0-9.,]*)\s*([A-Za-z]+)/i,
    /\bNew\s+buy\s+([0-9][0-9.,]*)\s*([A-Za-z]+)/i,
    /\b(?:Send\s+to|Transfer\s+to)\s+([0-9][0-9.,]*)\s*([A-Za-z]+)/i,
  ];

  for (const pattern of patterns) {
    const match = rawText.match(pattern);
    if (match?.[1] && match?.[2]) {
      return formatDisplayTradeAmount(match[1], match[2]);
    }
  }

  return null;
}

function extractRawMcapText(rawText: string) {
  const match = rawText.match(/\bM(?:CAP|arket\s*Cap)\s*:\s*([^\n\r]+)/i);
  return match?.[1]?.trim() ? match[1].trim() : null;
}

function mapActionVariantLabel(actionVariant: string | null | undefined, txActionLabel: string | null | undefined) {
  const variant = normalize(actionVariant).toLowerCase();
  if (variant && ACTION_VARIANT_LABELS[variant]) {
    return ACTION_VARIANT_LABELS[variant];
  }
  return normalize(txActionLabel) || null;
}

export function buildTradeDisplayMetadata(params: {
  rawText?: string | null;
  walletLabel?: string | null;
  fallbackWalletLabel?: string | null;
  actionVariant?: string | null;
  txActionLabel?: string | null;
  quoteAmount?: string | number | null;
  quoteToken?: string | null;
  value?: string | null;
  tokenSymbol?: string | null;
  marketCapText?: string | null;
  marketCapUsd?: number | null;
  tokenAddress?: string | null;
}) {
  const rawText = normalize(params.rawText);
  const rawTradeAmountText = rawText ? extractRawTradeAmount(rawText) : null;
  const fallbackQuoteText =
    formatDisplayTradeAmount(params.quoteAmount, params.quoteToken) ||
    formatDisplayTradeAmount(params.value, params.tokenSymbol);
  const rawMcapText = rawText ? extractRawMcapText(rawText) : null;

  return {
    displayWalletLabel: normalize(params.walletLabel) || normalize(params.fallbackWalletLabel) || undefined,
    displayActionVariantLabel:
      mapActionVariantLabel(params.actionVariant, params.txActionLabel) || undefined,
    displayTradeAmountText: rawTradeAmountText || fallbackQuoteText || undefined,
    displayTokenSymbol: normalize(params.tokenSymbol).toUpperCase() || undefined,
    displayMarketCapText:
      normalize(params.marketCapText) || rawMcapText || formatCompactMarketCap(params.marketCapUsd) || undefined,
    displayTokenAvatarTokenAddress: normalize(params.tokenAddress) || undefined,
  } satisfies Pick<
    Activity['metadata'],
    | 'displayWalletLabel'
    | 'displayActionVariantLabel'
    | 'displayTradeAmountText'
    | 'displayTokenSymbol'
    | 'displayMarketCapText'
    | 'displayTokenAvatarTokenAddress'
  >;
}
