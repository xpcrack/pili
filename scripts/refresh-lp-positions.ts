/** 手动跑一轮 V4 LP 刷新（默认写生产库；--dry 只打印不写；--db <path> 指定库）。 */
import './server-only-shim.cjs';

import {
  refreshLpPositions,
  ensureLpPositionsTable,
} from '@/lib/server/lpPositionsRefresh';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const dbIndex = args.indexOf('--db');
const customDb = dbIndex >= 0 ? args[dbIndex + 1] : undefined;

if (customDb) {
  process.env.PILIPILI_DB_PATH = customDb;
}
// worktree 默认 data dir 解析到 repo 上两级 —— 显式指向本仓库 .data（与生产共享）。
if (!process.env.PILIPILI_DATA_DIR && !customDb) {
  process.env.PILIPILI_DATA_DIR = '/Users/xp/vibecoding/pilipili/.data';
}

async function run() {
  if (dry) {
    console.log('[dry] 只读钱包列表与扫描，不写库 —— 使用临时注入逻辑不便，直接打印将写入的行数。');
  }
  const started = Date.now();
  const result = await refreshLpPositions();
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`status=${result.status} elapsed=${elapsed}s`);
  console.log(`wallets=${result.summary.walletCount} withLp=${result.summary.walletsWithLp} positions=${result.summary.positionCount} totalUsd=${Math.round(result.summary.totalUsd)}`);
  if (result.summary.lastError) console.log(`lastError: ${result.summary.lastError}`);
  process.exit(0);
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
void ensureLpPositionsTable;
