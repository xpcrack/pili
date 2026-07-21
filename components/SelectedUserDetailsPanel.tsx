'use client';

import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { formatUsd, formatUsdCompact } from '@/lib/assetFormat';
import { formatCompactMarketCap } from '@/lib/tradeDisplay';
const LIQUIDITY_THRESHOLD_USD = 5_000;
import {
  type UserDetailsSuccessPayload,
  USER_HOLDINGS_THRESHOLD_USD,
} from '@/lib/userDetails';
import { getUserAvatar } from '@/lib/userProfile';
import type { User } from '@/types';

type HoldingMetric = {
  liquidityUsd: number | null;
  marketCapUsd: number | null;
};

function chunkItems<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function toFiniteNumber(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function selectDexScreenerPair(
  pairs: unknown[],
  chain: string,
  tokenAddress: string,
) {
  const normalizedChain = chain.toLowerCase();
  const normalizedTokenAddress = tokenAddress.toLowerCase();

  return pairs
    .filter((pair): pair is {
      chainId?: string;
      baseToken?: { address?: string };
      liquidity?: { usd?: unknown };
      marketCap?: unknown;
      fdv?: unknown;
    } => typeof pair === 'object' && pair !== null)
    .filter((pair) => {
      const pairChain = pair.chainId?.toLowerCase();
      const baseTokenAddress = pair.baseToken?.address?.toLowerCase();
      return pairChain === normalizedChain && baseTokenAddress === normalizedTokenAddress;
    })
    .sort((left, right) => {
      const rightLiquidity = toFiniteNumber(right.liquidity?.usd) ?? -1;
      const leftLiquidity = toFiniteNumber(left.liquidity?.usd) ?? -1;
      return rightLiquidity - leftLiquidity;
    })[0] ?? null;
}

function useHoldingMetricsMap(holdings: { chain: string; tokenAddress: string; liquidityUsd: number | null }[] | undefined) {
  const [map, setMap] = useState<Record<string, HoldingMetric>>({});

  useEffect(() => {
    if (!holdings || holdings.length === 0) return;

    const missingHoldings = holdings.filter((holding) => {
      const key = `${holding.chain}:${holding.tokenAddress}`;
      return !(key in map);
    });
    if (missingHoldings.length === 0) return;

    let cancelled = false;

    (async () => {
      // Robinhood has no DexScreener / token-logo market data yet — seed null metrics and skip network.
      const robinhoodEntries = Object.fromEntries(
        missingHoldings
          .filter((holding) => holding.chain === 'robinhood')
          .map((holding) => [
            `${holding.chain}:${holding.tokenAddress}`,
            { liquidityUsd: holding.liquidityUsd, marketCapUsd: null },
          ]),
      );
      const metricTargets = missingHoldings.filter((holding) => holding.chain !== 'robinhood');

      const tokenLogoMarketCapMap: Record<string, number | null> = {};
      await Promise.all(
        metricTargets.map(async (holding) => {
          const key = `${holding.chain}:${holding.tokenAddress}`;
          try {
            const res = await fetch(`/api/token-logo?chain=${encodeURIComponent(holding.chain)}&tokenAddress=${encodeURIComponent(holding.tokenAddress)}`);
            const data = await res.json();
            tokenLogoMarketCapMap[key] = toFiniteNumber(data?.marketCapUsd);
          } catch {
            tokenLogoMarketCapMap[key] = null;
          }
        }),
      );

      const dexTargets = metricTargets.filter((holding) => {
        const key = `${holding.chain}:${holding.tokenAddress}`;
        return holding.liquidityUsd == null || tokenLogoMarketCapMap[key] == null;
      });

      const dexMetricsMap: Record<string, HoldingMetric> = {};
      await Promise.all(
        chunkItems(dexTargets, 30).map(async (batch) => {
          if (batch.length === 0) return;
          try {
            const addresses = batch.map((holding) => holding.tokenAddress).join(',');
            const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addresses}`);
            const data = await res.json();
            const pairs = Array.isArray(data?.pairs) ? data.pairs : [];

            for (const holding of batch) {
              const key = `${holding.chain}:${holding.tokenAddress}`;
              const pair = selectDexScreenerPair(pairs, holding.chain, holding.tokenAddress);
              dexMetricsMap[key] = {
                liquidityUsd: toFiniteNumber(pair?.liquidity?.usd),
                marketCapUsd: toFiniteNumber(pair?.marketCap) ?? toFiniteNumber(pair?.fdv),
              };
            }
          } catch {
            for (const holding of batch) {
              const key = `${holding.chain}:${holding.tokenAddress}`;
              dexMetricsMap[key] = {
                liquidityUsd: null,
                marketCapUsd: null,
              };
            }
          }
        }),
      );

      if (!cancelled) {
        const nextEntries = Object.fromEntries(
          metricTargets.map((holding) => {
            const key = `${holding.chain}:${holding.tokenAddress}`;
            const dexMetrics = dexMetricsMap[key];
            return [
              key,
              {
                liquidityUsd: dexMetrics?.liquidityUsd ?? null,
                marketCapUsd: tokenLogoMarketCapMap[key] ?? dexMetrics?.marketCapUsd ?? null,
              },
            ] as const;
          }),
        );
        setMap((prev) => ({ ...prev, ...robinhoodEntries, ...nextEntries }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [holdings, map]);

  return map;
}

export interface SelectedUserDetailsPanelProps {
  selectedUser: User;
  onBack: () => void;
  matchedFeedCount: number;
  hasMore: boolean;
  activityBreakdown: {
    twitterCount: number;
    tradeCount: number;
  } | null;
  details: UserDetailsSuccessPayload | null;
  detailsLoading: boolean;
  detailsRefreshing: boolean;
  detailsError: string | null;
  onRetryDetails: () => void;
}

const CHAIN_LABELS: Record<string, string> = {
  bsc: 'BSC',
  solana: 'Solana',
  ethereum: 'Ethereum',
  base: 'Base',
  robinhood: 'Robinhood',
};

function formatUpdatedAt(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN');
}

function getHoldingsAgeState(updatedAt: number | null | undefined) {
  if (updatedAt == null || !Number.isFinite(updatedAt) || updatedAt <= 0) {
    return {
      level: 'unknown' as const,
      label: '持仓从未刷新',
      className: 'text-amber-300',
    };
  }

  const ageMin = (Date.now() - updatedAt) / 60_000;
  if (ageMin > 60) {
    return {
      level: 'stale' as const,
      label: `持仓 ${Math.floor(ageMin)} 分钟前 · 可能过时`,
      className: 'text-red-300',
    };
  }
  if (ageMin > 15) {
    return {
      level: 'aging' as const,
      label: `持仓 ${Math.floor(ageMin)} 分钟前`,
      className: 'text-amber-300',
    };
  }
  if (ageMin < 1) {
    return {
      level: 'fresh' as const,
      label: '持仓刚刚更新',
      className: 'text-emerald-300/90',
    };
  }
  return {
    level: 'fresh' as const,
    label: `持仓 ${Math.floor(ageMin)} 分钟前`,
    className: 'text-zinc-400',
  };
}

export function SelectedUserDetailsPanel({
  selectedUser,
  onBack,
  matchedFeedCount,
  hasMore,
  activityBreakdown,
  details,
  detailsLoading,
  detailsRefreshing,
  detailsError,
  onRetryDetails,
}: SelectedUserDetailsPanelProps) {
  const holdingsThresholdUsd = details?.holdingsThresholdUsd ?? USER_HOLDINGS_THRESHOLD_USD;
  const [holdingsExpanded, setHoldingsExpanded] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const holdingMetricsMap = useHoldingMetricsMap(details?.holdings);

  // Filter out dead coins with insufficient liquidity (client-side fallback).
  // Robinhood uses server-side GMGN liquidity only — no DexScreener for that chain.
  const visibleHoldings = (details?.holdings ?? []).filter((holding) => {
    if (holding.chain === 'robinhood') {
      return holding.liquidityUsd == null || holding.liquidityUsd >= LIQUIDITY_THRESHOLD_USD;
    }
    if (holding.liquidityUsd != null) {
      return holding.liquidityUsd >= LIQUIDITY_THRESHOLD_USD;
    }

    const key = `${holding.chain}:${holding.tokenAddress}`;
    if (!(key in holdingMetricsMap)) {
      return false;
    }

    const fallbackLiquidityUsd = holdingMetricsMap[key]?.liquidityUsd;
    return fallbackLiquidityUsd != null && fallbackLiquidityUsd >= LIQUIDITY_THRESHOLD_USD;
  });

  const pendingLiquidityHoldingsCount = (details?.holdings ?? []).filter((holding) => {
    if (holding.chain === 'robinhood' || holding.liquidityUsd != null) {
      return false;
    }
    const key = `${holding.chain}:${holding.tokenAddress}`;
    return !(key in holdingMetricsMap);
  }).length;
  const hasPendingLiquidityLookups = pendingLiquidityHoldingsCount > 0;

  const visibleHoldingsTotalUsd = visibleHoldings.reduce((sum, holding) => sum + holding.valueUsd, 0);
  const totalAssetUsd = details?.user.totalAssetUsd ?? selectedUser.totalAssetUsd;
  const historicalMaxAssetUsd = details?.user.historicalMaxAssetUsd ?? selectedUser.historicalMaxAssetUsd;
  const holdingsAge = getHoldingsAgeState(details?.holdingsUpdatedAt);

  const handleCopyCa = useCallback((tokenAddress: string, key: string) => {
    navigator.clipboard.writeText(tokenAddress).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    });
  }, []);

  return (
    <div className="mb-6 space-y-4">
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-zinc-800/50 bg-zinc-900/50 p-4">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 text-zinc-400 transition-colors hover:text-zinc-200"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="text-sm">返回</span>
        </button>

        <div className="hidden h-6 w-px bg-zinc-800 sm:block" />

        <Avatar className="h-10 w-10">
          <AvatarImage src={getUserAvatar(selectedUser)} alt={selectedUser.name} />
          <AvatarFallback className="bg-zinc-800 text-zinc-400">
            {selectedUser.name.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>

        <div>
          <h2 className="font-medium text-zinc-100">{selectedUser.name}</h2>
          <p className="text-sm text-zinc-500">@{selectedUser.handle}</p>
        </div>

        <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-1.5 text-xs text-zinc-300">
          <div className="text-zinc-500">总资产</div>
          <div className="text-sm font-medium text-zinc-100">{formatUsdCompact(totalAssetUsd)}</div>
          <div className={`mt-0.5 text-[11px] ${holdingsAge.className}`}>{holdingsAge.label}</div>
        </div>

        <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-1.5 text-xs text-zinc-300">
          <div className="text-zinc-500">历史最高</div>
          <div className="text-sm font-medium text-zinc-100">
            {formatUsdCompact(historicalMaxAssetUsd)}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-1.5 text-xs text-zinc-300">
          <div className="text-zinc-500">已加载结果</div>
          <div className="text-sm font-medium text-zinc-100">
            {matchedFeedCount}
            <span className="ml-2 text-xs text-zinc-500">{hasMore ? '可继续加载' : '已显示全部'}</span>
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-1.5 text-xs text-zinc-300">
          <div className="text-zinc-500">动态拆分</div>
          <div className="text-sm font-medium text-zinc-100">
            推特 {activityBreakdown?.twitterCount ?? 0} 条 / 交易 {activityBreakdown?.tradeCount ?? 0} 笔
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {selectedUser.tags.map((tag) => (
            <span key={tag} className="rounded bg-zinc-800/50 px-2 py-0.5 text-xs text-zinc-400">
              {tag}
            </span>
          ))}
        </div>
      </div>

      <section className="rounded-xl border border-zinc-800/50 bg-zinc-900/50 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="text-sm font-medium text-zinc-100">持仓明细</h3>
            <p className="mt-1 text-xs text-zinc-500">已隐藏 &lt; {holdingsThresholdUsd} USD 持仓</p>
          </div>
          <div className="space-y-1 text-xs text-zinc-500 sm:text-right">
            <div className={holdingsAge.className}>{holdingsAge.label}</div>
            {details?.holdingsUpdatedAt ? <div>更新于 {formatUpdatedAt(details.holdingsUpdatedAt)}</div> : null}
            {detailsRefreshing ? <div className="text-zinc-400">正在后台刷新持仓明细...</div> : null}
            {hasPendingLiquidityLookups ? <div className="text-zinc-400">正在加载流动性数据...</div> : null}
          </div>
        </div>

        {detailsLoading && !details ? (
          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-400">
            正在加载持仓明细...
          </div>
        ) : null}

        {detailsError ? (
          <div
            className={
              details
                ? 'mt-4 rounded-lg border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-200'
                : 'mt-4 rounded-lg border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-300'
            }
          >
            <div>{details ? `${detailsError}，当前显示最近一次成功结果` : detailsError}</div>
            <button
              type="button"
              onClick={onRetryDetails}
              className={
                details
                  ? 'mt-3 rounded border border-amber-400/40 px-3 py-1.5 text-xs text-amber-100 transition-colors hover:border-amber-300 hover:text-white'
                  : 'mt-3 rounded border border-red-400/40 px-3 py-1.5 text-xs text-red-200 transition-colors hover:border-red-300 hover:text-white'
              }
            >
              重试
            </button>
          </div>
        ) : null}

        {details && details.holdingsSummary.partial ? (
          <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-200">
            部分地址读取失败，结果可能不完整
          </div>
        ) : null}

        {details && visibleHoldings.length === 0 ? (
          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-400">
            暂无 &gt;= {holdingsThresholdUsd} USD 的持仓
          </div>
        ) : null}

        {details && visibleHoldings.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-zinc-800 text-sm">
              <thead>
                <tr className="text-left text-zinc-500">
                  <th className="py-2 pr-4 font-medium">链</th>
                  <th className="py-2 pr-4 font-medium">Token</th>
                  <th className="py-2 pr-4 font-medium">占比</th>
                  <th className="py-2 pr-4 font-medium">市值</th>
                  <th className="py-2 font-medium">价值</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {(holdingsExpanded ? visibleHoldings : visibleHoldings.slice(0, 10)).map((holding) => (
                  <tr key={`${holding.chain}:${holding.tokenAddress}`} className="align-top text-zinc-200">
                    <td className="py-3 pr-4">{CHAIN_LABELS[holding.chain] ?? holding.chain}</td>
                    <td className="py-3 pr-4">
                      <div
                        className="cursor-pointer font-medium text-zinc-100 transition-colors hover:text-emerald-400"
                        title="点击复制合约地址"
                        onClick={() => handleCopyCa(holding.tokenAddress, `${holding.chain}:${holding.tokenAddress}`)}
                        onKeyDown={(e) => e.key === 'Enter' && handleCopyCa(holding.tokenAddress, `${holding.chain}:${holding.tokenAddress}`)}
                        role="button"
                        tabIndex={0}
                      >
                        {holding.symbol}
                        {copiedKey === `${holding.chain}:${holding.tokenAddress}` ? (
                          <span className="ml-1 text-xs text-emerald-400">已复制</span>
                        ) : null}
                      </div>
                      {holding.name ? <div className="text-xs text-zinc-500">{holding.name}</div> : null}
                    </td>
                    <td className="py-3 pr-4">
                      {visibleHoldingsTotalUsd > 0
                        ? `${((holding.valueUsd / visibleHoldingsTotalUsd) * 100).toFixed(1)}%`
                        : '-'}
                    </td>
                    <td className="py-3 pr-4">
                      {(() => {
                        const mcKey = `${holding.chain}:${holding.tokenAddress}`;
                        const marketCapUsd = holdingMetricsMap[mcKey]?.marketCapUsd;
                        return marketCapUsd != null ? formatCompactMarketCap(marketCapUsd) : '-';
                      })()}
                    </td>
                    <td className="py-3 font-medium text-zinc-100">{formatUsd(holding.valueUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visibleHoldings.length > 10 ? (
              <div className="mt-2 text-center">
                <button
                  type="button"
                  onClick={() => setHoldingsExpanded(!holdingsExpanded)}
                  className="text-xs text-zinc-400 transition-colors hover:text-zinc-200"
                >
                   {holdingsExpanded ? '收起' : `展开全部 (${visibleHoldings.length})`}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
