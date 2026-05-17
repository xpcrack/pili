import type { Activity, User } from '@/types';
import { formatTokenAmount } from '@/lib/assetFormat';
import {
  type ActivityImportance,
  buildActivityImportanceExplanationRows,
  getActivityImportanceLevel,
  getActivityImportanceLevelLabel,
} from '@/lib/activityImportance';
import { buildGmgnAddressUrl, buildGmgnTokenUrl } from '@/lib/addressBook';
import {
  formatCompactMarketCap,
  formatDisplayTradeAmount,
  getTradeHeadlineDisplayText,
  isTradeDisplayAction,
  normalizeDisplayTradeAmountText,
  type TradeValueDisplayMode,
} from '@/lib/tradeDisplay';

const NATIVE_OR_STABLE_SYMBOLS = new Set(['sol', 'bnb', 'usdt']);

export interface ActivityCardTokenInfoView {
  marketCapUsd: number | null;
  marketCapAtTxUsd: number | null;
  marketCapAtTxEstimated: boolean;
  source?: 'dexscreener' | 'okx' | 'xxyy' | 'telegram-monitor' | null;
}

function formatAddressShort(address: string) {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function resolveTransferCounterpartyAddress(params: {
  trackedAddress: string;
  fromAddress: string;
  toAddress: string;
  transferAction: string;
}) {
  const trackedLower = params.trackedAddress.trim().toLowerCase();
  const fromAddress = params.fromAddress.trim();
  const toAddress = params.toAddress.trim();
  const fromLower = fromAddress.toLowerCase();
  const toLower = toAddress.toLowerCase();

  if (trackedLower) {
    if (fromLower === trackedLower && toAddress) {
      return toAddress;
    }
    if (toLower === trackedLower && fromAddress) {
      return fromAddress;
    }
  }

  if (params.transferAction === '收到' && fromAddress) {
    return fromAddress;
  }
  if ((params.transferAction === '发出' || params.transferAction === '发送') && toAddress) {
    return toAddress;
  }

  return toAddress || fromAddress || '';
}

function getExplorerTxUrl(chain: string | undefined, txHash: string) {
  if (!txHash) return null;
  if (chain === 'bsc') {
    return `https://web3.okx.com/explorer/bsc/tx/${txHash}`;
  }
  if (chain === 'ethereum') {
    return `https://web3.okx.com/explorer/eth/tx/${txHash}`;
  }
  if (chain === 'base') {
    return `https://web3.okx.com/explorer/base/tx/${txHash}`;
  }
  return `https://web3.okx.com/explorer/solana/tx/${txHash}`;
}

function mapTxActionLabel(metadata: Activity['metadata'], fallbackAction: string) {
  if (metadata.txActionLabel) {
    return metadata.txActionLabel;
  }
  if (fallbackAction === '卖出') return '减仓';
  if (fallbackAction === '买入') return '建仓';
  if (fallbackAction === '发出') return '发送';
  return fallbackAction;
}

function translateActionVariant(
  variant: Activity['metadata']['txActionVariant'],
  fallbackLabel?: string
) {
  if (variant === 'open') return '建仓';
  if (variant === 'add') return '加仓';
  if (variant === 'reduce') return '减仓';
  if (variant === 'close') return '清仓';
  if (variant === 'send') return '发送';
  return fallbackLabel || null;
}

function formatMergeWindowLabel(windowMs: number | null | undefined) {
  if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0) {
    return '短时间';
  }

  if (windowMs % 60_000 === 0) {
    return `${windowMs / 60_000} 分钟`;
  }

  return `${Math.round(windowMs / 1000)} 秒`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function canBuildImportanceExplanation(
  importance: Partial<ActivityImportance> | null | undefined
): importance is ActivityImportance {
  if (!importance || (importance.version !== 1 && importance.version !== 2)) {
    return false;
  }
  if (importance.sourceKind !== 'social' && importance.sourceKind !== 'wallet') {
    return false;
  }
  if (!isFiniteNumber(importance.score)) {
    return false;
  }
  if (
    !isFiniteNumber(importance.sourceCount7d) ||
    !isFiniteNumber(importance.socialCount7d) ||
    !isFiniteNumber(importance.walletCount7d) ||
    !isFiniteNumber(importance.totalCount7d)
  ) {
    return false;
  }
  if (
    !isFiniteNumber(importance.sourceRarity) ||
    !isFiniteNumber(importance.assetWeight) ||
    !isFiniteNumber(importance.totalFrequencyFactor) ||
    !isFiniteNumber(importance.dataConfidenceFactor)
  ) {
    return false;
  }
  return importance.historicalMaxAssetUsd === null || isFiniteNumber(importance.historicalMaxAssetUsd);
}

export function buildActivityCardViewModel(params: {
  activity: Activity;
  user: User;
  tradeValueDisplayMode: TradeValueDisplayMode;
  resolvedTokenInfo: ActivityCardTokenInfoView;
  addressAliasMap?: Map<string, string>;
  activeTokenCa?: string | null;
  activeAddress?: string | null;
}) {
  const { activity, user, resolvedTokenInfo } = params;
  const isBlockchain = activity.source === 'blockchain';
  const isTwitter = activity.source === 'twitter';
  const isTelegram = activity.source === 'telegram';
  const isNews = user.tags.includes('news');
  const hasMedia = Boolean(activity.metadata.media && activity.metadata.media.length > 0);
  const isTransfer = isBlockchain && activity.type === 'transfer';
  const fromAddress = activity.metadata.fromAddress || '';
  const addressSet = new Set(user.addresses.map((item) => item.address.toLowerCase()));
  const isOutgoing = fromAddress ? addressSet.has(fromAddress.toLowerCase()) : false;
  const transferAction =
    activity.metadata.txAction === 'sell'
      ? '卖出'
      : activity.metadata.txAction === 'buy'
        ? '买入'
        : activity.metadata.txAction === 'send'
          ? '发出'
          : activity.metadata.txAction === 'receive'
            ? '收到'
            : isOutgoing
              ? '发出'
              : '收到';
  const txActionLabel = mapTxActionLabel(activity.metadata, transferAction);
  const displayActionVariantLabel =
    activity.metadata.displayActionVariantLabel ||
    translateActionVariant(activity.metadata.txActionVariant, txActionLabel) ||
    txActionLabel;
  const tokenSymbolRaw = (activity.metadata.token || '').trim();
  const tokenSymbolUpper = tokenSymbolRaw.toUpperCase();
  const tokenSymbolDisplay = tokenSymbolRaw || 'UNKNOWN';
  const tokenCa = activity.metadata.displayTokenAvatarTokenAddress || activity.metadata.tokenAddress || '';
  const txHash = activity.metadata.txHash || '';
  const formattedTokenAmount = formatTokenAmount(activity.metadata.value);
  const quoteToken = activity.metadata.quoteToken || '';
  const quoteTokenUpper = quoteToken.toUpperCase();
  const trackedAddress = activity.metadata.trackedAddress || '';
  const hasTradeQuote =
    Boolean(activity.metadata.quoteAmount) &&
    Boolean(quoteToken) &&
    (activity.metadata.txAction === 'sell' || activity.metadata.txAction === 'buy');
  const isTradeAction = isTradeDisplayAction(activity.metadata);
  const tradeAmountUsdAtTx =
    typeof activity.metadata.tradeAmountUsdAtTx === 'number' &&
    Number.isFinite(activity.metadata.tradeAmountUsdAtTx) &&
    activity.metadata.tradeAmountUsdAtTx > 0
      ? activity.metadata.tradeAmountUsdAtTx
      : null;
  const isSendReceiveTransfer = isTransfer && !isTradeAction;
  const tradeMarketCapUsd =
    resolvedTokenInfo.marketCapAtTxUsd ??
    (typeof activity.metadata.marketCapAtTxUsd === 'number' ? activity.metadata.marketCapAtTxUsd : null) ??
    resolvedTokenInfo.marketCapUsd;
  const marketCapLabel = formatCompactMarketCap(isTradeAction ? tradeMarketCapUsd : resolvedTokenInfo.marketCapUsd);
  const mergedTradeCount = activity.metadata.mergedTradeCount ?? 1;
  const isMergedTradeCard = mergedTradeCount > 1;
  const mergedTradeWindowMs = activity.metadata.mergedTradeWindowMs ?? null;
  const mergedAverageMarketCapUsd =
    typeof activity.metadata.mergedTradeAverageMarketCapUsd === 'number' &&
    Number.isFinite(activity.metadata.mergedTradeAverageMarketCapUsd) &&
    activity.metadata.mergedTradeAverageMarketCapUsd > 0
      ? activity.metadata.mergedTradeAverageMarketCapUsd
      : null;
  const mergedAverageMarketCapLabel = mergedAverageMarketCapUsd
    ? `均市值 ${formatCompactMarketCap(mergedAverageMarketCapUsd)}`
    : null;
  const counterpartyAddress = resolveTransferCounterpartyAddress({
    trackedAddress,
    fromAddress,
    toAddress: activity.metadata.toAddress || '',
    transferAction,
  });
  const counterpartyAlias = counterpartyAddress
    ? params.addressAliasMap?.get(counterpartyAddress.toLowerCase()) || null
    : null;
  const counterpartyLabel = counterpartyAlias || (counterpartyAddress ? formatAddressShort(counterpartyAddress) : null);
  const marketCapTooltip =
    isMergedTradeCard && mergedAverageMarketCapLabel
      ? '按合并成交量加权后的平均成交市值'
      : isMergedTradeCard
        ? `${formatMergeWindowLabel(mergedTradeWindowMs)}内相似成交已合并`
        : isSendReceiveTransfer && counterpartyAddress
          ? `交易对象: ${counterpartyAddress}`
        : resolvedTokenInfo.source === 'telegram-monitor'
      ? '来自 XXYY Telegram 监控推送（精确）'
      : resolvedTokenInfo.marketCapAtTxEstimated
        ? '基于 OKX 历史K线推算的交易时市值（估算）'
        : '市值';
  const normalizedTrackedAddress = trackedAddress.toLowerCase();
  const trackedAddressAlias = trackedAddress ? params.addressAliasMap?.get(normalizedTrackedAddress) || null : null;
  const monitorAliasLabel = activity.metadata.monitorWalletAliasLabel || null;
  const actorLabel = monitorAliasLabel || trackedAddressAlias || (trackedAddress ? formatAddressShort(trackedAddress) : null);
  const tradeHeadlineValue = hasTradeQuote
    ? formatDisplayTradeAmount(activity.metadata.quoteAmount, quoteTokenUpper)
    : `${formattedTokenAmount} ${tokenSymbolDisplay}`;
  const displayWalletLabel =
    activity.metadata.displayWalletLabel ||
    activity.metadata.monitorWalletLabel ||
    trackedAddressAlias ||
    actorLabel ||
    user.name;
  const displayTradeAmountText =
    normalizeDisplayTradeAmountText(activity.metadata.displayTradeAmountText) ||
    normalizeDisplayTradeAmountText(tradeHeadlineValue);
  const displayTradeHeadlineText = isTradeAction
    ? getTradeHeadlineDisplayText({
        mode: params.tradeValueDisplayMode,
        nativeAmountText: displayTradeAmountText,
        tradeAmountUsdAtTx,
      })
    : displayTradeAmountText;
  const displayTokenSymbol = activity.metadata.displayTokenSymbol || tokenSymbolDisplay;
  const displayMarketCapText = isMergedTradeCard
    ? mergedAverageMarketCapLabel
    : isSendReceiveTransfer
      ? counterpartyLabel
    : activity.metadata.displayMarketCapText || marketCapLabel;
  const shouldUseOutgoingAmountTone =
    displayActionVariantLabel === '减仓' ||
    displayActionVariantLabel === '清仓' ||
    displayActionVariantLabel === '发送' ||
    transferAction === '发出';
  const canCopyTokenCa = Boolean(
    tokenCa && tokenSymbolRaw && !NATIVE_OR_STABLE_SYMBOLS.has(tokenSymbolRaw.toLowerCase())
  );
  const isSameCaHighlighted =
    Boolean(params.activeTokenCa) && Boolean(tokenCa) && params.activeTokenCa?.toLowerCase() === tokenCa.toLowerCase();
  const normalizedActiveAddress = params.activeAddress?.trim().toLowerCase() || null;
  const isTrackedAddressHighlighted =
    Boolean(normalizedActiveAddress) && Boolean(normalizedTrackedAddress) && normalizedActiveAddress === normalizedTrackedAddress;
  const normalizedCounterpartyAddress = counterpartyAddress.trim().toLowerCase();
  const isCounterpartyAddressHighlighted =
    Boolean(normalizedActiveAddress) &&
    Boolean(normalizedCounterpartyAddress) &&
    normalizedActiveAddress === normalizedCounterpartyAddress;
  const primaryText = isTransfer
    ? `${transferAction} ${formattedTokenAmount} ${tokenSymbolDisplay}`
    : isBlockchain
      ? activity.content
      : activity.title || activity.content;
  const explorerTxUrl = getExplorerTxUrl(activity.metadata.chain, activity.metadata.txHash || '');
  const tokenGmgnUrl = canCopyTokenCa ? buildGmgnTokenUrl(activity.metadata.chain, tokenCa) : null;
  const trackedAddressGmgnUrl = trackedAddress ? buildGmgnAddressUrl(activity.metadata.chain, trackedAddress) : null;
  const counterpartyGmgnUrl = counterpartyAddress
    ? buildGmgnAddressUrl(activity.metadata.chain, counterpartyAddress)
    : null;
  const importance = (activity.metadata.importance as Partial<ActivityImportance> | null | undefined) ?? null;
  const importanceScore = isFiniteNumber(importance?.score) ? importance.score : null;
  const importanceLevel = importanceScore === null ? null : getActivityImportanceLevel(importanceScore);
  const importanceLevelLabel = importanceScore === null ? null : getActivityImportanceLevelLabel(importanceScore);
  const importanceBadgeText = importanceScore === null ? null : `${importanceScore}分`;
  const importanceTooltip = canBuildImportanceExplanation(importance)
    ? buildActivityImportanceExplanationRows(importance)
        .map((row) => `${row.label}: ${row.valueText}\n${row.description}`)
        .join('\n\n')
    : null;
  const importanceBadgeClassName =
    importanceLevel === 'high'
      ? 'bg-rose-500/15 text-rose-200 ring-1 ring-rose-400/35'
      : importanceLevel === 'important'
        ? 'bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/35'
        : 'bg-zinc-800 text-zinc-300 ring-1 ring-zinc-700';

  const newsChannelLabel = isNews && isTelegram
    ? (activity.metadata.telegramChannelTitle || activity.metadata.telegramChannelUsername || '新闻频道')
    : null;

  return {
    isBlockchain,
    isTwitter,
    isTelegram,
    isNews,
    newsChannelLabel,
    hasMedia,
    isTransfer,
    transferAction,
    displayActionVariantLabel,
    tokenSymbolRaw,
    tokenSymbolUpper,
    tokenSymbolDisplay,
    tokenCa,
    txHash,
    formattedTokenAmount,
    trackedAddress,
    isTradeAction,
    isSendReceiveTransfer,
    mergedTradeCount,
    isMergedTradeCard,
    counterpartyAddress,
    marketCapTooltip,
    normalizedTrackedAddress,
    displayWalletLabel,
    displayTradeHeadlineText,
    displayTokenSymbol,
    displayMarketCapText,
    shouldUseOutgoingAmountTone,
    canCopyTokenCa,
    isSameCaHighlighted,
    isTrackedAddressHighlighted,
    isCounterpartyAddressHighlighted,
    primaryText,
    explorerTxUrl,
    tokenGmgnUrl,
    trackedAddressGmgnUrl,
    counterpartyGmgnUrl,
    importanceBadgeText,
    importanceLevelLabel,
    importanceTooltip,
    importanceBadgeClassName,
  };
}
