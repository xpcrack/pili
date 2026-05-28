/**
 * refresh-holdings.ts — 从OKX Web3 API刷新所有tracked address的当前持仓，
 * 存入pili DB的 current_holdings 表。< $5的持仓过滤掉。
 *
 * 用法:
 *   cd ~/vibecoding/pilipili
 *   npx tsx scripts/refresh-holdings.ts          # 全量刷新
 *   npx tsx scripts/refresh-holdings.ts --dry    # 只查不写
 *   npx tsx scripts/refresh-holdings.ts --stats  # 只看统计
 */

import './server-only-shim.cjs';

import {
  readCurrentHoldingsStats,
  refreshCurrentHoldings,
} from '@/lib/server/holdingsRefreshRuntime';
import { loadWorkerEnv } from './lib/workerLifecycle';

loadWorkerEnv();

function formatUsd(value: number) {
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function showStats() {
  const stats = readCurrentHoldingsStats();
  const ageHours = stats.refreshedAtMs ? ((Date.now() - stats.refreshedAtMs) / 3600_000).toFixed(1) : 'N/A';

  console.log('📊 当前持仓统计:');
  console.log(`  总记录: ${stats.totalRecords}`);
  console.log(`  唯一token: ${stats.uniqueTokens}`);
  console.log(`  唯一钱包: ${stats.uniqueWallets}`);
  console.log(`  唯一用户: ${stats.uniqueUsers}`);
  console.log(`  上次刷新: ${ageHours}h前`);
  console.log('\n  链分布:');
  for (const row of stats.chainDistribution) {
    console.log(`    ${row.chain}: ${row.tokenCount} 个token`);
  }
  console.log('\n  持有人最多的token:');
  for (const row of stats.topTokens) {
    console.log(
      `    ${String(row.symbol || '-').padEnd(10)} ${String(row.chain).padEnd(8)} ${row.holders}人 $${Math.round(row.totalValue).toLocaleString()}`
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry');
  const statsOnly = args.includes('--stats');

  if (statsOnly) {
    showStats();
    return;
  }

  const now = new Date();
  const tz8 = new Date(now.getTime() + 8 * 3600_000);
  const timeStr = tz8.toISOString().slice(5, 16).replace('T', ' ');
  console.log(`🔄 Pili持仓刷新 | ${timeStr}`);

  const startedAt = Date.now();
  const result = await refreshCurrentHoldings({ dryRun });

  console.log(
    `📋 ${result.summary.trackedAddressCount} 个tracked address → 去重后 ${result.summary.uniqueTrackedAddressCount} 个`
  );
  console.log(`  ✅ 成功: ${result.summary.refreshedWalletCount}, 失败: ${result.summary.failedWalletCount}`);
  console.log(`  📊 持仓记录: ${result.summary.holdingsRowCount} (>= $5)`);
  if (result.summary.filteredOutHoldingCount > 0) {
    console.log(`  🧹 已过滤小额持仓: ${result.summary.filteredOutHoldingCount}`);
  }

  if (dryRun) {
    console.log('  [DRY RUN] 不写入数据库');
  } else {
    console.log(`  ✅ 刷新完成，状态: ${result.status}`);
    showStats();
  }

  if (result.lastError) {
    console.log(`  ⚠️ ${result.lastError}`);
  }

  console.log(`⏱️ 耗时: ${Math.round((Date.now() - startedAt) / 1000)}s`);

  if (result.status === 'error' || result.status === 'missing-credentials') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`❌ Fatal error: ${message}`);
  process.exit(1);
});
