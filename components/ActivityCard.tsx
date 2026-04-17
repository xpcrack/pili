'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, User, ActivitySource } from '@/types';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card, CardContent } from '@/components/ui/card';
import { getUserAvatar } from '@/lib/userProfile';
import { 
  X, 
  Send, 
  Link2,
  MessageCircle,
  Eye,
  ThumbsUp
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { formatTokenAmount } from '@/lib/assetFormat';

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

const sourceIcons: Record<ActivitySource, React.ReactNode> = {
  twitter: <X className="h-3.5 w-3.5" />,
  telegram: <Send className="h-3.5 w-3.5" />,
  blockchain: <Link2 className="h-3.5 w-3.5" />
};

const typeLabels: Record<string, string> = {
  post: '发布',
  transfer: '转账',
  swap: '兑换',
  nft_trade: 'NFT交易',
  mint: '铸造'
};

const NATIVE_OR_STABLE_SYMBOLS = new Set(['sol', 'bnb', 'usdt']);

function formatAddressShort(address: string) {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function getExplorerTxUrl(chain: string | undefined, txHash: string) {
  if (!txHash) return null;
  if (chain === 'bsc') {
    return `https://web3.okx.com/explorer/bsc/tx/${txHash}`;
  }
  return `https://web3.okx.com/explorer/solana/tx/${txHash}`;
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
  const timeAgo = formatDistanceToNow(activity.timestamp, { 
    addSuffix: true,
    locale: zhCN 
  });
  const [txCopied, setTxCopied] = useState(false);
  const txCopyTimerRef = useRef<number | null>(null);

  const isBlockchain = activity.source === 'blockchain';
  const hasMedia = Boolean(activity.metadata.media && activity.metadata.media.length > 0);
  const txHashShort = activity.metadata.txHash
    ? `${activity.metadata.txHash.slice(0, 8)}...${activity.metadata.txHash.slice(-6)}`
    : null;
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
  const tokenSymbol = activity.metadata.token || '';
  const tokenSymbolUpper = tokenSymbol.toUpperCase();
  const tokenCa = activity.metadata.tokenAddress || '';
  const formattedTokenAmount = formatTokenAmount(activity.metadata.value);
  const quoteToken = activity.metadata.quoteToken || '';
  const quoteTokenUpper = quoteToken.toUpperCase();
  const formattedQuoteAmount = formatTokenAmount(activity.metadata.quoteAmount);
  const hasTradeQuote =
    Boolean(activity.metadata.quoteAmount) &&
    Boolean(quoteToken) &&
    (activity.metadata.txAction === 'sell' || activity.metadata.txAction === 'buy');
  const quoteAction = activity.metadata.txAction === 'sell' ? '获得' : '花费';
  const normalizedFromAddress = fromAddress.toLowerCase();
  const normalizedToAddress = toAddress.toLowerCase();
  const fromAddressAlias = fromAddress ? addressAliasMap?.get(normalizedFromAddress) || null : null;
  const toAddressAlias = toAddress ? addressAliasMap?.get(normalizedToAddress) || null : null;
  const canCopyTokenCa = Boolean(
    tokenCa && tokenSymbol && !NATIVE_OR_STABLE_SYMBOLS.has(tokenSymbol.toLowerCase())
  );
  const isSameCaHighlighted =
    Boolean(activeTokenCa) && Boolean(tokenCa) && activeTokenCa?.toLowerCase() === tokenCa.toLowerCase();
  const isFromAddressHighlighted =
    Boolean(activeAddress) && Boolean(fromAddress) && activeAddress?.toLowerCase() === normalizedFromAddress;
  const isToAddressHighlighted =
    Boolean(activeAddress) && Boolean(toAddress) && activeAddress?.toLowerCase() === normalizedToAddress;
  const primaryText = isTransfer
    ? `${transferAction} ${formattedTokenAmount} ${tokenSymbolUpper || 'UNKNOWN'}`
    : isBlockchain
      ? activity.content
      : activity.title || activity.content;
  const secondaryText = !isBlockchain && activity.title ? activity.content : null;
  const directionTone = isTransfer ? (isOutgoing ? 'outgoing' : 'incoming') : null;
  const coHitUserCount = activity.metadata.coHitUserCount ?? 1;
  const coHitAddressCount = activity.metadata.coHitAddressCount ?? 1;
  const hasCoHitMarker = coHitUserCount > 1 || coHitAddressCount > 1;
  const explorerTxUrl = getExplorerTxUrl(activity.metadata.chain, activity.metadata.txHash || '');
  const copyText = useCallback(async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.warn('[ActivityCard] 复制失败:', error);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (txCopyTimerRef.current !== null) {
        window.clearTimeout(txCopyTimerRef.current);
      }
    };
  }, []);

  return (
    <Card 
      className={`group cursor-pointer gap-0 rounded-none border-0 bg-transparent py-0 shadow-none ring-0 transition-all hover:bg-zinc-900/60 ${
        isSameCaHighlighted
          ? 'relative z-10 bg-emerald-500/8 ring-1 ring-emerald-400/60 shadow-[0_0_0_1px_rgba(74,222,128,0.35),0_0_18px_rgba(16,185,129,0.35)]'
          : ''
      }`}
      onClick={onClick}
    >
      <CardContent className="px-3 py-1.5">
        <div className="space-y-0.5">
          <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                directionTone === 'outgoing'
                  ? 'bg-red-500'
                  : directionTone === 'incoming'
                    ? 'bg-emerald-500'
                    : 'bg-blue-500'
              }`}
            />
            <Avatar className="h-4 w-4 shrink-0">
              <AvatarImage src={getUserAvatar(user)} alt={user.name} />
              <AvatarFallback className="bg-zinc-800 text-[9px] text-zinc-400">
                {user.name.slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="truncate text-zinc-300">{user.name}</span>
            <span className="shrink-0 text-zinc-600">{sourceIcons[activity.source]}</span>
            {activity.type !== 'transfer' && (
              <span className="shrink-0 text-zinc-500">{typeLabels[activity.type] || activity.type}</span>
            )}
            <span className="ml-auto shrink-0 text-zinc-500">{timeAgo}</span>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-1 text-[12px]">
            <span className={directionTone === 'outgoing' ? 'text-red-400' : 'text-emerald-400'}>
              {isTransfer ? transferAction : primaryText}
            </span>
            {isTransfer && (
              <>
                <span className="text-zinc-300">{formattedTokenAmount}</span>
                {canCopyTokenCa ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void copyText(tokenCa);
                    }}
                    className={`rounded px-1 py-0 text-yellow-400 transition-all hover:bg-yellow-500/10 ${
                      isSameCaHighlighted
                        ? 'bg-yellow-400/25 text-yellow-100 ring-1 ring-yellow-300/80 shadow-[0_0_16px_rgba(250,204,21,0.55)] animate-pulse'
                        : ''
                    }`}
                    title={`复制 ${tokenSymbolUpper} CA: ${tokenCa}`}
                    onMouseEnter={() => onTokenCaHover?.(tokenCa)}
                    onMouseLeave={() => onTokenCaHover?.(null)}
                  >
                    {tokenSymbolUpper}
                  </button>
                ) : (
                  <span className="text-yellow-400">{tokenSymbolUpper || 'UNKNOWN'}</span>
                )}
                {hasTradeQuote && (
                  <>
                    <span className="text-zinc-500">{quoteAction}</span>
                    <span className="text-emerald-300">
                      {formattedQuoteAmount} {quoteTokenUpper}
                    </span>
                  </>
                )}
                {fromAddress && toAddress && (
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
                      title={`复制地址: ${fromAddress}`}
                      onMouseEnter={() => onAddressHover?.(fromAddress)}
                      onMouseLeave={() => onAddressHover?.(null)}
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
                      title={`复制地址: ${toAddress}`}
                      onMouseEnter={() => onAddressHover?.(toAddress)}
                      onMouseLeave={() => onAddressHover?.(null)}
                    >
                      {toAddressAlias || formatAddressShort(toAddress)}
                    </button>
                  </>
                )}
              </>
            )}
            {!isTransfer && (
              <span className="line-clamp-1 text-zinc-300">{primaryText}</span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-500">
            {secondaryText && <span className="line-clamp-1">{secondaryText}</span>}
            {activity.metadata.likes !== undefined && (
              <span className="flex items-center gap-1">
                <ThumbsUp className="h-3 w-3" />
                {activity.metadata.likes}
              </span>
            )}
            {activity.metadata.replies !== undefined && (
              <span className="flex items-center gap-1">
                <MessageCircle className="h-3 w-3" />
                {activity.metadata.replies}
              </span>
            )}
            {activity.metadata.views && (
              <span className="flex items-center gap-1">
                <Eye className="h-3 w-3" />
                {activity.metadata.views}
              </span>
            )}
            {hasMedia && !isBlockchain && <span>媒体</span>}
            {activity.metadata.chain && <span>{activity.metadata.chain}</span>}
            {hasCoHitMarker && (
              <span
                className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-cyan-300"
                title={activity.metadata.coHitUserNames?.join(' / ') || '同交易命中多个关注地址'}
              >
                命中 {coHitUserCount} 人/{coHitAddressCount} 地址
              </span>
            )}
            {txHashShort && (
              <button
                type="button"
                className="ml-auto flex items-center gap-1 rounded px-1 py-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                title="左键复制交易哈希，右键打开区块浏览器"
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
                <Link2 className="h-3 w-3" />
                {txCopied ? '已复制' : txHashShort}
              </button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
