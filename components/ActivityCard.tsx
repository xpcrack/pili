'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, User } from '@/types';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { getUserAvatar } from '@/lib/userProfile';
import { getActivityCardContentColumnClass } from '@/lib/activityCardLayout';
import { buildActivityCardViewModel } from '@/lib/activityCardViewModel';
import {
  collapseActivityCardText,
  getActivityCardTypeLabel,
  getTelegramCardPrimaryText,
  usesSocialBodyLayout,
} from '@/lib/activityCardSocial';
import {
  formatAbsoluteTimeCompact,
  type FeedTimeDisplayMode,
  getRelativeTimeState,
} from '@/lib/timeFormat';
import { type TradeValueDisplayMode } from '@/lib/tradeDisplay';

interface ActivityCardProps {
  activity: Activity;
  user: User;
  timeDisplayMode?: FeedTimeDisplayMode;
  tradeValueDisplayMode?: TradeValueDisplayMode;
  onClick?: () => void;
  activeTokenCa?: string | null;
  onTokenCaHover?: (tokenCa: string | null) => void;
  activeAddress?: string | null;
  onAddressHover?: (address: string | null) => void;
  addressAliasMap?: Map<string, string>;
}

interface TokenInfoSnapshot {
  logoUrl: string | null;
  marketCapUsd: number | null;
  marketCapAtTxUsd: number | null;
  marketCapAtTxEstimated: boolean;
  source?: 'dexscreener' | 'okx' | 'xxyy' | 'telegram-monitor' | null;
}

const tokenAvatarCache = new Map<string, string | null>();
const tokenInfoCache = new Map<string, TokenInfoSnapshot>();

