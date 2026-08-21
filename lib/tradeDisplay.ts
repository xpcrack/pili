import type { Activity } from '@/types';
import { formatTradeAmountUsdLabel } from '@/lib/assetFormat';
import { parsePositiveFiniteNumber } from '@/lib/positiveNumber';

export type TradeValueDisplayMode = 'native' | 'usd';

const ACTION_VARIANT_LABELS: Record<string, string> = {
  open: '建仓',
  add: '加仓',
  reduce: '减仓',
  close: '清仓',
  send: '发送',
};

export const TRADE_ACTION_LABEL_VALUES = Object.values(ACTION_VARIANT_LABELS) as readonly string[];

function normalize(value: string | null | undefined) {
  return (value || '').trim();
}

export function normalizeTradeValueDisplayMode(
  value: string | null | undefined
): TradeValueDisplayMode {
  // 默认 USD；只有显式 native 才切回代币金额
  return value === 'native' ? 'native' : 'usd';
}

export function isTradeDisplayAction(
  metadata: Pick<
    Activity['metadata'],
    'txAction' | 'txActionVariant' | 'txActionLabel' | 'displayActionVariantLabel'
  >
) {
  if (metadata.txAction === 'buy' || metadata.txAction === 'sell') {
    return true;
  }

  if (
    metadata.txActionVariant === 'open' ||
    metadata.txActionVariant === 'add' ||
    metadata.txActionVariant === 'reduce' ||
    metadata.txActionVariant === 'close'
  ) {
    return true;
  }

  const label = normalize(metadata.displayActionVariantLabel || metadata.txActionLabel);
  return label === '建仓' || label === '加仓' || label === '减仓' || label === '清仓';
}

/** 幅度列：动作并入幅度。无真实仓位%时 open/close 可定，add/reduce 先「待补」。 */
export type PositionDeltaTone = 'up' | 'down' | 'neutral' | 'muted';

export function resolvePositionDeltaDisplay(params: {
  txActionVariant?: Activity['metadata']['txActionVariant'] | null;
  displayActionVariantLabel?: string | null;
  /** 相对仓位变化，0.348 = +34.8%。有值时优先于动作兜底。 */
  positionDeltaRatio?: number | null;
  /** true = 前端按已加载窗口推算，可能随加载更多变化；显示 `~` 前缀。 */
  positionDeltaEstimated?: boolean | null;
}) {
  const ratio =
    typeof params.positionDeltaRatio === 'number' && Number.isFinite(params.positionDeltaRatio)
      ? params.positionDeltaRatio
      : null;
  if (ratio !== null) {
    const pct = Math.round(ratio * 1000) / 10;
    const prefix = params.positionDeltaEstimated ? '~' : '';
    const signed = pct > 0 ? `${prefix}+${pct}%` : `${prefix}${pct}%`;
    return {
      text: signed,
      tone: (pct > 0 ? 'up' : pct < 0 ? 'down' : 'muted') as PositionDeltaTone,
      estimated: Boolean(params.positionDeltaEstimated),
    };
  }

  const variant = normalize(params.txActionVariant).toLowerCase();
  const label = normalize(params.displayActionVariantLabel);
  if (variant === 'open' || label === '建仓') {
    return { text: '建仓', tone: 'up' as const, estimated: false };
  }
  if (variant === 'close' || label === '清仓') {
    return { text: '-100%', tone: 'down' as const, estimated: false };
  }
  // ponytail: no balance-before/after yet → placeholder until metadata carries %
  return { text: '待补', tone: 'muted' as const, estimated: false };
}

/** XXYY rawText: `Token: 93568.85  [PUMPCADE]` — token qty, not quote. */
export function extractTokenAmountFromRawText(rawText: string | null | undefined) {
  const match = normalize(rawText).match(/\btoken\s*:\s*([0-9][0-9.,]*)/i);
  if (!match?.[1]) return null;
  return parsePositiveFiniteNumber(match[1]);
}

/**
 * Best-effort token qty for position %:
 * 1) rawText Token: line (XXYY)
 * 2) metadata.value when it looks like token qty (live-monitor / reconciled)
 */
export function resolveTradeTokenAmount(activity: Activity) {
  const fromRaw = extractTokenAmountFromRawText(activity.metadata.rawText);
  if (fromRaw != null) return fromRaw;
  return parsePositiveFiniteNumber(activity.metadata.value);
}

