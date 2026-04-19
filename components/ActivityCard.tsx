'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, User } from '@/types';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card, CardContent } from '@/components/ui/card';
import { getUserAvatar } from '@/lib/userProfile';
import { formatTokenAmount } from '@/lib/assetFormat';
import { formatRelativeTimeCompact } from '@/lib/timeFormat';

interface ActivityCardProps {
  activity: Activity;
  user: User;
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

const tokenInfoCache = new Map<string, TokenInfoSnapshot>();

function formatAddressShort(address: string) {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
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

function getGmgnAddressUrl(chain: string | undefined, address: string) {
  if (!address) return null;
  const gmgnChain = chain === 'bsc' ? 'bsc' : chain === 'ethereum' ? 'eth' : 'sol';
  return `https://gmgn.ai/${gmgnChain}/address/${address}`;
}

function collapseEmptyLines(text: string) {
  if (!text) return '';
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]*\n+/g, '\n')
    .trim();
}

function formatMarketCapShort(marketCapUsd: number | null) {
  if (marketCapUsd === null || !Number.isFinite(marketCapUsd) || marketCapUsd <= 0) {
    return null;
  }

  const formatCompact = (value: number, unit: string) => {
    const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return `$${value.toFixed(decimals).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1')}${unit}`;
  };

  if (marketCapUsd >= 1_000_000_000) {
    return formatCompact(marketCapUsd / 1_000_000_000, 'B');
  }
  if (marketCapUsd >= 1_000_000) {
    return formatCompact(marketCapUsd / 1_000_000, 'M');
  }
  if (marketCapUsd >= 1_000) {
    return formatCompact(marketCapUsd / 1_000, 'K');
  }
  return `$${Math.round(marketCapUsd)}`;
}

