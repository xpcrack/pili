'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Info } from 'lucide-react';

import { TopNav } from '@/components/TopNav';
import { formatRelativeTimeCompact } from '@/lib/timeFormat';
import { DEFAULT_PNL_WINDOW, PNL_WINDOWS, type PnlWindowKey, type UserPnlRankingRow } from '@/lib/walletPnl';

export const RANKING_PAGE_FETCH_URL = '/api/ranking';

/** Below this many scored round trips a win rate is noise, so the row is greyed out. */
const MIN_ROUND_TRIPS = 10;
/** Coverage below this means most of the person's history predates our data. */
const LOW_COVERAGE_THRESHOLD = 0.3;

type SortKey =
  | 'followabilityScore'
  | 'distinctTokens'
  | 'avgHoldHoursExclSwap'
  | 'medianMaxSingleBuyUsd'
  | 'bigBuyWinRate'
  | 'winRate'
  | 'roundTrips'
  | 'selectorScore'
  | 'realizedPnlUsd'
  | 'medianMultiple'
  | 'lastTradeAt';

/** 出手币数 sorts ascending — fewer tokens is the better signal. */
const ASCENDING_KEYS = new Set<SortKey>(['distinctTokens']);

interface RankingPayload {
  ok: boolean;
  rows?: UserPnlRankingRow[];
  computedAt?: number | null;
  windowKey?: PnlWindowKey;
  error?: string;
}

function money(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function percent(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(0)}%`;
}

function multiple(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(2)}x`;
}

function marketCap(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return value.toFixed(0);
}

function pnlColor(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value === 0) return 'text-zinc-400';
  return value > 0 ? 'text-emerald-400' : 'text-red-400';
}

const COLUMNS: Array<{ key: SortKey | null; label: string; align: 'left' | 'right'; hint?: string }> = [
  { key: null, label: '人物', align: 'left' },
  {
    key: 'followabilityScore',
    label: '跟单分',
    align: 'right',
    hint: '出手币数30% + 持仓时长25% + 胜率25% + 入场市值20%，各维度取同批人里的分位',
  },
  { key: 'distinctTokens', label: '币数', align: 'right', hint: '出手过的不同代币数，越少越集中。不受大单拆单影响' },
  {
    key: 'avgHoldHoursExclSwap',
    label: '持仓',
    align: 'right',
    hint: '平均持仓时长，已剔除同笔 tx 换仓结束的轮次——满仓换仓不等于短持有',
  },
  {
    key: 'medianMaxSingleBuyUsd',
    label: '单笔建仓',
    align: 'right',
    hint: '每轮最大单笔买入的中位数。不用总买入——反复波段会把总额堆大，而那恰恰是亏钱的一档',
  },
  {
    key: 'bigBuyWinRate',
    label: '大买胜率',
    align: 'right',
    hint: '这个人自己单笔建仓排前 1/3 的轮次胜率，括号内为样本数。跟他自己比，对大户小户都成立',
  },
  { key: 'winRate', label: '胜率', align: 'right', hint: '盈利轮次 / 已平仓且历史完整的轮次' },
  { key: 'roundTrips', label: '次数', align: 'right', hint: '计入胜率的完整交易轮次数量' },
  {
    key: 'selectorScore',
    label: '二段选币',
    align: 'right',
    hint: '入场市值在 200k–1M 的轮次，其 exit/entry 倍率的中位数；括号内为命中率（该市值段轮次占比）',
  },
  { key: 'realizedPnlUsd', label: '已实现', align: 'right', hint: '所有已卖出部分的真实盈亏' },
  { key: null, label: '未实现', align: 'right', hint: '当前持仓的浮动盈亏，依赖持仓刷新时效' },
  { key: null, label: '可信度', align: 'right', hint: '历史完整的轮次占比，偏低说明只看到了这个人的后半段交易' },
  { key: 'lastTradeAt', label: '最近交易', align: 'right' },
];

