/**
 * Print the person leaderboard in the terminal, in Chinese, from the tables
 * `backfill-wallet-pnl` / the background task already wrote.
 *
 * Usage:
 *   npm run pnl:report                 # top 30 by realized PnL
 *   npm run pnl:report -- --sort=win   # by win rate
 *   npm run pnl:report -- --limit=100 --min-trips=5
 */
import './server-only-shim.cjs';

/** Below this many scored round trips, a win rate is noise, not a signal. */
const DEFAULT_MIN_ROUND_TRIPS = 10;

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

function ratio(value: number | null | undefined, digits = 2) {
  return value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)}x`;
}

function marketCap(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return value.toFixed(0);
}

function holdTime(hours: number | null | undefined) {
  if (hours == null || !Number.isFinite(hours)) return '—';
  if (hours >= 24) return `${(hours / 24).toFixed(1)}天`;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours * 60)}分`;
}

function ago(ts: number | null | undefined) {
  if (!ts) return '—';
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days <= 0) return '今天';
  if (days < 30) return `${days}天前`;
  if (days < 365) return `${Math.floor(days / 30)}个月前`;
  return `${(days / 365).toFixed(1)}年前`;
}

/** Pad accounting for CJK glyphs rendering double-width in a terminal. */
function padDisplay(text: string, width: number) {
  let displayWidth = 0;
  for (const char of text) {
    displayWidth += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(char) ? 2 : 1;
  }
  return text + ' '.repeat(Math.max(1, width - displayWidth));
}

function truncateDisplay(text: string, maxWidth: number) {
  let out = '';
  let width = 0;
  for (const char of text) {
    const charWidth = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(char) ? 2 : 1;
    if (width + charWidth > maxWidth) return out;
    out += char;
    width += charWidth;
  }
  return out;
}