function formatTradeHeadlineQuote(value: string | number | null | undefined, quoteToken: string) {
  const raw = typeof value === 'number' ? value : Number.parseFloat(String(value || '').replace(/,/g, '').trim());
  if (!Number.isFinite(raw) || raw <= 0 || !quoteToken.trim()) {
    return null;
  }
  return `${raw.toFixed(2).replace(/\.00$/, '.0').replace(/(\.\d)0$/, '$1')} ${quoteToken.trim().toUpperCase()}`;
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

export function ActivityCard({
  activity,
  user,
  onClick,
  activeTokenCa = null,
  onTokenCaHover,
  activeAddress = null,
  onAddressHover,
  addressAliasMap,
}: ActivityCardProps) {
  const [now, setNow] = useState(activity.timestamp);
  const timeAgo = formatRelativeTimeCompact(activity.timestamp, now);
  const [txCopied, setTxCopied] = useState(false);
  const [tweetLinkCopied, setTweetLinkCopied] = useState(false);
  const txCopyTimerRef = useRef<number | null>(null);
  const tweetCopyTimerRef = useRef<number | null>(null);

  const isBlockchain = activity.source === 'blockchain';
  const isTwitter = activity.source === 'twitter';
  const hasMedia = Boolean(activity.metadata.media && activity.metadata.media.length > 0);
  const isTransfer = isBlockchain && activity.type === 'transfer';
  const fromAddress = activity.metadata.fromAddress || '';
  const toAddress = activity.metadata.toAddress || '';
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
  const tokenSymbolRaw = (activity.metadata.token || '').trim();
  const tokenSymbolUpper = tokenSymbolRaw.toUpperCase();
  const tokenSymbolDisplay = tokenSymbolRaw || 'UNKNOWN';
  const tokenCa = activity.metadata.tokenAddress || '';
  const txHash = activity.metadata.txHash || '';
  const txTimestampBucket = Math.floor(activity.timestamp / 60_000);
  const tokenLogoKey = `${activity.metadata.chain || ''}:${tokenCa.toLowerCase()}:${tokenSymbolUpper}:${txTimestampBucket}:${(activity.metadata.txHash || '').toLowerCase()}`;
  const cachedTokenInfo = tokenInfoCache.get(tokenLogoKey);
  const [tokenInfoState, setTokenInfoState] = useState<{ key: string; info: TokenInfoSnapshot }>({
    key: tokenLogoKey,
    info: cachedTokenInfo ?? { logoUrl: null, marketCapUsd: null, marketCapAtTxUsd: null, marketCapAtTxEstimated: false },
  });
  const resolvedTokenInfo =
    cachedTokenInfo ??
    (
      tokenInfoState.key === tokenLogoKey
        ? tokenInfoState.info
        : { logoUrl: null, marketCapUsd: null, marketCapAtTxUsd: null, marketCapAtTxEstimated: false }
    );
  const resolvedTokenAvatar = resolvedTokenInfo.logoUrl;
  const formattedTokenAmount = formatTokenAmount(activity.metadata.value);
  const quoteToken = activity.metadata.quoteToken || '';
  const quoteTokenUpper = quoteToken.toUpperCase();
  const formattedQuoteAmount = formatTokenAmount(activity.metadata.quoteAmount);
  const trackedAddress = activity.metadata.trackedAddress || '';
  const hasTradeQuote =
    Boolean(activity.metadata.quoteAmount) &&
    Boolean(quoteToken) &&
    (activity.metadata.txAction === 'sell' || activity.metadata.txAction === 'buy');
  const isTradeAction =
    activity.metadata.txAction === 'buy' ||
    activity.metadata.txAction === 'sell' ||
    activity.metadata.txAction === 'send';
  const tradeMarketCapUsd =
    resolvedTokenInfo.marketCapAtTxUsd ??
    (typeof activity.metadata.marketCapAtTxUsd === 'number' ? activity.metadata.marketCapAtTxUsd : null) ??
    resolvedTokenInfo.marketCapUsd;
  const marketCapLabel = formatMarketCapShort(isTradeAction ? tradeMarketCapUsd : resolvedTokenInfo.marketCapUsd);
  const marketCapTooltip =
    resolvedTokenInfo.source === 'telegram-monitor'
      ? '来自 XXYY Telegram 监控推送（精确）'
      : resolvedTokenInfo.marketCapAtTxEstimated
        ? '基于 OKX 历史K线推算的交易时市值（估算）'
        : '市值';
  const normalizedFromAddress = fromAddress.toLowerCase();
  const normalizedToAddress = toAddress.toLowerCase();
  const normalizedTrackedAddress = trackedAddress.toLowerCase();
  const fromAddressAlias = fromAddress ? addressAliasMap?.get(normalizedFromAddress) || null : null;
  const toAddressAlias = toAddress ? addressAliasMap?.get(normalizedToAddress) || null : null;
  const trackedAddressAlias = trackedAddress ? addressAliasMap?.get(normalizedTrackedAddress) || null : null;
  const monitorAliasLabel = activity.metadata.monitorWalletAliasLabel || null;
  const actorLabel = monitorAliasLabel || trackedAddressAlias || (trackedAddress ? formatAddressShort(trackedAddress) : null);
  const tradeHeadlineValue = hasTradeQuote
    ? formatTradeHeadlineQuote(activity.metadata.quoteAmount, quoteTokenUpper)
    : `${formattedTokenAmount} ${tokenSymbolDisplay}`;
  const tradeActionLabel = txActionLabel;
  const tradeHeadlineText = `${tradeActionLabel}${tradeHeadlineValue ? tradeHeadlineValue : ''}`.trim();
  const canCopyTokenCa = Boolean(
    tokenCa && tokenSymbolRaw && !NATIVE_OR_STABLE_SYMBOLS.has(tokenSymbolRaw.toLowerCase())
  );
  const isSameCaHighlighted =
    Boolean(activeTokenCa) && Boolean(tokenCa) && activeTokenCa?.toLowerCase() === tokenCa.toLowerCase();
  const isFromAddressHighlighted =
    Boolean(activeAddress) && Boolean(fromAddress) && activeAddress?.toLowerCase() === normalizedFromAddress;
  const isToAddressHighlighted =
    Boolean(activeAddress) && Boolean(toAddress) && activeAddress?.toLowerCase() === normalizedToAddress;
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
  const directionTone = isTransfer ? (isOutgoing ? 'outgoing' : 'incoming') : null;
  const coHitUserCount = activity.metadata.coHitUserCount ?? 1;
  const coHitAddressCount = activity.metadata.coHitAddressCount ?? 1;
  const hasCoHitMarker = coHitUserCount > 1 || coHitAddressCount > 1;
  const explorerTxUrl = getExplorerTxUrl(activity.metadata.chain, activity.metadata.txHash || '');
  const fromAddressGmgnUrl = getGmgnAddressUrl(activity.metadata.chain, fromAddress);
  const toAddressGmgnUrl = getGmgnAddressUrl(activity.metadata.chain, toAddress);
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
    const kickoff = window.setTimeout(() => {
      setNow(Date.now());
    }, 0);

    return () => {
      window.clearTimeout(kickoff);
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

    const cached = tokenInfoCache.get(tokenLogoKey);
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
        tokenInfoCache.set(tokenLogoKey, nextTokenInfo);
        if (!cancelled) {
          setTokenInfoState({ key: tokenLogoKey, info: nextTokenInfo });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activity.metadata.chain, activity.timestamp, isTransfer, tokenCa, tokenLogoKey, tokenSymbolUpper, txHash]);

  return (
    <Card 
      className={`group cursor-pointer gap-0 rounded-none border-0 bg-transparent py-0 shadow-none ring-0 transition-all hover:bg-zinc-900/60 ${
        isSameCaHighlighted
          ? 'relative z-10 bg-emerald-500/8 ring-1 ring-emerald-400/60 shadow-[0_0_0_1px_rgba(74,222,128,0.35),0_0_18px_rgba(16,185,129,0.35)]'
          : ''
      }`}
      onClick={onClick}
    >
      <CardContent className="px-3 py-2">
        <div className="grid gap-y-1 md:grid-cols-[minmax(0,0.78fr)_8.75rem_minmax(0,1.22fr)] md:gap-x-1">
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

          <div
            className={`min-w-0 md:row-start-1 ${
              isBlockchain || isTwitter
                ? 'md:col-start-1 md:col-span-2 md:justify-self-stretch md:pl-1 md:pr-1'
                : 'md:col-start-3 md:justify-self-stretch md:pl-1 md:pr-1'
            }`}
          >
            <div className="space-y-0.5">
              <div className="flex min-w-0 flex-wrap items-center gap-1 text-[13px] leading-5">
                {!isTwitter && !isTransfer && (
                  <span className="line-clamp-1 text-zinc-300">{primaryText}</span>
                )}
                {!isTwitter && isTransfer && !isTradeAction && (
                  <span className={directionTone === 'outgoing' ? 'text-red-400' : 'text-emerald-400'}>
                    {transferAction}
                  </span>
                )}
                {isTransfer && (
                  <>
                    {isTradeAction && (
                      <div className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
                        <span className="truncate text-left font-semibold text-zinc-300">{actorLabel || user.name}</span>
                        <span
                          className={
                            txActionLabel === '减仓' || txActionLabel === '清仓'
                              ? 'min-w-[6.5rem] truncate text-right tabular-nums text-red-400'
                              : 'min-w-[6.5rem] truncate text-right tabular-nums text-emerald-400'
                          }
                        >
                          {tradeHeadlineText}
                        </span>

                        <div className="flex min-w-0 items-center gap-1 overflow-hidden text-left">
                          <Avatar className="h-3.5 w-3.5 shrink-0">
                            <AvatarImage src={resolvedTokenAvatar || undefined} alt={`${tokenSymbolDisplay} avatar`} />
                            <AvatarFallback className="bg-zinc-800 text-[8px] text-zinc-400">
                              {tokenSymbolDisplay.slice(0, 1)}
                            </AvatarFallback>
                          </Avatar>
                          {canCopyTokenCa ? (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                void copyText(tokenCa);
                              }}
                              className={`max-w-full overflow-x-auto whitespace-nowrap rounded px-1 py-0 text-left font-semibold text-yellow-400 transition-all hover:bg-yellow-500/10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
                                isSameCaHighlighted
                                  ? 'bg-yellow-400/25 text-yellow-100 ring-1 ring-yellow-300/80 shadow-[0_0_16px_rgba(250,204,21,0.55)] animate-pulse'
                                  : ''
                              }`}
                              title={`复制 ${tokenSymbolDisplay} CA: ${tokenCa}`}
                              onMouseEnter={() => onTokenCaHover?.(tokenCa)}
                              onMouseLeave={() => onTokenCaHover?.(null)}
                            >
                              {tokenSymbolDisplay}
                            </button>
                          ) : (
                            <span className="max-w-full overflow-x-auto whitespace-nowrap font-semibold text-yellow-400 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                              {tokenSymbolDisplay}
                            </span>
                          )}
                        </div>

                        {txActionLabel !== '发送' && marketCapLabel ? (
                          <span className="min-w-0 whitespace-nowrap text-right tabular-nums" title={marketCapTooltip}>
                            <span className="text-zinc-500">MC:</span>
                            <span className="text-zinc-100">{marketCapLabel}</span>
                          </span>
                        ) : (
                          <span className="min-w-0" />
                        )}
                      </div>
                    )}
                    {!isTradeAction && <span className="font-semibold text-zinc-300">{formattedTokenAmount}</span>}
                    {!isTradeAction && (
                      <Avatar className="h-3.5 w-3.5 shrink-0">
                        <AvatarImage src={resolvedTokenAvatar || undefined} alt={`${tokenSymbolDisplay} avatar`} />
                        <AvatarFallback className="bg-zinc-800 text-[8px] text-zinc-400">
                          {tokenSymbolDisplay.slice(0, 1)}
                        </AvatarFallback>
                      </Avatar>
                    )}
                    {!isTradeAction && (canCopyTokenCa ? (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void copyText(tokenCa);
                        }}
                        className={`rounded px-1 py-0 font-semibold text-yellow-400 transition-all hover:bg-yellow-500/10 ${
                          isSameCaHighlighted
                            ? 'bg-yellow-400/25 text-yellow-100 ring-1 ring-yellow-300/80 shadow-[0_0_16px_rgba(250,204,21,0.55)] animate-pulse'
                            : ''
                        }`}
                        title={`复制 ${tokenSymbolDisplay} CA: ${tokenCa}`}
                        onMouseEnter={() => onTokenCaHover?.(tokenCa)}
                        onMouseLeave={() => onTokenCaHover?.(null)}
                      >
                        {tokenSymbolDisplay}
                      </button>
                    ) : (
                      <span className="font-semibold text-yellow-400">{tokenSymbolDisplay}</span>
                    ))}
                    {!isTradeAction && hasTradeQuote && (
                      <span className="font-semibold text-emerald-300">
                        花费 {formattedQuoteAmount} {quoteTokenUpper}
                      </span>
                    )}
                    {!isTradeAction && fromAddress && toAddress && (
                      <>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void copyText(fromAddress);
                          }}
                          className={`truncate rounded px-1 py-0 text-zinc-400 transition-all hover:bg-zinc-800 ${
                            isFromAddressHighlighted
                              ? 'bg-cyan-400/25 text-cyan-100 ring-1 ring-cyan-300/80 shadow-[0_0_16px_rgba(34,211,238,0.65)] animate-pulse'
                              : ''
                          }`}
                          title={`左键复制地址，右键打开 GMGN: ${fromAddress}`}
                          onMouseEnter={() => onAddressHover?.(fromAddress)}
                          onMouseLeave={() => onAddressHover?.(null)}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (fromAddressGmgnUrl) {
                              window.open(fromAddressGmgnUrl, '_blank', 'noopener,noreferrer');
                            }
                          }}
                        >
                          {fromAddressAlias || formatAddressShort(fromAddress)}
                        </button>
                        <span className="text-zinc-600">→</span>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void copyText(toAddress);
                          }}
                          className={`truncate rounded px-1 py-0 text-zinc-400 transition-all hover:bg-zinc-800 ${
                            isToAddressHighlighted
                              ? 'bg-cyan-400/25 text-cyan-100 ring-1 ring-cyan-300/80 shadow-[0_0_16px_rgba(34,211,238,0.65)] animate-pulse'
                              : ''
                          }`}
                          title={`左键复制地址，右键打开 GMGN: ${toAddress}`}
                          onMouseEnter={() => onAddressHover?.(toAddress)}
                          onMouseLeave={() => onAddressHover?.(null)}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (toAddressGmgnUrl) {
                              window.open(toAddressGmgnUrl, '_blank', 'noopener,noreferrer');
                            }
                          }}
                        >
                          {toAddressAlias || formatAddressShort(toAddress)}
                        </button>
                      </>
                    )}
                  </>
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
