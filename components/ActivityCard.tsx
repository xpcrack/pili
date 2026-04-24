'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, User } from '@/types';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card, CardContent } from '@/components/ui/card';
import { getUserAvatar } from '@/lib/userProfile';
import { formatTokenAmount } from '@/lib/assetFormat';
import {
  formatAbsoluteTimeCompact,
  type FeedTimeDisplayMode,
  getRelativeTimeState,
} from '@/lib/timeFormat';
import {
  formatCompactMarketCap,
  formatDisplayTradeAmount,
  normalizeDisplayTradeAmountText,
} from '@/lib/tradeDisplay';

interface ActivityCardProps {
  activity: Activity;
  user: User;
  timeDisplayMode?: FeedTimeDisplayMode;
  onClick?: () => void;
  activeTokenCa?: string | null;
  onTokenCaHover?: (tokenCa: string | null) => void;
  activeAddress?: string | null;
  onAddressHover?: (address: string | null) => void;
  addressAliasMap?: Map<string, string>;
}

const typeLabels: Record<string, string> = {
  post: '发布',
  transfer: '转账',
  swap: '兑换',
  nft_trade: 'NFT交易',
  mint: '铸造'
};

const NATIVE_OR_STABLE_SYMBOLS = new Set(['sol', 'bnb', 'usdt']);
interface TokenInfoSnapshot {
  logoUrl: string | null;
  marketCapUsd: number | null;
  marketCapAtTxUsd: number | null;
  marketCapAtTxEstimated: boolean;
  source?: 'dexscreener' | 'okx' | 'xxyy' | 'telegram-monitor' | null;
}

const tokenAvatarCache = new Map<string, string | null>();
const tokenInfoCache = new Map<string, TokenInfoSnapshot>();

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
  return `https://web3.okx.com/explorer/solana/tx/${txHash}`;
}

function collapseEmptyLines(text: string) {
  if (!text) return '';
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]*\n+/g, '\n')
    .trim();
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