function resolveTradeSide(activity: Activity): 'buy' | 'sell' | null {
  const variant = normalize(activity.metadata.txActionVariant).toLowerCase();
  const label = normalize(activity.metadata.displayActionVariantLabel || activity.metadata.txActionLabel);
  if (variant === 'open' || variant === 'add' || label === '建仓' || label === '加仓') return 'buy';
  if (variant === 'close' || variant === 'reduce' || label === '清仓' || label === '减仓') return 'sell';
  const action = normalize(activity.metadata.txAction).toLowerCase();
  if (action === 'buy') return 'buy';
  if (action === 'sell') return 'sell';
  return null;
}

function isOpenVariant(activity: Activity) {
  const variant = normalize(activity.metadata.txActionVariant).toLowerCase();
  const label = normalize(activity.metadata.displayActionVariantLabel || activity.metadata.txActionLabel);
  return variant === 'open' || label === '建仓';
}

function isCloseVariant(activity: Activity) {
  const variant = normalize(activity.metadata.txActionVariant).toLowerCase();
  const label = normalize(activity.metadata.displayActionVariantLabel || activity.metadata.txActionLabel);
  return variant === 'close' || label === '清仓';
}

function isExplicitAddVariant(activity: Activity) {
  const variant = normalize(activity.metadata.txActionVariant).toLowerCase();
  const label = normalize(activity.metadata.displayActionVariantLabel || activity.metadata.txActionLabel);
  return variant === 'add' || label === '加仓';
}

function positionSeriesKey(activity: Activity) {
  const wallet = normalize(activity.metadata.trackedAddress);
  const chain = normalize(activity.metadata.chain);
  const token = normalize(activity.metadata.tokenAddress);
  if (!wallet || !chain || !token) return null;
  return `${chain}|${wallet}|${token}`;
}

/**
 * Fill missing positionDeltaRatio from the wallet×token timeline in `items`.
 * - open / first buy after flat: leave ratio unset → UI shows 建仓
 * - close / sell that empties: -1
 * - add: +qty/before；reduce: -qty/before
 * Already-set ratio is preserved. Unknown pre-balance stays 待补 but seeds inventory.
 * Also upgrades live add/reduce → open/close when the timeline implies it.
 *
 * IMPORTANT: accuracy depends on `items` covering the full history of each series.
 * The client only ever holds a sliding window, so it must pass
 * `markEstimated: true` — the ratio then renders with a `~` prefix. Server-side
 * callers reading the whole DB (scripts/backfill-position-delta.ts) omit it.
 */
export function fillPositionDeltaRatios<T extends { activity: Activity }>(
  items: T[],
  options: { markEstimated?: boolean } = {}
): T[] {
  type Work = { item: T; index: number; side: 'buy' | 'sell'; amount: number | null };
  const buckets = new Map<string, Work[]>();

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const { activity } = item;
    if (activity.source !== 'blockchain' || activity.type !== 'transfer') continue;
    const side = resolveTradeSide(activity);
    if (!side) continue;
    const key = positionSeriesKey(activity);
    if (!key) continue;
    const list = buckets.get(key) || [];
    list.push({ item, index, side, amount: resolveTradeTokenAmount(activity) });
    buckets.set(key, list);
  }

  if (buckets.size === 0) return items;

  type Patch = {
    ratio?: number;
    open?: boolean;
    close?: boolean;
  };
  const patchByIndex = new Map<number, Patch>();

  for (const series of buckets.values()) {
    // oldest → newest
    series.sort((a, b) => {
      const t = a.item.activity.timestamp - b.item.activity.timestamp;
      if (t !== 0) return t;
      return a.index - b.index;
    });

    let balance: number | null = null;
    for (const row of series) {
      const existing = row.item.activity.metadata.positionDeltaRatio;
      if (typeof existing === 'number' && Number.isFinite(existing)) {
        // Keep author-provided ratio, still advance inventory when possible.
        if (row.amount != null) {
          if (row.side === 'buy') {
            balance = (balance ?? 0) + row.amount;
          } else if (balance != null) {
            balance = Math.max(0, balance - row.amount);
          }
        } else if (isCloseVariant(row.item.activity) || existing <= -0.999) {
          balance = 0;
        } else if (isOpenVariant(row.item.activity)) {
          balance = balance ?? 0;
        }
        continue;
      }

      if (isOpenVariant(row.item.activity) || (row.side === 'buy' && (balance == null || balance <= 0))) {
        if (row.amount != null) balance = row.amount;
        else if (balance == null || balance <= 0) balance = 0;
        if (!isOpenVariant(row.item.activity) && row.side === 'buy' && !isExplicitAddVariant(row.item.activity)) {
          // Only unlabeled live buys can be upgraded; explicit 加仓 from GMGN/newone must not become 建仓 just because the client window is incomplete.
          patchByIndex.set(row.index, { ...(patchByIndex.get(row.index) || {}), open: true });
        }
        continue;
      }

      if (isCloseVariant(row.item.activity)) {
        patchByIndex.set(row.index, { ...(patchByIndex.get(row.index) || {}), ratio: -1, close: true });
        balance = 0;
        continue;
      }

      if (row.amount == null) continue;

      if (row.side === 'buy') {
        if (balance != null && balance > 0) {
          patchByIndex.set(row.index, {
            ...(patchByIndex.get(row.index) || {}),
            ratio: row.amount / balance,
          });
          balance += row.amount;
        } else {
          // seed without % (history incomplete)
          balance = (balance ?? 0) + row.amount;
        }
        continue;
      }

      // sell / reduce
      if (balance != null && balance > 0) {
        const soldFraction = row.amount / balance;
        if (soldFraction >= 0.995 || row.amount >= balance) {
          patchByIndex.set(row.index, {
            ...(patchByIndex.get(row.index) || {}),
            ratio: -1,
            close: true,
          });
          balance = 0;
        } else {
          patchByIndex.set(row.index, {
            ...(patchByIndex.get(row.index) || {}),
            ratio: -soldFraction,
          });
          balance = Math.max(0, balance - row.amount);
        }
      }
      // unknown pre-balance: leave 待补
    }
  }

  if (patchByIndex.size === 0) return items;

  return items.map((item, index) => {
    const patch = patchByIndex.get(index);
    if (!patch) return item;
    const nextMeta = { ...item.activity.metadata };
    if (typeof patch.ratio === 'number') {
      nextMeta.positionDeltaRatio = patch.ratio;
      if (options.markEstimated) {
        nextMeta.positionDeltaEstimated = true;
      }
    }
    if (patch.open) {
      nextMeta.txActionVariant = 'open';
      nextMeta.txActionLabel = '建仓';
      nextMeta.displayActionVariantLabel = '建仓';
    } else if (patch.close) {
      nextMeta.txActionVariant = 'close';
      nextMeta.txActionLabel = '清仓';
      nextMeta.displayActionVariantLabel = '清仓';
    }
    return {
      ...item,
      activity: {
        ...item.activity,
        metadata: nextMeta,
      },
    };
  });
}

