'use client';

import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { isStableOrNativeSymbol } from '@/lib/assetSymbols';
import { formatUsd, formatUsdCompact } from '@/lib/assetFormat';
import { formatCompactMarketCap } from '@/lib/tradeDisplay';
const LIQUIDITY_THRESHOLD_USD = 5_000;
import {
  type UserDetailsSuccessPayload,
  USER_HOLDINGS_THRESHOLD_USD,
} from '@/lib/userDetails';
import { buildGmgnTokenUrl } from '@/lib/addressBook';
import { getUserAvatar } from '@/lib/userProfile';
import type { User } from '@/types';

type HoldingMetric = {
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
};

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

function useHoldingMetricsMap(holdings: { chain: string; tokenAddress: string; symbol: string; liquidityUsd: number | null }[] | undefined) {
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
            { liquidityUsd: holding.liquidityUsd, marketCapUsd: null, priceUsd: null },
          ]),
      );
      const metricTargets = missingHoldings.filter(
        (holding) => holding.chain !== 'robinhood' && !isStableOrNativeSymbol(holding.symbol),
      );

      // Server proxy only — never call api.dexscreener.com from the browser.
      // The batch endpoint keeps a details panel with 40 holdings to one
      // browser request per 40 tokens instead of one request per holding.
      const nextEntries: Record<string, HoldingMetric> = {};
      const byKey = new Map<string, (typeof metricTargets)[number]>(
        metricTargets.map((holding) => [`${holding.chain}:${holding.tokenAddress}`, holding]),
      );
      for (let offset = 0; offset < metricTargets.length; offset += 40) {
        const chunk = metricTargets.slice(offset, offset + 40);
        try {
          const res = await fetch('/api/token-logo/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              items: chunk.map((holding) => ({
                chain: holding.chain,
                tokenAddress: holding.tokenAddress,
                tokenSymbol: holding.symbol,
              })),
            }),
          });
          const payload = await res.json().catch(() => null);
          for (const row of Array.isArray(payload?.results) ? payload.results : []) {
            const key = `${row.chain}:${row.tokenAddress}`;
            const holding = byKey.get(key);
            if (!holding) continue;
            nextEntries[key] = {
              liquidityUsd: holding.liquidityUsd ?? toFiniteNumber(row.liquidityUsd),
              marketCapUsd: toFiniteNumber(row.marketCapUsd),
              priceUsd: toFiniteNumber(row.priceUsd),
            };
          }
        } catch {
          // Fill fallback entries below so one failed chunk does not leave the
          // panel in a permanent loading state.
        }
      }
      for (const holding of metricTargets) {
        const key = `${holding.chain}:${holding.tokenAddress}`;
        if (!(key in nextEntries)) {
          nextEntries[key] = { liquidityUsd: holding.liquidityUsd, marketCapUsd: null, priceUsd: null };
        }
      }

      if (!cancelled) {
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
  details,
  detailsLoading,
  detailsRefreshing,
  detailsError,
  onRetryDetails,
}: SelectedUserDetailsPanelProps) {
  const holdingsThresholdUsd = details?.holdingsThresholdUsd ?? USER_HOLDINGS_THRESHOLD_USD;
  const [holdingsExpanded, setHoldingsExpanded] = useState(false);
  const holdingMetricsMap = useHoldingMetricsMap(details?.holdings);

  // Live re-valuation: balance is authoritative (only moves on trades), the stale
  // part is price. Re-price valueUsd from the batch metric's live DexScreener price
  // when available, else fall back to the snapshot. Never re-pulls the balance —
  // this is what keeps quiet wallets' displayed value fresh at zero API cost.
  const liveValueUsd = (holding: { balance: number; valueUsd: number; chain: string; tokenAddress: string }) => {
    const livePrice = holdingMetricsMap[`${holding.chain}:${holding.tokenAddress}`]?.priceUsd;
    if (typeof livePrice === 'number' && Number.isFinite(livePrice) && livePrice > 0) {
      return holding.balance * livePrice;
    }
    return holding.valueUsd;
  };

  // Filter out dead coins with insufficient liquidity (client-side fallback).
  // Robinhood uses server-side GMGN liquidity only — no DexScreener for that chain.
  // Stablecoins / native gas tokens (USDT/USDC/SOL/BNB/ETH/WETH) are always shown —
  // DexScreener reports no liquidity for them, but they are unambiguously liquid and
  // are counted into totalAssetUsd via the same LIQUID_ASSET_SYMBOLS list.
  const visibleHoldings = (details?.holdings ?? []).filter((holding) => {
    if (isStableOrNativeSymbol(holding.symbol)) {
      return true;
    }
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
    if (isStableOrNativeSymbol(holding.symbol)) {
      return false;
    }
    const key = `${holding.chain}:${holding.tokenAddress}`;
    return !(key in holdingMetricsMap);
  }).length;
  const hasPendingLiquidityLookups = pendingLiquidityHoldingsCount > 0;

  const visibleHoldingsTotalUsd = visibleHoldings.reduce((sum, holding) => sum + liveValueUsd(holding), 0);
  // holdings 明细是从 current_holdings 实时读的，totalAssetUsd 是 tracked_users 缓存的；
  // 缓存可能因 peak reset / refresh 不同步而为 0，此时用 holdings 合计兜底。
  const holdingsTotalUsd = (details?.holdings ?? []).reduce((sum, h) => sum + liveValueUsd(h), 0);
  const totalAssetUsd = (details?.user.totalAssetUsd ?? selectedUser.totalAssetUsd) || holdingsTotalUsd;
  const holdingsAge = getHoldingsAgeState(details?.holdingsUpdatedAt);
  const statusLine = [
    detailsRefreshing ? '正在后台刷新持仓明细...' : null,
    hasPendingLiquidityLookups ? '正在加载流动性数据...' : null,
    details?.holdingsUpdatedAt ? `更新于 ${formatUpdatedAt(details.holdingsUpdatedAt)}` : null,
  ]
    .filter(Boolean)
    .join(' · ') || null;

  const handleCopyCa = useCallback((tokenAddress: string) => {
    navigator.clipboard.writeText(tokenAddress).catch(() => {});
  }, []);

  const openGmgnToken = useCallback((chain: string, tokenAddress: string) => {
    const url = buildGmgnTokenUrl(chain, tokenAddress);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-white/[0.07] bg-zinc-900/40">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-white/[0.05] px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-zinc-500 transition-colors hover:text-zinc-200"
          aria-label="返回全部动态"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>

        <Avatar className="h-7 w-7 shrink-0">
          <AvatarImage src={getUserAvatar(selectedUser)} alt={selectedUser.name} />
          <AvatarFallback className="bg-zinc-800 text-[10px] text-zinc-400">
            {selectedUser.name.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>

        <div className="min-w-0">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <h2 className="truncate text-[13px] font-semibold text-zinc-100">{selectedUser.name}</h2>
            <span className="truncate text-[11px] text-zinc-500">@{selectedUser.handle}</span>
          </div>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] tabular-nums text-zinc-300">
          <span className="font-semibold text-zinc-100">{formatUsdCompact(totalAssetUsd)}</span>
          <span className="text-zinc-600">·</span>
          <span className={holdingsAge.className}>{holdingsAge.label}</span>
        </div>

        {selectedUser.tags.length > 0 ? (
          <div className="ml-auto flex flex-wrap items-center gap-1">
            {selectedUser.tags.map((tag) => (
              <span key={tag} className="rounded bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-500">
                {tag}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <section className="px-3 py-2">
        <div className="mb-1.5 flex items-center justify-between gap-3 text-[11px]">
          <div className="flex items-center gap-2 text-zinc-500">
            <span className="font-medium text-zinc-300">持仓明细</span>
            <span>已隐藏 &lt; {holdingsThresholdUsd} USD</span>
          </div>
          {statusLine ? <div className={`truncate ${detailsRefreshing || hasPendingLiquidityLookups ? 'text-zinc-400' : 'text-zinc-500'}`}>{statusLine}</div> : null}
        </div>

        {detailsLoading && !details ? (
          <div className="rounded border border-white/[0.05] bg-zinc-950/30 px-3 py-2 text-[12px] text-zinc-400">
            正在加载持仓明细...
          </div>
        ) : null}

        {detailsError ? (
          <div
            className={
              details
                ? 'mb-1.5 rounded border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200'
                : 'rounded border border-red-500/20 bg-red-500/10 px-3 py-2 text-[12px] text-red-300'
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <span>{details ? `${detailsError}，当前显示最近一次成功结果` : detailsError}</span>
              <button
                type="button"
                onClick={onRetryDetails}
                className={
                  details
                    ? 'rounded border border-amber-400/40 px-2 py-0.5 text-[11px] text-amber-100 transition-colors hover:border-amber-300 hover:text-white'
                    : 'rounded border border-red-400/40 px-2 py-0.5 text-[11px] text-red-200 transition-colors hover:border-red-300 hover:text-white'
                }
              >
                重试
              </button>
            </div>
          </div>
        ) : null}

        {details && details.holdingsSummary.partial ? (
          <div className="mb-1.5 rounded border border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-[12px] text-amber-200">
            部分地址读取失败，结果可能不完整
          </div>
        ) : null}

        {details && visibleHoldings.length === 0 ? (
          <div className="rounded border border-white/[0.05] bg-zinc-950/30 px-3 py-2 text-[12px] text-zinc-400">
            暂无 &gt;= {holdingsThresholdUsd} USD 的持仓
          </div>
        ) : null}

        {details && visibleHoldings.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-[12.5px] tabular-nums">
              <thead>
                <tr className="text-left text-[11px] text-zinc-500">
                  <th className="py-1 pr-3 font-medium">链</th>
                  <th className="py-1 pr-3 font-medium">Token</th>
                  <th className="py-1 pr-3 font-medium">占比</th>
                  <th className="py-1 pr-3 font-medium">市值</th>
                  <th className="py-1 text-right font-medium">价值</th>
                </tr>
              </thead>
              <tbody>
                {(holdingsExpanded ? visibleHoldings : visibleHoldings.slice(0, 10)).map((holding) => {
                  const rowKey = `${holding.chain}:${holding.tokenAddress}`;
                  const sharePct =
                    visibleHoldingsTotalUsd > 0
                      ? (liveValueUsd(holding) / visibleHoldingsTotalUsd) * 100
                      : 0;
                  const marketCapUsd = holdingMetricsMap[rowKey]?.marketCapUsd;

                  return (
                    <tr
                      key={rowKey}
                      className="border-t border-white/[0.035] text-zinc-300 transition-colors hover:bg-white/[0.025]"
                    >
                      <td className="py-1.5 pr-3 text-zinc-500">
                        {CHAIN_LABELS[holding.chain] ?? holding.chain}
                      </td>
                      <td className="py-1.5 pr-3">
                        <button
                          type="button"
                          className="max-w-[12rem] truncate text-left font-semibold text-zinc-100 transition-colors hover:text-emerald-400"
                          title="左键复制合约地址，右键打开 GMGN"
                          onClick={() => handleCopyCa(holding.tokenAddress)}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            openGmgnToken(holding.chain, holding.tokenAddress);
                          }}
                        >
                          {holding.symbol}
                        </button>
                        {holding.name && holding.name !== holding.symbol ? (
                          <div className="truncate text-[10.5px] text-zinc-600">{holding.name}</div>
                        ) : null}
                      </td>
                      <td className="py-1.5 pr-3">
                        <div className="flex min-w-[4.5rem] items-center gap-1.5">
                          <div className="h-1 w-10 overflow-hidden rounded-full bg-zinc-800">
                            <div
                              className="h-full rounded-full bg-sky-400/70"
                              style={{ width: `${Math.min(sharePct, 100)}%` }}
                            />
                          </div>
                          <span className="text-zinc-400">{sharePct.toFixed(1)}%</span>
                        </div>
                      </td>
                      <td className="py-1.5 pr-3 text-zinc-500">
                        {marketCapUsd != null ? formatCompactMarketCap(marketCapUsd) : '—'}
                      </td>
                      <td className="py-1.5 text-right font-medium text-zinc-100">
                        {formatUsd(liveValueUsd(holding))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visibleHoldings.length > 10 ? (
              <div className="mt-1 text-center">
                <button
                  type="button"
                  onClick={() => setHoldingsExpanded(!holdingsExpanded)}
                  className="text-[11px] text-zinc-500 transition-colors hover:text-zinc-200"
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