function holdTime(hours: number | null | undefined) {
  if (hours == null || !Number.isFinite(hours)) return '—';
  if (hours >= 24) return `${(hours / 24).toFixed(1)}天`;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours * 60)}分`;
}

export default function RankingPage() {
  const [rows, setRows] = useState<UserPnlRankingRow[]>([]);
  const [computedAt, setComputedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Default is 可跟单性, not PnL — see the note in report-wallet-pnl.ts.
  const [sortKey, setSortKey] = useState<SortKey>('followabilityScore');
  // 90d by default: a person's style changes, and an all-time aggregate answers
  // "who were they" when the question is "who are they now".
  const [windowKey, setWindowKey] = useState<PnlWindowKey>(DEFAULT_PNL_WINDOW);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`${RANKING_PAGE_FETCH_URL}?window=${windowKey}`, { cache: 'no-store' });
        const payload = (await response.json().catch(() => null)) as RankingPayload | null;
        if (!response.ok || !payload?.ok || !Array.isArray(payload.rows)) {
          throw new Error(payload?.error || `HTTP ${response.status}`);
        }
        if (cancelled) return;
        setRows(payload.rows);
        setComputedAt(payload.computedAt ?? null);
        if (payload.windowKey && payload.windowKey !== windowKey) {
          setWindowKey(payload.windowKey);
        }
      } catch (nextError) {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError.message : '读取盈亏排行榜失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [windowKey]);

  const { ranked, insufficient } = useMemo(() => {
    const qualified = rows.filter((row) => row.roundTrips >= MIN_ROUND_TRIPS);
    const rest = rows
      .filter((row) => row.roundTrips < MIN_ROUND_TRIPS)
      .sort((a, b) => b.roundTrips - a.roundTrips);

    const ascending = ASCENDING_KEYS.has(sortKey);
    const sorted = [...qualified].sort((a, b) => {
      const left = a[sortKey];
      const right = b[sortKey];
      // Missing values always sink, whichever direction we are sorting.
      const leftValue = typeof left === 'number' && Number.isFinite(left) ? left : ascending ? Infinity : -Infinity;
      const rightValue = typeof right === 'number' && Number.isFinite(right) ? right : ascending ? Infinity : -Infinity;
      return ascending ? leftValue - rightValue : rightValue - leftValue;
    });

    return { ranked: sorted, insufficient: rest };
  }, [rows, sortKey]);

  return (
    <div className="min-h-screen bg-zinc-950">
      <TopNav active="ranking" />

      <main className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8">
        <section>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold text-zinc-100">人物盈亏排行榜</h2>
            <div className="flex items-center gap-1.5 text-xs">
              {PNL_WINDOWS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setWindowKey(option.key)}
                  className={`rounded-md px-2.5 py-1 transition-colors ${
                    windowKey === option.key
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : 'bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-1 text-sm text-zinc-500">
            统计口径：仅「已平仓且历史完整」的交易轮次。稳定币与原生币的 swap 报价腿已排除，同笔 tx 换仓不计入持仓时长。
            {computedAt ? ` 数据计算于 ${new Date(computedAt).toLocaleString('zh-CN')}。` : ''}
          </p>
        </section>

        {error ? (
          <section className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </section>
        ) : null}

        {loading ? (
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-8 text-center text-sm text-zinc-500">
            正在读取…
          </section>
        ) : null}

        {!loading && !error && rows.length === 0 ? (
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-8 text-center text-sm text-zinc-500">
            还没有盈亏数据。后台任务每 30 分钟计算一次，也可以手动跑 <code className="text-zinc-300">npm run pnl:backfill</code>。
          </section>
        ) : null}

        {ranked.length > 0 ? (
          <section className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/40">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-xs text-zinc-500">
                  {COLUMNS.map((column) => (
                    <th
                      key={column.label}
                      title={column.hint}
                      className={`px-3 py-2.5 font-medium ${column.align === 'right' ? 'text-right' : 'text-left'} ${
                        column.key ? 'cursor-pointer select-none hover:text-zinc-200' : ''
                      }`}
                      onClick={column.key ? () => setSortKey(column.key as SortKey) : undefined}
                    >
                      <span className="inline-flex items-center gap-1">
                        {column.label}
                        {column.hint ? <Info className="h-3 w-3 opacity-40" /> : null}
                        {column.key && sortKey === column.key ? <ArrowDown className="h-3 w-3" /> : null}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ranked.map((row, index) => {
                  const lowCoverage = row.coverageRatio != null && row.coverageRatio < LOW_COVERAGE_THRESHOLD;
                  return (
                    <tr key={row.userId} className="border-b border-zinc-800/50 last:border-0 hover:bg-zinc-800/30">
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="w-6 shrink-0 text-xs tabular-nums text-zinc-600">{index + 1}</span>
                          <span className="truncate text-zinc-100">{row.name || row.userId}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-medium text-emerald-300">
                        {row.followabilityScore != null ? (row.followabilityScore * 100).toFixed(0) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-zinc-300">{row.distinctTokens}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-zinc-300">
                        {holdTime(row.avgHoldHoursExclSwap)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-zinc-300">
                        {money(row.medianMaxSingleBuyUsd)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-zinc-200">
                        {row.bigBuyWinRate != null
                          ? `${percent(row.bigBuyWinRate)} (${row.bigBuyRoundTrips})`
                          : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-zinc-200">{percent(row.winRate)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-zinc-400">{row.roundTrips}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-zinc-300">
                        {row.selectorScore != null
                          ? `${row.selectorScore.toFixed(1)}x (${percent(row.selectorHitRate)})`
                          : '—'}
                      </td>
                      <td className={`px-3 py-2.5 text-right tabular-nums ${pnlColor(row.realizedPnlUsd)}`}>
                        {money(row.realizedPnlUsd)}
                      </td>
                      <td className={`px-3 py-2.5 text-right tabular-nums ${pnlColor(row.unrealizedPnlUsd)}`}>
                        {money(row.unrealizedPnlUsd)}
                      </td>
                      <td
                        className={`px-3 py-2.5 text-right tabular-nums ${lowCoverage ? 'text-amber-400' : 'text-zinc-400'}`}
                        title={lowCoverage ? '这个人大部分交易发生在 pili 建库之前，胜率参考价值有限' : undefined}
                      >
                        {percent(row.coverageRatio)}
                      </td>
                      <td className="px-3 py-2.5 text-right text-zinc-500">
                        {row.lastTradeAt ? formatRelativeTimeCompact(row.lastTradeAt) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ) : null}

        {insufficient.length > 0 ? (
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/20 px-4 py-3">
            <p className="text-xs text-zinc-500">
              样本不足（&lt;{MIN_ROUND_TRIPS} 次已平仓轮次），不参与排名 —— 1 战 1 胜不是 100% 胜率：
            </p>
            <p className="mt-1.5 text-xs text-zinc-600">
              {insufficient.map((row) => `${row.name || row.userId}(${row.roundTrips})`).join('、')}
            </p>
          </section>
        ) : null}

        {rows.length > 0 ? (
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/20 px-4 py-3 text-xs leading-relaxed text-zinc-500">
            <p>
              <span className="text-zinc-400">跟单分</span> 回答的是「这个人值不值得跟」，不是「谁赚得最多」——这两件事在数据里
              几乎是反的：赚最多的人平均入场市值 411M（跟不了），交易最频繁的人平均持仓 1.9 小时（跟不上）。
              口径按你在 wiki 里定的：币数越少、持仓越久、入场市值越高、胜率越高 → 越值得跟。
            </p>
            <p className="mt-1">
              <span className="text-zinc-400">可信度</span> = 已平仓·历史完整·非转账退出的轮次 / 全部轮次。偏低（标黄）说明
              这个人的早期交易在 pili 建库前就发生了。「转账退出」指仓位归零但卖出份额远小于买入——币被转去交易所或别的钱包，
              GMGN 只记 buy/sell 看不到转账，算作亏损是错的，所以这类轮次不计入胜率。
            </p>
            <p className="mt-1">
              <span className="text-zinc-400">未实现盈亏</span> 依赖持仓刷新（约 30 分钟一轮），只有能取到当前价的持仓才会计入，
              显示「—」表示暂时算不出，不代表没有持仓。
            </p>
            <p className="mt-1">
              共 {rows.length} 人有交易记录，其中 {ranked.length} 人样本足够。点击表头可切换排序。
            </p>
          </section>
        ) : null}
      </main>
    </div>
  );
}