export function ActivityCard({
  activity,
  user,
  timeDisplayMode = 'relative',
  tradeValueDisplayMode = 'native',
  onClick,
  activeTokenCa = null,
  onTokenCaHover,
  activeAddress = null,
  onAddressHover,
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

  const txTimestampBucket = Math.floor(activity.timestamp / 60_000);
  const tokenSymbolRaw = (activity.metadata.token || '').trim();
  const tokenSymbolUpper = tokenSymbolRaw.toUpperCase();
  const tokenCa = activity.metadata.displayTokenAvatarTokenAddress || activity.metadata.tokenAddress || '';
  const txHash = activity.metadata.txHash || '';
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
  const {
    isBlockchain,
    isTwitter,
    isTelegram,
    hasMedia,
    isTransfer,
    displayActionVariantLabel,
    trackedAddress,
    isTradeAction,
    isSendReceiveTransfer,
    mergedTradeCount,
    isMergedTradeCard,
    counterpartyAddress,
    marketCapTooltip,
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
  } = buildActivityCardViewModel({
    activity,
    user,
    tradeValueDisplayMode,
    resolvedTokenInfo,
    addressAliasMap,
    activeTokenCa,
    activeAddress,
  });
  const secondaryText =
    !isBlockchain && activity.title && !usesSocialBodyLayout(activity.source) ? activity.content : null;
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
  const typeLabel = getActivityCardTypeLabel({
    source: activity.source,
    activityType: activity.type,
    twitterKindLabel,
  });
  const twitterContent = isTwitter ? collapseActivityCardText(activity.content) : activity.content;
  const twitterPrimaryText =
    isTwitter ? collapseActivityCardText(activity.metadata.translationZh || twitterContent) : primaryText;
  const twitterSecondaryText =
    isTwitter && activity.metadata.translationZh ? collapseActivityCardText(twitterContent) : secondaryText;
  const telegramPrimaryText = isTelegram ? getTelegramCardPrimaryText(activity.content) : null;
  const tweetSentimentChips = isTwitter
    ? (activity.metadata.tokenSentiments || []).filter((item, index, items) => {
        const key = `${item.tokenAddress || ''}|${item.tokenSymbol || ''}`.toLowerCase();
        return (
          items.findIndex((candidate) => {
            const candidateKey = `${candidate.tokenAddress || ''}|${candidate.tokenSymbol || ''}`.toLowerCase();
            return candidateKey === key;
          }) === index
        );
      })
    : [];
  const coHitUserCount = activity.metadata.coHitUserCount ?? 1;
  const coHitAddressCount = activity.metadata.coHitAddressCount ?? 1;
  const hasCoHitMarker = coHitUserCount > 1 || coHitAddressCount > 1;
  const socialPostUrl = activity.metadata.tweetUrl || activity.metadata.telegramPostUrl || '';
  const copyText = useCallback(async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.warn('[ActivityCard] 复制失败:', error);
    }
  }, []);
  const openExternalLink = useCallback((url: string | null) => {
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
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
      className={`group relative cursor-pointer gap-0 rounded-none py-0 shadow-none ring-0 transition-all ${
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
      <CardContent className="px-3 py-2 pr-14">
        {importanceBadgeText ? (
          <Badge
            variant="secondary"
            className={`absolute right-3 top-2 border-0 text-[10px] font-medium ${importanceBadgeClassName}`}
            title={importanceTooltip || undefined}
          >
            {importanceBadgeText}
          </Badge>
        ) : null}
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
                  {importanceLevelLabel ? (
                    <span className="truncate text-[11px] text-zinc-500">{importanceLevelLabel}</span>
                  ) : null}
                  {(isTwitter || isTelegram) && socialPostUrl ? (
                    <button
                      type="button"
                      className="shrink-0 rounded px-1 py-0 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                      title={isTwitter ? '左键复制推文链接，右键打开推文' : '左键复制频道原帖链接，右键打开原帖'}
                      onClick={async (event) => {
                        event.stopPropagation();
                        await copyText(socialPostUrl);
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
                        window.open(socialPostUrl, '_blank', 'noopener,noreferrer');
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
            className={`min-w-0 md:row-start-1 ${getActivityCardContentColumnClass({
              isTransfer,
              isBlockchain,
              isTwitter,
              isTelegram,
            })}`}
          >
            <div className="space-y-0.5">
              <div className="flex min-w-0 flex-wrap items-center gap-1 text-[13px] leading-5">
                {!isTwitter && !isTelegram && !isTransfer && (
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
                            onContextMenu={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              openExternalLink(tokenGmgnUrl);
                            }}
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

                      <div className="row-span-2 flex h-10 min-w-0 flex-col justify-between">
                        <div className="flex min-w-0 items-center justify-between gap-1">
                          <div className="min-w-0 flex items-center">
                            {canCopyTokenCa ? (
                              <button
                                type="button"
                                className={`min-w-0 flex-1 truncate rounded px-1 py-0 text-left font-semibold leading-none text-yellow-400 transition-all hover:bg-yellow-500/10 ${
                                  isSameCaHighlighted
                                    ? 'bg-yellow-400/25 text-yellow-100 ring-1 ring-yellow-300/80 shadow-[0_0_16px_rgba(250,204,21,0.55)] animate-pulse'
                                    : ''
                                }`}
                                title={`左键复制 ${displayTokenSymbol} CA，右键打开 GMGN: ${tokenCa}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void copyText(tokenCa);
                                }}
                                onMouseEnter={() => onTokenCaHover?.(tokenCa)}
                                onMouseLeave={() => onTokenCaHover?.(null)}
                                onContextMenu={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  openExternalLink(tokenGmgnUrl);
                                }}
                              >
                                {displayTokenSymbol}
                              </button>
                            ) : (
                              <span className="min-w-0 flex-1 truncate text-left font-semibold leading-none text-yellow-400">{displayTokenSymbol}</span>
                            )}
                          </div>
                          <div className="min-w-0 flex flex-1 items-center justify-end">
                            {trackedAddress ? (
                              <button
                                type="button"
                                className={`min-w-0 flex-1 truncate rounded px-1 py-0 text-right font-semibold leading-none text-zinc-300 transition-all hover:bg-cyan-500/10 ${
                                  isTrackedAddressHighlighted
                                    ? 'bg-cyan-400/20 text-cyan-100 ring-1 ring-cyan-300/70 shadow-[0_0_16px_rgba(34,211,238,0.35)]'
                                    : ''
                                }`}
                                title={`左键复制地址，右键打开 GMGN: ${trackedAddress}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void copyText(trackedAddress);
                                }}
                                onMouseEnter={() => onAddressHover?.(trackedAddress)}
                                onMouseLeave={() => onAddressHover?.(null)}
                                onContextMenu={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  openExternalLink(trackedAddressGmgnUrl);
                                }}
                              >
                                {displayWalletLabel}
                              </button>
                            ) : (
                              <span className="min-w-0 flex-1 truncate text-right font-semibold leading-none text-zinc-300">{displayWalletLabel}</span>
                            )}
                          </div>
                        </div>

                        <div className="flex min-w-0 items-center justify-between gap-1">
                          <div className="min-w-0 flex flex-1 items-center">
                            <span
                              className={
                                shouldUseOutgoingAmountTone
                                  ? 'min-w-0 shrink truncate text-right leading-none tabular-nums text-red-400'
                                  : 'min-w-0 shrink truncate text-right leading-none tabular-nums text-emerald-400'
                              }
                            >
                              {[displayActionVariantLabel, displayTradeHeadlineText].filter(Boolean).join(' ')}
                            </span>
                          </div>
                          <div className="min-w-0 flex items-center justify-end">
                            {displayMarketCapText && isSendReceiveTransfer && counterpartyAddress ? (
                              <button
                                type="button"
                                className={`ml-auto shrink-0 whitespace-nowrap rounded px-1 py-0 text-right leading-none tabular-nums text-zinc-300 transition-all hover:bg-cyan-500/10 ${
                                  isCounterpartyAddressHighlighted
                                    ? 'bg-cyan-400/20 text-cyan-100 ring-1 ring-cyan-300/70 shadow-[0_0_16px_rgba(34,211,238,0.35)]'
                                    : ''
                                }`}
                                title={`左键复制地址，右键打开 GMGN: ${counterpartyAddress}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void copyText(counterpartyAddress);
                                }}
                                onMouseEnter={() => onAddressHover?.(counterpartyAddress)}
                                onMouseLeave={() => onAddressHover?.(null)}
                                onContextMenu={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  openExternalLink(counterpartyGmgnUrl);
                                }}
                              >
                                {displayMarketCapText}
                              </button>
                            ) : isTradeAction && displayMarketCapText ? (
                              <span className="ml-auto shrink-0 whitespace-nowrap text-right leading-none tabular-nums text-zinc-300" title={marketCapTooltip}>
                                {displayMarketCapText}
                              </span>
                            ) : displayMarketCapText ? (
                              <span className="ml-auto shrink-0 whitespace-nowrap text-right leading-none tabular-nums text-zinc-300" title={marketCapTooltip}>
                                {displayMarketCapText}
                              </span>
                            ) : (
                              <span className="min-w-0" />
                            )}
                          </div>
                        </div>
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
                          {importanceLevelLabel ? (
                            <span className="truncate text-[11px] leading-none text-zinc-500">{importanceLevelLabel}</span>
                          ) : null}
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

                    </div>
                  </div>
                )}
                {!isTransfer && isTwitter && (
                  <div className="w-full space-y-1">
                    <p className="whitespace-pre-wrap break-words text-zinc-100">{twitterPrimaryText}</p>
                    {twitterSecondaryText ? (
                      <p className="whitespace-pre-wrap break-words text-xs text-zinc-500">
                        Original: {twitterSecondaryText}
                      </p>
                    ) : null}
                    {tweetSentimentChips.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {tweetSentimentChips.map((chip, index) => (
                          <span
                            key={`${chip.tokenAddress || chip.tokenSymbol || 'token'}:${index}`}
                            className={
                              chip.sentiment === 'positive'
                                ? 'rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300'
                                : chip.sentiment === 'negative'
                                  ? 'rounded-full bg-rose-500/15 px-2 py-0.5 text-[11px] text-rose-300'
                                  : 'rounded-full bg-zinc-700/70 px-2 py-0.5 text-[11px] text-zinc-200'
                            }
                          >
                            {(chip.tokenSymbol || chip.tokenAddress || 'TOKEN').toUpperCase()}{' '}
                            {chip.sentiment === 'positive' ? '正面' : chip.sentiment === 'negative' ? '负面' : '中性'}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )}
                {!isTransfer && isTelegram && (
                  <div className="w-full space-y-1">
                    <p className="whitespace-pre-wrap break-words text-zinc-100">{telegramPrimaryText}</p>
                  </div>
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
