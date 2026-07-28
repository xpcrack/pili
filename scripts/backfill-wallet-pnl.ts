/**
 * One-shot full recompute of wallet_token_pnl + user_pnl_stats.
 *
 * The runtime task in pili-background-worker does the same thing on a 30min
 * cycle; this script exists for the first run and for manual re-runs after a
 * data repair.
 *
 * Usage:
 *   npx tsx scripts/backfill-wallet-pnl.ts           # compute + write
 *   npx tsx scripts/backfill-wallet-pnl.ts --dry     # compute only, no writes
 */
import './server-only-shim.cjs';

import { exitIfProdDbHeavyJobBlocked } from './lib/prodDbGuard';

async function run() {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry');

  if (!dry) {
    exitIfProdDbHeavyJobBlocked({ argv, jobName: 'wallet PnL backfill' });
  }

  const { runWalletPnlFill } = await import('@/lib/server/walletPnlService');

  console.log(dry ? '正在计算盈亏（试运行，不写库）…' : '正在计算盈亏并写入…');
  const result = runWalletPnlFill({ dry });

  console.log('');
  console.log(`扫描交易行      ${result.scannedRows.toLocaleString()}`);
  console.log(`持仓序列        ${result.series.toLocaleString()}`);
  console.log(`交易轮次        ${result.roundTrips.toLocaleString()}`);
  console.log(`  已平仓·可信   ${result.closedComplete.toLocaleString()}   ← 胜率样本`);
  console.log(`  已平仓·不完整 ${result.closedPartial.toLocaleString()}   ← 建库前已有仓位，不计入胜率`);
  console.log(`  仍持仓中      ${result.openPositions.toLocaleString()}`);
  console.log(`覆盖人数        ${result.users.toLocaleString()}`);
  console.log(`未实现盈亏可算  ${result.unrealizedResolved.toLocaleString()} 个持仓`);
  if (result.skippedQuoteLeg > 0) {
    console.log(`报价腿已排除    ${result.skippedQuoteLeg.toLocaleString()}   ← 稳定币/原生币，是 swap 的另一条腿`);
  }
  if (result.parseFailed > 0) console.log(`JSON 解析失败   ${result.parseFailed}`);
  if (result.skippedNoSeries > 0) console.log(`字段缺失跳过    ${result.skippedNoSeries}`);
  console.log(`耗时            ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log('');
  console.log(dry ? '试运行完成，未写库。' : '完成。运行 `npm run pnl:report` 查看排行榜。');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