export function formatCompactMarketCap(marketCapUsd: number | null | undefined) {
  if (marketCapUsd === null || marketCapUsd === undefined || !Number.isFinite(marketCapUsd) || marketCapUsd <= 0) {
    return null;
  }

  const formatCompact = (value: number, unit: string) => {
    const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(decimals).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1')}${unit}`;
  };

  if (marketCapUsd >= 1_000_000_000) return formatCompact(marketCapUsd / 1_000_000_000, 'B');
  if (marketCapUsd >= 1_000_000) return formatCompact(marketCapUsd / 1_000_000, 'M');
  if (marketCapUsd >= 1_000) return formatCompact(marketCapUsd / 1_000, 'K');
  return `${Math.round(marketCapUsd)}`;
}

/** MC 列不带 $；兼容历史 metadata 里已存的 `$100K` */
export function stripMarketCapUsdPrefix(text: string | null | undefined) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return null;
  return value.replace(/^\$/, '') || null;
}

/** USD 色条宽度：线性 $100→0%，$5k→100%，区间外封顶/触底 */
export function tradeUsdBarPercent(usd: number | null | undefined) {
  if (usd === null || usd === undefined || !Number.isFinite(usd) || usd <= 0) return 0;
  const min = 100;
  const max = 5_000;
  const clamped = Math.min(max, Math.max(min, usd));
  return Math.round(((clamped - min) / (max - min)) * 100);
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

  const raw = sanitized.raw;
  if (raw === 0) return '0';
  const abs = Math.abs(raw);
  if (abs >= 1) {
    const integerDigits = Math.trunc(abs).toString().length;
    const decimals = Math.max(0, 4 - integerDigits);
    return raw.toFixed(decimals).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1');
  }
  if (abs >= 0.001) {
    // 保留原显示精度（3 位小数），避免改动既有展示
    return raw.toFixed(3).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1');
  }
  // < 0.001 时 toFixed(3) 会显示成 0.000（≈0）：改用 4 位有效数字，
  // 小额持仓/交易金额不再被当成 0。
  const leadingZeros = Math.max(0, Math.ceil(-Math.log10(abs)) - 1);
  const decimals = Math.min(12, leadingZeros + 4);
  return raw.toFixed(decimals).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1');
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
    const usdText = formatTradeAmountUsdLabel(params.tradeAmountUsdAtTx);
    return usdText === '金额未知' ? normalize(params.nativeAmountText) || usdText : usdText;
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

export function mapActionVariantLabel(
  actionVariant: string | null | undefined,
  txActionLabel?: string | null | undefined
) {
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
