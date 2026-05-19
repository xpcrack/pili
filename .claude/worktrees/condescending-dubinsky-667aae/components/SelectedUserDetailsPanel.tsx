'use client';

import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { formatUsd, formatUsdCompact } from '@/lib/assetFormat';
import {
  type UserDetailsSuccessPayload,
  USER_HOLDINGS_THRESHOLD_USD,
} from '@/lib/userDetails';
import { getUserAvatar } from '@/lib/userProfile';
import type { User } from '@/types';

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
};

function formatUpdatedAt(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN');
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
  const holdingsTotalUsd = details?.holdings.reduce((sum, h) => sum + h.valueUsd, 0) ?? 0;
  const totalAssetUsd = holdingsTotalUsd > 0 ? holdingsTotalUsd : selectedUser.totalAssetUsd;

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
        </div>

        <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-1.5 text-xs text-zinc-300">
          <div className="text-zinc-500">历史最高</div>
          <div className="text-sm font-medium text-zinc-100">
            {formatUsdCompact(selectedUser.historicalMaxAssetUsd)}
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
            {details?.holdingsUpdatedAt ? <div>更新于 {formatUpdatedAt(details.holdingsUpdatedAt)}</div> : null}
            {detailsRefreshing ? <div className="text-zinc-400">正在后台刷新持仓明细...</div> : null}
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

        {details && details.holdings.length === 0 ? (
          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-400">
            暂无 &gt;= {holdingsThresholdUsd} USD 的持仓
          </div>
        ) : null}

        {details && details.holdings.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-zinc-800 text-sm">
              <thead>
                <tr className="text-left text-zinc-500">
                  <th className="py-2 pr-4 font-medium">链</th>
                  <th className="py-2 pr-4 font-medium">Token</th>
                  <th className="py-2 pr-4 font-medium">占比</th>
                  <th className="py-2 pr-4 font-medium">单价</th>
                  <th className="py-2 font-medium">价值</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {(holdingsExpanded ? details.holdings : details.holdings.slice(0, 10)).map((holding) => (
                  <tr key={`${holding.chain}:${holding.tokenAddress}`} className="align-top text-zinc-200">
                    <td className="py-3 pr-4">{CHAIN_LABELS[holding.chain] ?? holding.chain}</td>
                    <td className="py-3 pr-4">
                      <div className="font-medium text-zinc-100">{holding.symbol}</div>
                      {holding.name ? <div className="text-xs text-zinc-500">{holding.name}</div> : null}
                    </td>
                    <td className="py-3 pr-4">
                      {totalAssetUsd > 0
                        ? `${((holding.valueUsd / totalAssetUsd) * 100).toFixed(1)}%`
                        : '-'}
                    </td>
                    <td className="py-3 pr-4">{formatUsd(holding.priceUsd)}</td>
                    <td className="py-3 font-medium text-zinc-100">{formatUsd(holding.valueUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {details.holdings.length > 10 ? (
              <div className="mt-2 text-center">
                <button
                  type="button"
                  onClick={() => setHoldingsExpanded(!holdingsExpanded)}
                  className="text-xs text-zinc-400 transition-colors hover:text-zinc-200"
                >
                  {holdingsExpanded ? '收起' : `展开全部 (${details.holdings.length})`}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