function parseNumberFlag(argv: string[], name: string, fallback: number) {
  const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const parsed = Number(hit.split('=')[1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function run() {
  const argv = process.argv.slice(2);
  const limit = parseNumberFlag(argv, 'limit', 30);
  const minTrips = parseNumberFlag(argv, 'min-trips', DEFAULT_MIN_ROUND_TRIPS);
  // Default is 可跟单性, not PnL: "who made money" and "who can I copy" rank
  // almost inversely here — the top earner enters at 411M MC (untouchable) and
  // the busiest wallet holds for 1.9h (uncopyable).
  const sortFlag = argv.find((arg) => arg.startsWith('--sort='))?.split('=')[1] || 'follow';

  const { readUserPnlRanking } = await import('@/lib/server/walletPnlService');
  const { DEFAULT_PNL_WINDOW, isPnlWindowKey, PNL_WINDOWS } = await import('@/lib/walletPnl');
  const requestedWindow = argv.find((arg) => arg.startsWith('--window='))?.split('=')[1];
  const windowKey = isPnlWindowKey(requestedWindow) ? requestedWindow : DEFAULT_PNL_WINDOW;
  const windowLabel = PNL_WINDOWS.find((w) => w.key === windowKey)?.label ?? windowKey;
  const all = readUserPnlRanking(windowKey);

  if (all.length === 0) {
    console.log('还没有盈亏数据。先运行：npx tsx scripts/backfill-wallet-pnl.ts');
    return;
  }

  const qualified = all.filter((row) => row.roundTrips >= minTrips);
  const insufficient = all.filter((row) => row.roundTrips < minTrips);

  const sorted = [...qualified].sort((a, b) => {
    if (sortFlag === 'win') return (b.winRate ?? -1) - (a.winRate ?? -1);
    if (sortFlag === 'multiple') return (b.medianMultiple ?? -1) - (a.medianMultiple ?? -1);
    if (sortFlag === 'trips') return b.roundTrips - a.roundTrips;
    if (sortFlag === 'pnl') return b.realizedPnlUsd - a.realizedPnlUsd;
    if (sortFlag === 'tokens') return a.distinctTokens - b.distinctTokens;
    if (sortFlag === 'hold') return (b.avgHoldHoursExclSwap ?? -1) - (a.avgHoldHoursExclSwap ?? -1);
    return (b.followabilityScore ?? -1) - (a.followabilityScore ?? -1);
  });

  const computedAt = all[0]?.computedAt || 0;
  const sortLabel =
    {
      follow: '可跟单性',
      win: '胜率',
      multiple: '中位倍数',
      trips: '交易次数',
      pnl: '已实现盈亏',
      tokens: '出手币数（少在前）',
      hold: '持仓时长',
    }[sortFlag] || '可跟单性';

  console.log('');
  console.log(`人物盈亏排行榜 — ${windowLabel} · 按${sortLabel}排序`);
  console.log(`统计口径：仅「已平仓且历史完整」的交易轮次；样本 <${minTrips} 次的人物另列在下方。`);
  console.log(`数据计算于 ${computedAt ? new Date(computedAt).toLocaleString('zh-CN') : '未知'}`);
  console.log('');

  const header =
    padDisplay('人物', 16) +
    padDisplay('跟单分', 8) +
    padDisplay('币数', 6) +
    padDisplay('持仓', 9) +
    padDisplay('单笔建仓', 10) +
    padDisplay('大买胜率', 10) +
    padDisplay('胜率', 7) +
    padDisplay('次数', 6) +
    padDisplay('已实现', 11) +
    padDisplay('可信度', 8) +
    '最近交易';
  console.log(header);
  console.log('─'.repeat(100));

  for (const row of sorted.slice(0, limit)) {
    console.log(
      padDisplay(truncateDisplay(row.name || row.userId, 14), 16) +
        padDisplay(row.followabilityScore != null ? (row.followabilityScore * 100).toFixed(0) : '—', 8) +
        padDisplay(String(row.distinctTokens), 6) +
        padDisplay(holdTime(row.avgHoldHoursExclSwap), 9) +
        padDisplay(money(row.medianMaxSingleBuyUsd), 10) +
        padDisplay(
          row.bigBuyWinRate != null ? `${percent(row.bigBuyWinRate)}(${row.bigBuyRoundTrips})` : '—',
          10
        ) +
        padDisplay(percent(row.winRate), 7) +
        padDisplay(String(row.roundTrips), 6) +
        padDisplay(money(row.realizedPnlUsd), 11) +
        padDisplay(percent(row.coverageRatio), 8) +
        ago(row.lastTradeAt)
    );
  }

  console.log('');
  console.log(
    `共 ${all.length} 人有交易记录，其中 ${qualified.length} 人样本足够（≥${minTrips} 次已平仓轮次）。`
  );

  if (insufficient.length > 0) {
    console.log('');
    console.log(`样本不足（<${minTrips} 次），不参与排名：`);
    const preview = insufficient
      .sort((a, b) => b.roundTrips - a.roundTrips)
      .slice(0, 15)
      .map((row) => `${row.name || row.userId}(${row.roundTrips})`)
      .join('、');
    console.log(`  ${preview}${insufficient.length > 15 ? ` …等 ${insufficient.length} 人` : ''}`);
  }

  console.log('');
  console.log('说明：');
  console.log('  跟单分 = 出手币数(30%) + 持仓时长(25%) + 胜率(25%) + 入场市值(20%)，各维度取同批人里的分位。');
  console.log('           口径来自 LLMwiki「如何评价一个链上个体」：币数越少、持仓越久、入场市值越高、胜率越高 → 越值得跟。');
  console.log('  单笔建仓 = 每轮「最大的那一笔买入」的中位数。不用总买入——反复波段会把总额堆得很大，');
  console.log('             而那恰恰是亏钱的一档（rop 波段轮次平均买入最高、胜率最低、净亏）。');
  console.log('  大买胜率 = 这个人自己单笔建仓排前 1/3 的那些轮次的胜率，括号内是样本数。');
  console.log('             跟他自己比，不跟别人比，所以对大户小户都成立。');
  console.log('  币数   = 出手过的不同代币数，不受拆单影响（大买常被拆成十几笔小单）。');
  console.log('  持仓   = 平均持仓时长，已剔除「同笔 tx 换仓」结束的轮次——满仓换仓不等于短持有。');
  console.log('  可信度 = 已平仓·历史完整·非转账退出的轮次 / 全部轮次。');
  console.log('             「转账退出」= 仓位归零但卖出份额远小于买入 —— 币被转去交易所/别的钱包了，');
  console.log('             GMGN 只记 buy/sell 看不到转账，算作亏损是错的，所以这类轮次不计入胜率。');
  console.log('');
  console.log('  其它排序：--sort=pnl | win | tokens | hold | multiple | trips');
  console.log('  时间窗：  --window=90d | 365d | all（默认 90d——人的风格会变，全时段会把不同阶段糊在一起）');
  console.log('');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