export function ActivityCard({
  activity,
  user,
  timeDisplayMode = 'relative',
  onClick,
  activeTokenCa = null,
  onTokenCaHover,
  addressAliasMap,
}: ActivityCardProps) {
  const [now, setNow] = useState(activity.timestamp);
  const { label: relativeTimeAgo, nextUpdateInMs } = getRelativeTimeState(activity.timestamp, now);
  const timeAgo =
    timeDisplayMode === 'absolute'
      ? formatAbsoluteTimeCompact(activity.timestamp)
      : relativeTimeAgo;
  const [txCopied, setTxCopied] = useState(false);
  const [tweetLinkCopied, setTweetLinkCopied] = useState(false);
  const txCopyTimerRef = useRef<number | null>(null);
  const tweetCopyTimerRef = useRef<number | null>(null);
  const lastTimeDisplayModeRef = useRef<FeedTimeDisplayMode>(timeDisplayMode);

  const isBlockchain = activity.source === 'blockchain';
  const isTwitter = activity.source === 'twitter';
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
  const txTimestampBucket = Math.floor(activity.timestamp / 60_000);
  const tokenAvatarKey = `${activity.metadata.chain || ''}:${tokenCa.toLowerCase()}`;
  const tokenInfoKey = `${activity.metadata.chain || ''}:${tokenCa.toLowerCase()}:${tokenSymbolUpper}:${txTimestampBucket}:${(activity.metadata.txHash || '').toLowerCase()}`;
  const cachedTokenAvatar = tokenAvatarCache.get(tokenAvatarKey);
  const cachedTokenInfo = tokenInfoCache.get(tokenInfoKey);
  const [tokenInfoState, setTokenInfoState] = useState<{ key: string; info: TokenInfoSnapshot }>({
    key: tokenInfoKey,
    info: cachedTokenInfo ?? { logoUrl: null, marketCapUsd: null, marketCapAtTxUsd: null, marketCapAtTxEstimated: false },
  });
  const resolvedTokenInfo =
    cachedTokenInfo ??
    (
      tokenInfoState.key === tokenInfoKey
        ? tokenInfoState.info
        : { logoUrl: null, marketCapUsd: null, marketCapAtTxUsd: null, marketCapAtTxEstimated: false }
    );
  const resolvedTokenAvatar = cachedTokenAvatar !== undefined ? cachedTokenAvatar : resolvedTokenInfo.logoUrl;
  const formattedTokenAmount = formatTokenAmount(activity.metadata.value);
  const quoteToken = activity.metadata.quoteToken || '';
  const quoteTokenUpper = quoteToken.toUpperCase();
  const trackedAddress = activity.metadata.trackedAddress || '';
  const hasTradeQuote =
    Boolean(activity.metadata.quoteAmount) &&
    Boolean(quoteToken) &&
    (activity.metadata.txAction === 'sell' || activity.metadata.txAction === 'buy');
  const isTradeAction =
    activity.metadata.txAction === 'buy' ||
    activity.metadata.txAction === 'sell';
  const isSendReceiveTransfer =
    isTransfer && !isTradeAction;
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
    ? addressAliasMap?.get(counterpartyAddress.toLowerCase()) || null
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
  const trackedAddressAlias = trackedAddress ? addressAliasMap?.get(normalizedTrackedAddress) || null : null;
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
    Boolean(activeTokenCa) && Boolean(tokenCa) && activeTokenCa?.toLowerCase() === tokenCa.toLowerCase();
  const primaryText = isTransfer
    ? `${transferAction} ${formattedTokenAmount} ${tokenSymbolDisplay}`
    : isBlockchain
      ? activity.content
      : activity.title || activity.content;
  const secondaryText = !isBlockchain && activity.title && !isTwitter ? activity.content : null;
  const twitterKindLabel =
    activity.metadata.tweetKind === 'reply'
      ? '回复'
      : activity.metadata.tweetKind === 'quote'
        ? '引用'
        : activity.metadata.tweetKind === 'tweet'
          ? '发推'
          : activity.title?.includes('回复')
            ? '回复'
            : activity.title?.includes('引用')
              ? '引用'
              : isTwitter
                ? '发推'
                : null;
  const typeLabel = isTwitter ? twitterKindLabel : (typeLabels[activity.type] || activity.type);
  const twitterContent = isTwitter ? collapseEmptyLines(activity.content) : activity.content;
  const coHitUserCount = activity.metadata.coHitUserCount ?? 1;
  const coHitAddressCount = activity.metadata.coHitAddressCount ?? 1;
  const hasCoHitMarker = coHitUserCount > 1 || coHitAddressCount > 1;
  const explorerTxUrl = getExplorerTxUrl(activity.metadata.chain, activity.metadata.txHash || '');
  const tweetUrl = activity.metadata.tweetUrl || '';
  const copyText = useCallback(async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.warn('[ActivityCard] 复制失败:', error);
    }
  }, []);

  useEffect(() => {
    const switchingBackToRelative =
      timeDisplayMode === 'relative' && lastTimeDisplayModeRef.current !== 'relative';
    lastTimeDisplayModeRef.current = timeDisplayMode;

    if (timeDisplayMode === 'absolute') {
      return;
    }

    const refreshDelayMs =
      switchingBackToRelative || now === activity.timestamp
        ? 0
        : nextUpdateInMs === null
          ? null
          : Math.max(250, nextUpdateInMs);

    if (refreshDelayMs === null) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setNow(Date.now());
    }, refreshDelayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activity.timestamp, nextUpdateInMs, now, timeDisplayMode]);

  useEffect(() => {
    return () => {
      if (txCopyTimerRef.current !== null) {
        window.clearTimeout(txCopyTimerRef.current);
      }
      if (tweetCopyTimerRef.current !== null) {
        window.clearTimeout(tweetCopyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!isTransfer || !tokenCa || !activity.metadata.chain) {
      return;
    }

    const cached = tokenInfoCache.get(tokenInfoKey);
    if (cached !== undefined) {
      return;
    }

    const query = new URLSearchParams({
      chain: activity.metadata.chain,
      tokenAddress: tokenCa,
      tokenSymbol: tokenSymbolUpper,
      txTimestamp: String(activity.timestamp),
      txHash,
    });

    void fetch(`/api/token-logo?${query.toString()}`, {
      method: 'GET',
      cache: 'force-cache',
    })
      .then(async (response) => {
        if (!response.ok) {
          return { logoUrl: null, marketCapUsd: null, marketCapAtTxUsd: null, marketCapAtTxEstimated: false };
        }
        const payload = (await response.json()) as {
          logoUrl?: string | null;
          marketCapUsd?: number | null;
          marketCapAtTxUsd?: number | null;
          marketCapAtTxEstimated?: boolean;
          source?: 'dexscreener' | 'okx' | 'xxyy' | 'telegram-monitor' | null;
        };
        return {
          logoUrl: typeof payload.logoUrl === 'string' && payload.logoUrl.trim() ? payload.logoUrl : null,
          marketCapUsd: typeof payload.marketCapUsd === 'number' && Number.isFinite(payload.marketCapUsd)
            ? payload.marketCapUsd
            : null,
          marketCapAtTxUsd: typeof payload.marketCapAtTxUsd === 'number' && Number.isFinite(payload.marketCapAtTxUsd)
            ? payload.marketCapAtTxUsd
            : null,
          marketCapAtTxEstimated: Boolean(payload.marketCapAtTxEstimated),
          source: payload.source || null,
        };
      })
      .catch(() => ({ logoUrl: null, marketCapUsd: null, marketCapAtTxUsd: null, marketCapAtTxEstimated: false, source: null }))
      .then((nextTokenInfo) => {
        const cachedAvatar = tokenAvatarCache.get(tokenAvatarKey);
        const resolvedAvatar = cachedAvatar || nextTokenInfo.logoUrl || null;
        if (resolvedAvatar) {
          tokenAvatarCache.set(tokenAvatarKey, resolvedAvatar);
        }
        const nextResolvedTokenInfo = {
          ...nextTokenInfo,
          logoUrl: resolvedAvatar,
        };
        tokenInfoCache.set(tokenInfoKey, nextResolvedTokenInfo);
        if (!cancelled) {
          setTokenInfoState({ key: tokenInfoKey, info: nextResolvedTokenInfo });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activity.metadata.chain, activity.timestamp, isTransfer, tokenAvatarKey, tokenCa, tokenInfoKey, tokenSymbolUpper, txHash]);

  return (
    <Card 
      className={`group cursor-pointer gap-0 rounded-none py-0 shadow-none ring-0 transition-all ${
        isMergedTradeCard
          ? 'border-y border-sky-500/20 bg-gradient-to-r from-sky-500/8 via-cyan-500/6 to-transparent hover:bg-sky-500/10'
          : 'border-0 bg-transparent hover:bg-zinc-900/60'
      } ${
        isSameCaHighlighted
          ? 'relative z-10 bg-emerald-500/8 ring-1 ring-emerald-400/60 shadow-[0_0_0_1px_rgba(74,222,128,0.35),0_0_18px_rgba(16,185,129,0.35)]'
          : ''
      }`}
      onClick={onClick}
    >
      <CardContent className="px-3 py-2">
        <div className="grid gap-y-1 md:grid-cols-[minmax(0,0.78fr)_8.75rem_minmax(0,1.22fr)] md:gap-x-1">
          {!isTransfer && (
            <div className="flex min-w-0 items-start gap-1.5 text-[13px] md:col-start-3 md:row-start-1 md:self-start">
              <Avatar className="h-9 w-9 shrink-0">
                <AvatarImage src={getUserAvatar(user)} alt={user.name} />
                <AvatarFallback className="bg-zinc-800 text-[11px] text-zinc-400">
                  {user.name.slice(0, 1).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-semibold text-zinc-300">{user.name}</span>
                  {isTwitter && tweetUrl ? (
                    <button
                      type="button"
                      className="shrink-0 rounded px-1 py-0 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                      title="左键复制推文链接，右键打开推文"
                      onClick={async (event) => {
                        event.stopPropagation();
                        await copyText(tweetUrl);
                        setTweetLinkCopied(true);
                        if (tweetCopyTimerRef.current !== null) {
                          window.clearTimeout(tweetCopyTimerRef.current);
                        }
                        tweetCopyTimerRef.current = window.setTimeout(() => {
                          setTweetLinkCopied(false);
                        }, 1200);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        window.open(tweetUrl, '_blank', 'noopener,noreferrer');
                      }}
                    >
                        {tweetLinkCopied ? '已复制' : timeAgo}
                    </button>
                  ) : null}
                </div>
                {isBlockchain && (
                  <div className="mt-0.5 text-zinc-500">
                    {activity.metadata.txHash ? (
                      <button
                        type="button"
                        className="rounded px-1 py-0 -ml-1 hover:bg-zinc-800 hover:text-zinc-300"
                        title="左键复制交易哈希，右键打开 OKX 浏览器"
                        onClick={async (event) => {
                          event.stopPropagation();
                          await copyText(activity.metadata.txHash || '');
                          setTxCopied(true);
                          if (txCopyTimerRef.current !== null) {
                            window.clearTimeout(txCopyTimerRef.current);
                          }
                          txCopyTimerRef.current = window.setTimeout(() => {
                            setTxCopied(false);
                          }, 1200);
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          if (explorerTxUrl) {
                            window.open(explorerTxUrl, '_blank', 'noopener,noreferrer');
                          }
                        }}
                      >
                        {txCopied ? '已复制' : timeAgo}
                      </button>
                    ) : (
                      timeAgo
                    )}
                  </div>
                )}
                {activity.type !== 'transfer' && typeLabel && (
                  <div className="mt-0.5 text-zinc-500">{typeLabel}</div>
                )}
              </div>
            </div>
          )}

          <div
            className={`min-w-0 md:row-start-1 ${
              isTransfer
                ? 'md:col-start-1 md:col-span-3 md:justify-self-stretch md:pl-1 md:pr-1'
                : isBlockchain || isTwitter
                ? 'md:col-start-1 md:col-span-2 md:justify-self-stretch md:pl-1 md:pr-1'
                : 'md:col-start-3 md:justify-self-stretch md:pl-1 md:pr-1'
            }`}
          >
            <div className="space-y-0.5">
              <div className="flex min-w-0 flex-wrap items-center gap-1 text-[13px] leading-5">
                {!isTwitter && !isTransfer && (
                  <span className="line-clamp-1 text-zinc-300">{primaryText}</span>
                )}
                {isTransfer && (
                  <div className="w-full min-w-0">
                    <div className="grid h-10 w-full min-w-0 grid-cols-[2.5rem_minmax(0,1fr)_8.75rem] grid-rows-2 gap-x-0.5 md:w-[23.417rem] md:max-w-[23.417rem] md:grid-cols-[2.5rem_12.167rem_8.75rem]">
                      <div className="row-span-2 flex items-center">
                        {canCopyTokenCa ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void copyText(tokenCa);
                            }}
                            className={`rounded-md transition-all hover:bg-yellow-500/10 ${
                              isSameCaHighlighted
                                ? 'bg-yellow-400/25 text-yellow-100 ring-1 ring-yellow-300/80 shadow-[0_0_16px_rgba(250,204,21,0.55)] animate-pulse'
                                : ''
                            }`}
                            title={`复制 ${displayTokenSymbol} CA: ${tokenCa}`}
                            onMouseEnter={() => onTokenCaHover?.(tokenCa)}
                            onMouseLeave={() => onTokenCaHover?.(null)}
                          >
                            <Avatar className="h-10 w-10 shrink-0 rounded-md">
                              <AvatarImage src={resolvedTokenAvatar || undefined} alt={`${displayTokenSymbol} avatar`} />
                              <AvatarFallback className="rounded-md bg-zinc-800 text-[11px] text-zinc-400">
                                {displayTokenSymbol.slice(0, 1)}
                              </AvatarFallback>
                            </Avatar>
                          </button>
                        ) : (
                          <Avatar className="h-10 w-10 shrink-0 rounded-md">
                            <AvatarImage src={resolvedTokenAvatar || undefined} alt={`${displayTokenSymbol} avatar`} />
                            <AvatarFallback className="rounded-md bg-zinc-800 text-[11px] text-zinc-400">
                              {displayTokenSymbol.slice(0, 1)}
                            </AvatarFallback>
                          </Avatar>
                        )}
                      </div>

                      <div className="flex min-w-0 items-center justify-between gap-1">
                        <span className="min-w-0 flex-1 truncate text-left font-semibold leading-none text-zinc-300">{displayWalletLabel}</span>
                        <span
                          className={
                            shouldUseOutgoingAmountTone
                              ? 'min-w-0 shrink truncate text-right leading-none tabular-nums text-red-400'
                              : 'min-w-0 shrink truncate text-right leading-none tabular-nums text-emerald-400'
                          }
                        >
                          {[displayActionVariantLabel, displayTradeAmountText].filter(Boolean).join(' ')}
                        </span>
                      </div>

                      <div className="row-span-2 grid h-10 w-[8.75rem] grid-cols-[2.5rem_minmax(0,1fr)] grid-rows-2 items-center gap-x-0.5 justify-self-end">
                        <Avatar className="row-span-2 h-10 w-10 shrink-0">
                          <AvatarImage src={getUserAvatar(user)} alt={user.name} />
                          <AvatarFallback className="bg-zinc-800 text-[11px] text-zinc-400">
                            {user.name.slice(0, 1).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate font-semibold leading-none text-zinc-300">{user.name}</span>
                          {isMergedTradeCard && (
                            <span className="ml-auto shrink-0 rounded-full border border-sky-400/40 bg-sky-400/12 px-1.5 py-0.5 text-[10px] font-medium leading-none text-sky-200">
                              合并 {mergedTradeCount} 笔
                            </span>
                          )}
                        </div>
                        <div className="min-w-0 text-zinc-500 leading-none">
                          {activity.metadata.txHash ? (
                            <button
                              type="button"
                              className="rounded px-1 py-0 -ml-1 hover:bg-zinc-800 hover:text-zinc-300"
                              title="左键复制交易哈希，右键打开 OKX 浏览器"
                              onClick={async (event) => {
                                event.stopPropagation();
                                await copyText(activity.metadata.txHash || '');
                                setTxCopied(true);
                                if (txCopyTimerRef.current !== null) {
                                  window.clearTimeout(txCopyTimerRef.current);
                                }
                                txCopyTimerRef.current = window.setTimeout(() => {
                                  setTxCopied(false);
                                }, 1200);
                              }}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (explorerTxUrl) {
                                  window.open(explorerTxUrl, '_blank', 'noopener,noreferrer');
                                }
                              }}
                            >
                              {txCopied ? '已复制' : timeAgo}
                            </button>
                          ) : (
                            timeAgo
                          )}
                        </div>
                      </div>

                      <div className="flex min-w-0 items-center justify-between gap-1">
                        <span className="min-w-0 flex-1 truncate text-left font-semibold leading-none text-yellow-400">{displayTokenSymbol}</span>
                        {displayMarketCapText ? (
                          <span className="ml-auto shrink-0 whitespace-nowrap text-right leading-none tabular-nums text-zinc-300" title={marketCapTooltip}>
                            {displayMarketCapText}
                          </span>
                        ) : (
                          <span className="min-w-0" />
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {!isTransfer && isTwitter && (
                  <span className="w-full whitespace-pre-wrap break-words text-zinc-100">{twitterContent}</span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-2 text-[12px] text-zinc-500">
                {secondaryText && <span className="line-clamp-1">{secondaryText}</span>}
                {!isTwitter && activity.metadata.likes !== undefined && (
                  <span className="flex items-center gap-1">
                    👍
                    {activity.metadata.likes}
                  </span>
                )}
                {!isTwitter && activity.metadata.replies !== undefined && (
                  <span className="flex items-center gap-1">
                    💬
                    {activity.metadata.replies}
                  </span>
                )}
                {hasMedia && !isBlockchain && <span>媒体</span>}
                {hasCoHitMarker && (
                  <span
                    className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-cyan-300"
                    title={activity.metadata.coHitUserNames?.join(' / ') || '同交易命中多个关注地址'}
                  >
                    命中 {coHitUserCount} 人/{coHitAddressCount} 地址
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
