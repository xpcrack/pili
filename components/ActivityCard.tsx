'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Activity, User } from '@/types';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card, CardContent } from '@/components/ui/card';
import { toProxiedMediaUrl } from '@/lib/mediaProxy';
import { getUserAvatar } from '@/lib/userProfile';
import { buildActivityCardViewModel } from '@/lib/activityCardViewModel';
import {
  cleanTwitterDisplayText,
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
import { highlightSocialContent } from '@/lib/socialContentHighlight';
import { formatCompactMarketCap, type TradeValueDisplayMode, tradeUsdBarPercent } from '@/lib/tradeDisplay';

interface ActivityCardProps {
  activity: Activity;
  user: User;
  timeDisplayMode?: FeedTimeDisplayMode;
  tradeValueDisplayMode?: TradeValueDisplayMode;
  onClick?: () => void;
  addressAliasMap?: Map<string, string>;
}

interface TokenInfoSnapshot {
  logoUrl: string | null;
  marketCapUsd: number | null;
  marketCapAtTxUsd: number | null;
  marketCapAtTxEstimated: boolean;
  source?: 'dexscreener' | 'okx' | 'gmgn' | 'xxyy' | 'telegram-monitor' | null;
}

const tokenAvatarCache = new Map<string, string | null>();
const tokenInfoCache = new Map<string, TokenInfoSnapshot>();

export const ActivityCard = memo(function ActivityCard({
  activity,
  user,
  timeDisplayMode = 'relative',
  tradeValueDisplayMode = 'native',
  onClick,
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
  const resolvedTokenAvatarRaw = cachedTokenAvatar !== undefined ? cachedTokenAvatar : resolvedTokenInfo.logoUrl;
  const resolvedTokenAvatar = toProxiedMediaUrl(resolvedTokenAvatarRaw);
  const {
    isBlockchain,
    isTwitter,
    isTelegram,
    isNews,
    newsChannelLabel,
    hasMedia,
    isTransfer,
    transferAction,
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
    displayTradeAmountText,
    displayTradeUsdText,
    tradeAmountUsdAtTx,
    positionDeltaText,
    positionDeltaTone,
    displayTokenSymbol,
    displayMarketCapText,
    shouldUseOutgoingAmountTone,
    canCopyTokenCa,
    primaryText,
    explorerTxUrl,
    tokenGmgnUrl,
    trackedAddressGmgnUrl,
    counterpartyGmgnUrl,
  } = buildActivityCardViewModel({
    activity,
    user,
    tradeValueDisplayMode,
    resolvedTokenInfo,
    addressAliasMap,
  });
  const tradeUsdBarPct =
    tradeAmountUsdAtTx != null ? tradeUsdBarPercent(tradeAmountUsdAtTx) : 0;
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
    isNews,
  });
  const twitterContent = isTwitter ? cleanTwitterDisplayText(activity.content) : activity.content;
  const twitterPrimaryText =
    isTwitter ? collapseActivityCardText(activity.metadata.translationZh || twitterContent) : primaryText;
  const twitterQuotedOriginal = isTwitter
    ? cleanTwitterDisplayText(activity.metadata.quotedTweetContent || '')
    : '';
  const twitterQuotedContent = isTwitter
    ? cleanTwitterDisplayText(
        activity.metadata.quotedTweetTranslationZh || activity.metadata.quotedTweetContent || ''
      )
    : '';
  const twitterQuotedAuthorHandle = isTwitter ? (activity.metadata.quotedTweetAuthorHandle || '').trim() : '';
  const telegramPrimaryText = isTelegram ? getTelegramCardPrimaryText(activity.content) : null;
  const telegramTranslationZh = isTelegram ? (activity.metadata.translationZh || '').trim() : '';
  const telegramDisplayPrimary = isTelegram
    ? (telegramTranslationZh || telegramPrimaryText || '')
    : '';
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
  const telegramSentimentChips = isTelegram
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
          source?: 'dexscreener' | 'okx' | 'gmgn' | 'xxyy' | 'telegram-monitor' | null;
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

  const positionDeltaClassName =
    positionDeltaTone === 'up'
      ? 'text-emerald-300'
      : positionDeltaTone === 'down'
        ? 'text-rose-300'
        : 'text-zinc-500';

  // 交易：单行表布局（设计稿 v1）
  if (isTransfer && isTradeAction) {
    return (
      <Card
        data-feed-card
        data-trade-row
        className="group relative cursor-pointer gap-0 rounded-none border-0 bg-transparent py-0 shadow-none ring-0 transition-colors hover:bg-white/[0.035]"
        onClick={onClick}
      >
        <CardContent className="px-0 py-0">
          <div
            className="feed-trade-row grid min-h-10 items-center gap-x-1.5 border-b border-white/[0.035] px-3 py-1.5 text-[12.5px] tabular-nums"
            style={{
              gridTemplateColumns:
                '28px 100px 120px 48px 68px minmax(72px,1fr) 40px',
            }}
          >
            <Avatar className="h-7 w-7 shrink-0">
              <AvatarImage src={getUserAvatar(user)} alt={user.name} />
              <AvatarFallback className="bg-zinc-800 text-[10px] text-zinc-400">
                {user.name.slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>

            <div className="min-w-0">
              <div className="truncate font-semibold leading-tight text-zinc-100">{user.name}</div>
              <div className="mt-0.5 min-w-0">
                {trackedAddress ? (
                  <button
                    type="button"
                    className="max-w-full truncate rounded text-left text-[10.5px] leading-none text-zinc-500 transition-colors hover:bg-cyan-500/10 hover:text-zinc-300"
                    title={`左键复制地址，右键打开 GMGN: ${trackedAddress}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void copyText(trackedAddress);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openExternalLink(trackedAddressGmgnUrl);
                    }}
                  >
                    {displayWalletLabel}
                  </button>
                ) : (
                  <span className="truncate text-[10.5px] leading-none text-zinc-500">{displayWalletLabel}</span>
                )}
              </div>
            </div>

            <div className="flex min-w-0 items-center gap-1.5">
              {canCopyTokenCa ? (
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-1.5 rounded px-0.5 transition-colors hover:bg-yellow-500/10"
                  title={`左键复制 ${displayTokenSymbol} CA，右键打开 GMGN: ${tokenCa}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void copyText(tokenCa);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openExternalLink(tokenGmgnUrl);
                  }}
                >
                  <Avatar className="h-[18px] w-[18px] shrink-0 rounded-[5px]">
                    <AvatarImage src={resolvedTokenAvatar || undefined} alt={displayTokenSymbol} />
                    <AvatarFallback className="rounded-[5px] bg-zinc-800 text-[8px] text-zinc-400">
                      {displayTokenSymbol.slice(0, 1)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate font-bold tracking-wide text-zinc-100">{displayTokenSymbol}</span>
                </button>
              ) : (
                <>
                  <Avatar className="h-[18px] w-[18px] shrink-0 rounded-[5px]">
                    <AvatarImage src={resolvedTokenAvatar || undefined} alt={displayTokenSymbol} />
                    <AvatarFallback className="rounded-[5px] bg-zinc-800 text-[8px] text-zinc-400">
                      {displayTokenSymbol.slice(0, 1)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate font-bold tracking-wide text-zinc-100">{displayTokenSymbol}</span>
                </>
              )}
              {isMergedTradeCard ? (
                <span className="shrink-0 rounded-full border border-sky-400/40 bg-sky-400/12 px-1.5 py-0.5 text-[10px] font-medium leading-none text-sky-200">
                  合{mergedTradeCount}
                </span>
              ) : null}
            </div>

            <div
              className="min-w-0 truncate text-right font-semibold text-zinc-300"
              title={marketCapTooltip}
            >
              {displayMarketCapText || '—'}
            </div>

            <div className="min-w-0 truncate text-right font-semibold tabular-nums">
              <span className={positionDeltaClassName} title={displayActionVariantLabel || undefined}>
                {positionDeltaText}
              </span>
            </div>

            <div className="relative min-w-0 self-stretch">
              {tradeUsdBarPct > 0 ? (
                <div
                  aria-hidden
                  className={`absolute inset-y-0.5 left-0 rounded-sm ${
                    shouldUseOutgoingAmountTone ? 'bg-rose-500/25' : 'bg-emerald-500/25'
                  }`}
                  style={{ width: `${tradeUsdBarPct}%` }}
                />
              ) : null}
              <div
                className={`relative flex h-full min-w-0 items-center justify-start truncate px-1 font-semibold ${
                  shouldUseOutgoingAmountTone ? 'text-rose-300' : 'text-emerald-300'
                }`}
                title={displayTradeHeadlineText || displayTradeUsdText || undefined}
              >
                {displayTradeHeadlineText || displayTradeUsdText}
              </div>
            </div>

            <div className="text-right text-xs text-zinc-500">
              {activity.metadata.txHash ? (
                <button
                  type="button"
                  className="rounded px-0.5 hover:bg-zinc-800 hover:text-zinc-300"
                  title="左键复制交易哈希，右键打开浏览器"
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
        </CardContent>
      </Card>
    );
  }

  // 转账：紧凑单行（默认筛选关闭，打开时仍要可读）
  if (isTransfer && isSendReceiveTransfer) {
    const transferBadgeClass = shouldUseOutgoingAmountTone
      ? 'border-rose-400/30 bg-rose-500/12 text-rose-300'
      : 'border-emerald-400/30 bg-emerald-500/12 text-emerald-300';
    const counterpartyLabel = displayMarketCapText || '—';

    return (
      <Card
        data-feed-card
        data-transfer-row
        className="group relative cursor-pointer gap-0 rounded-none border-0 bg-transparent py-0 shadow-none ring-0 transition-colors hover:bg-white/[0.035]"
        onClick={onClick}
      >
        <CardContent className="px-0 py-0">
          <div
            className="grid min-h-10 items-center gap-x-3 border-b border-white/[0.035] px-3 py-1.5 text-[12.5px] tabular-nums"
            style={{
              gridTemplateColumns:
                '28px minmax(108px,1.1fr) minmax(88px,0.9fr) minmax(96px,0.95fr) minmax(64px,0.65fr) minmax(96px,1fr) 44px 118px',
            }}
          >
            <Avatar className="h-7 w-7 shrink-0">
              <AvatarImage src={getUserAvatar(user)} alt={user.name} />
              <AvatarFallback className="bg-zinc-800 text-[10px] text-zinc-400">
                {user.name.slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>

            <div className="min-w-0">
              <div className="truncate font-semibold leading-tight text-zinc-100">{user.name}</div>
              <div className="mt-0.5 min-w-0">
                {trackedAddress ? (
                  <button
                    type="button"
                    className="max-w-full truncate rounded text-left text-[10.5px] leading-none text-zinc-500 transition-colors hover:bg-cyan-500/10 hover:text-zinc-300"
                    title={`左键复制地址，右键打开 GMGN: ${trackedAddress}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void copyText(trackedAddress);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openExternalLink(trackedAddressGmgnUrl);
                    }}
                  >
                    {displayWalletLabel}
                  </button>
                ) : (
                  <span className="truncate text-[10.5px] leading-none text-zinc-500">{displayWalletLabel}</span>
                )}
              </div>
            </div>

            <div className="flex min-w-0 items-center gap-1.5">
              {canCopyTokenCa ? (
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-1.5 rounded px-0.5 transition-colors hover:bg-yellow-500/10"
                  title={`左键复制 ${displayTokenSymbol} CA，右键打开 GMGN: ${tokenCa}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void copyText(tokenCa);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openExternalLink(tokenGmgnUrl);
                  }}
                >
                  <Avatar className="h-[18px] w-[18px] shrink-0 rounded-[5px]">
                    <AvatarImage src={resolvedTokenAvatar || undefined} alt={displayTokenSymbol} />
                    <AvatarFallback className="rounded-[5px] bg-zinc-800 text-[8px] text-zinc-400">
                      {displayTokenSymbol.slice(0, 1)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate font-bold tracking-wide text-yellow-400">{displayTokenSymbol}</span>
                </button>
              ) : (
                <>
                  <Avatar className="h-[18px] w-[18px] shrink-0 rounded-[5px]">
                    <AvatarImage src={resolvedTokenAvatar || undefined} alt={displayTokenSymbol} />
                    <AvatarFallback className="rounded-[5px] bg-zinc-800 text-[8px] text-zinc-400">
                      {displayTokenSymbol.slice(0, 1)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate font-bold tracking-wide text-yellow-400">{displayTokenSymbol}</span>
                </>
              )}
            </div>

            <div
              className={`min-w-0 truncate text-right font-semibold ${
                shouldUseOutgoingAmountTone ? 'text-rose-300' : 'text-emerald-300'
              }`}
              title={displayTradeHeadlineText || undefined}
            >
              {displayTradeAmountText}
            </div>

            <div>
              <span
                className={`inline-flex h-[22px] min-w-[48px] items-center justify-center rounded-full border px-2 text-[11px] font-semibold ${transferBadgeClass}`}
              >
                {displayActionVariantLabel || transferAction}
              </span>
            </div>

            <div className="min-w-0">
              {counterpartyAddress ? (
                <button
                  type="button"
                  className="max-w-full truncate rounded px-0.5 text-left font-semibold text-zinc-300 transition-colors hover:bg-cyan-500/10"
                  title={`左键复制地址，右键打开 GMGN: ${counterpartyAddress}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void copyText(counterpartyAddress);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openExternalLink(counterpartyGmgnUrl);
                  }}
                >
                  {counterpartyLabel}
                </button>
              ) : (
                <span className="truncate text-zinc-500">{counterpartyLabel}</span>
              )}
            </div>

            <div className="text-right text-xs text-zinc-500">
              {activity.metadata.txHash ? (
                <button
                  type="button"
                  className="rounded px-0.5 hover:bg-zinc-800 hover:text-zinc-300"
                  title="左键复制交易哈希，右键打开浏览器"
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

            <div className="flex w-full items-center justify-end gap-1">
              <button
                type="button"
                disabled={!canCopyTokenCa}
                className="rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[10.5px] text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                title={canCopyTokenCa ? `复制 CA: ${tokenCa}` : '无 CA'}
                onClick={(event) => {
                  event.stopPropagation();
                  if (canCopyTokenCa) void copyText(tokenCa);
                }}
              >
                CA
              </button>
              <button
                type="button"
                disabled={!tokenGmgnUrl}
                className="rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[10.5px] text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                title={tokenGmgnUrl || '无 GMGN'}
                onClick={(event) => {
                  event.stopPropagation();
                  openExternalLink(tokenGmgnUrl);
                }}
              >
                GMGN
              </button>
              <button
                type="button"
                disabled={!explorerTxUrl}
                className="rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[10.5px] text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                title={explorerTxUrl || '无 TX'}
                onClick={(event) => {
                  event.stopPropagation();
                  openExternalLink(explorerTxUrl);
                }}
              >
                TX
              </button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // 推特 / TG：紧凑行（对齐交易 Feed 密度）
  if (isTwitter || isTelegram) {
    const socialPrimary = isTwitter ? twitterPrimaryText : telegramDisplayPrimary;
    const sentimentChips = isTwitter ? tweetSentimentChips : telegramSentimentChips;
    const personLabel = isNews && newsChannelLabel ? newsChannelLabel : user.name;
    const kindBadge = typeLabel || (isTwitter ? '推特' : 'TG');
    const kindBadgeClass = isNews
      ? 'border-amber-400/30 bg-amber-500/10 text-amber-200'
      : isTwitter
        ? 'border-sky-400/30 bg-sky-500/10 text-sky-200'
        : 'border-violet-400/30 bg-violet-500/10 text-violet-200';
    const quotedPreview = isTwitter
      ? (twitterQuotedContent || twitterQuotedOriginal || '').replace(/\s+/g, ' ').trim()
      : '';
    const quoteAuthor = twitterQuotedAuthorHandle ? `引用 @${twitterQuotedAuthorHandle}` : '引用';

    return (
      <Card
        data-feed-card
        data-social-row
        className="group relative cursor-pointer gap-0 rounded-none border-0 bg-transparent py-0 shadow-none ring-0 transition-colors hover:bg-white/[0.035]"
        onClick={onClick}
      >
        <CardContent className="px-0 py-0">
          <div className="flex min-h-10 items-start gap-2.5 border-b border-white/[0.035] px-3 py-2">
            <Avatar className="mt-0.5 h-7 w-7 shrink-0">
              <AvatarImage src={getUserAvatar(user)} alt={personLabel} />
              <AvatarFallback className="bg-zinc-800 text-[10px] text-zinc-400">
                {personLabel.slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>

            <div className="w-[108px] shrink-0 min-w-0">
              <div className="truncate text-[12.5px] font-semibold leading-tight text-zinc-100">{personLabel}</div>
              <div className="mt-1 flex items-center gap-1">
                <span
                  className={`inline-flex h-[18px] items-center rounded-full border px-1.5 text-[10px] font-medium leading-none ${kindBadgeClass}`}
                >
                  {kindBadge}
                </span>
                {hasMedia ? <span className="text-[10px] text-zinc-500">媒体</span> : null}
              </div>
            </div>

            <div className="min-w-0 flex-1 space-y-1">
              {socialPrimary ? (
                <p className="line-clamp-2 whitespace-pre-wrap break-words text-[12.5px] leading-[1.35] text-zinc-100">
                  {highlightSocialContent(socialPrimary, activity.metadata.tokenSentiments)}
                </p>
              ) : null}
              {quotedPreview ? (
                <p className="line-clamp-1 text-[11.5px] leading-snug text-zinc-500">
                  <span className="text-zinc-400">{quoteAuthor}</span>
                  <span className="mx-1 text-zinc-600">·</span>
                  {quotedPreview}
                </p>
              ) : null}
              {sentimentChips.length > 0 ? (
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {sentimentChips.map((chip, index) => {
                    const symbol = chip.tokenSymbol
                      ? chip.tokenSymbol.toUpperCase()
                      : chip.tokenAddress
                        ? chip.tokenAddress.length > 12
                          ? `${chip.tokenAddress.slice(0, 4)}…${chip.tokenAddress.slice(-4)}`
                          : chip.tokenAddress
                        : 'TOKEN';
                    const mcLabel = formatCompactMarketCap(chip.marketCapAtPostUsd);
                    const sentimentLabel =
                      chip.sentiment === 'positive'
                        ? '正'
                        : chip.sentiment === 'negative'
                          ? '负'
                          : '中';
                    const currentMc = formatCompactMarketCap(chip.marketCapUsd);
                    const titleParts = [
                      chip.tokenAddress || null,
                      mcLabel
                        ? `发帖时市值 ${chip.marketCapAtPostEstimated ? '~' : ''}${mcLabel}`
                        : null,
                      currentMc ? `当前市值 ${currentMc}` : null,
                    ].filter(Boolean);
                    return (
                      <span
                        key={`${chip.tokenAddress || chip.tokenSymbol || 'token'}:${index}`}
                        title={titleParts.join(' · ') || undefined}
                        className={
                          chip.sentiment === 'positive'
                            ? 'rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10.5px] text-emerald-300'
                            : chip.sentiment === 'negative'
                              ? 'rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[10.5px] text-rose-300'
                              : 'rounded-full bg-zinc-700/70 px-1.5 py-0.5 text-[10.5px] text-zinc-200'
                        }
                      >
                        {symbol}
                        {mcLabel ? ` · ${chip.marketCapAtPostEstimated ? '~' : ''}${mcLabel}` : ''}
                        {` · ${sentimentLabel}`}
                      </span>
                    );
                  })}
                </div>
              ) : null}
            </div>

            <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
              {socialPostUrl ? (
                <button
                  type="button"
                  className="rounded px-0.5 text-right text-xs tabular-nums text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
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
              ) : (
                <span className="text-xs tabular-nums text-zinc-500">{timeAgo}</span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // 兜底：非交易/非转账/非社交的其它动态
  return (
    <Card
      data-feed-card
      className="group relative cursor-pointer gap-0 rounded-none border-0 bg-transparent py-0 shadow-none ring-0 transition-colors hover:bg-white/[0.035]"
      onClick={onClick}
    >
      <CardContent className="px-3 py-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <Avatar className="h-7 w-7 shrink-0">
            <AvatarImage src={getUserAvatar(user)} alt={user.name} />
            <AvatarFallback className="bg-zinc-800 text-[10px] text-zinc-400">
              {user.name.slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
              <span className="truncate font-semibold text-zinc-100">{user.name}</span>
              {typeLabel ? <span className="shrink-0 text-[11px] text-zinc-500">{typeLabel}</span> : null}
              <span className="ml-auto shrink-0 text-xs tabular-nums text-zinc-500">{timeAgo}</span>
            </div>
            {primaryText ? (
              <p className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-zinc-300">{primaryText}</p>
            ) : null}
            {secondaryText ? (
              <p className="mt-0.5 line-clamp-1 text-[11.5px] text-zinc-500">{secondaryText}</p>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
});
