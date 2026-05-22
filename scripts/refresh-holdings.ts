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

import { fetchOkxAddressAssetDetails, isSupportedOkxChain } from '@/lib/okx';
import { getDb } from '@/lib/server/sqlite';
import { loadWorkerEnv } from './lib/workerLifecycle';

loadWorkerEnv();

const MIN_HOLDING_USD = 5;
const SUPPORTED_CHAINS = ['bsc', 'ethereum', 'base', 'solana'] as const;

function ensureTable(db: any) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS current_holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracked_address TEXT NOT NULL,
      tracked_address_lower TEXT NOT NULL,
      user_id TEXT,
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      token_address_lower TEXT NOT NULL,
      symbol TEXT,
      name TEXT,
      balance REAL,
      price_usd REAL,
      value_usd REAL,
      refreshed_at INTEGER NOT NULL,
      UNIQUE(tracked_address_lower, chain, token_address_lower)
    );
    CREATE INDEX IF NOT EXISTS idx_holdings_token
      ON current_holdings(chain, token_address_lower);
    CREATE INDEX IF NOT EXISTS idx_holdings_user
      ON current_holdings(user_id);
    CREATE INDEX IF NOT EXISTS idx_holdings_value
      ON current_holdings(value_usd);
  `);
}

function showStats(db: any) {
  const total = (db.prepare('SELECT COUNT(*) as c FROM current_holdings').get() as any).c;
  const uniqueTokens = (db.prepare('SELECT COUNT(DISTINCT token_address_lower) as c FROM current_holdings').get() as any).c;
  const uniqueWallets = (db.prepare('SELECT COUNT(DISTINCT tracked_address_lower) as c FROM current_holdings').get() as any).c;
  const uniqueUsers = (db.prepare('SELECT COUNT(DISTINCT user_id) as c FROM current_holdings').get() as any).c;
  const maxTs = (db.prepare('SELECT MAX(refreshed_at) as ts FROM current_holdings').get() as any).ts;
  const ageH = maxTs ? ((Date.now() - maxTs) / 3600_000).toFixed(1) : 'N/A';

  const chainDist = db.prepare(
    'SELECT chain, COUNT(DISTINCT token_address_lower) as c FROM current_holdings GROUP BY chain'
  ).all() as any[];

  const topTokens = db.prepare(`
    SELECT token_address_lower, chain, symbol,
           COUNT(DISTINCT tracked_address_lower) as holders,
           SUM(value_usd) as total_value
    FROM current_holdings
    GROUP BY token_address_lower
    ORDER BY holders DESC
    LIMIT 10
  `).all() as any[];

  console.log(`📊 当前持仓统计:`);
  console.log(`  总记录: ${total}`);
  console.log(`  唯一token: ${uniqueTokens}`);
  console.log(`  唯一钱包: ${uniqueWallets}`);
  console.log(`  唯一用户: ${uniqueUsers}`);
  console.log(`  上次刷新: ${ageH}h前`);
  console.log(`\n  链分布:`);
  for (const row of chainDist) {
    console.log(`    ${row.chain}: ${row.c} 个token`);
  }
  console.log(`\n  持有人最多的token:`);
  for (const row of topTokens) {
    console.log(`    ${String(row.symbol).padEnd(10)} ${String(row.chain).padEnd(5)} ${row.holders}人 $${Math.round(row.total_value).toLocaleString()}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry');
  const statsOnly = args.includes('--stats');

  const db = getDb();
  ensureTable(db);

  if (statsOnly) {
    showStats(db);
    return;
  }

  const now = new Date();
  const tz8 = new Date(now.getTime() + 8 * 3600_000);
  const timeStr = tz8.toISOString().slice(5, 16).replace('T', ' ');
  console.log(`🔄 Pili持仓刷新 | ${timeStr}`);
  const startTime = Date.now();

  // Get all tracked addresses
  const rows = db.prepare(`
    SELECT id, user_id, address, address_lower, chain
    FROM tracked_addresses
    WHERE chain IN (${SUPPORTED_CHAINS.map(c => `'${c}'`).join(',')})
  `).all() as any[];

  // Deduplicate by (address_lower, chain)
  const seen = new Set<string>();
  const unique: any[] = [];
  for (const row of rows) {
    const key = `${row.address_lower}:${row.chain}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(row);
    }
  }

  console.log(`📋 ${rows.length} 个tracked address → 去重后 ${unique.length} 个`);

  let successCount = 0;
  let failCount = 0;
  let totalHoldings = 0;
  const allHoldings: any[] = [];
  const nowMs = Date.now();

  for (let i = 0; i < unique.length; i++) {
    const row = unique[i];

    if ((i + 1) % 50 === 0 || i === 0) {
      console.log(`  ⏳ ${i + 1}/${unique.length} ... (${successCount} OK, ${failCount} fail)`);
    }

    if (!isSupportedOkxChain(row.chain)) {
      failCount++;
      continue;
    }

    const result = await fetchOkxAddressAssetDetails(row.address, row.chain);

    if (!result.ok) {
      failCount++;
      continue;
    }

    successCount++;

    for (const asset of result.assets) {
      if (asset.valueUsd < MIN_HOLDING_USD) continue;

      const tokenAddrLower = row.chain === 'solana'
        ? asset.tokenAddress
        : asset.tokenAddress.toLowerCase();

      allHoldings.push({
        tracked_address: row.address,
        tracked_address_lower: row.address_lower,
        user_id: row.user_id,
        chain: row.chain,
        token_address: asset.tokenAddress,
        token_address_lower: tokenAddrLower,
        symbol: asset.symbol,
        name: asset.name,
        balance: asset.balance,
        price_usd: asset.priceUsd,
        value_usd: asset.valueUsd,
        refreshed_at: nowMs,
      });

      totalHoldings++;
    }
  }

  console.log(`  ✅ 成功: ${successCount}, 失败: ${failCount}`);
  console.log(`  📊 持仓记录: ${totalHoldings} (≥$${MIN_HOLDING_USD})`);

  if (dryRun) {
    console.log('  [DRY RUN] 不写入数据库');
    allHoldings.sort((a: any, b: any) => b.value_usd - a.value_usd);
    console.log('\n  Top 10 持仓:');
    for (const h of allHoldings.slice(0, 10)) {
      console.log(`    ${String(h.symbol).padEnd(10)} ${String(h.chain).padEnd(5)} $${h.value_usd.toLocaleString('en-US', { minimumFractionDigits: 2 })}  ${String(h.tracked_address).slice(0, 10)}...`);
    }
    return;
  }

  // Atomic replace
  console.log('  💾 写入数据库...');
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM current_holdings').run();

    const insert = db.prepare(`
      INSERT OR REPLACE INTO current_holdings
      (tracked_address, tracked_address_lower, user_id, chain,
       token_address, token_address_lower, symbol, name,
       balance, price_usd, value_usd, refreshed_at)
      VALUES (@tracked_address, @tracked_address_lower, @user_id, @chain,
              @token_address, @token_address_lower, @symbol, @name,
              @balance, @price_usd, @value_usd, @refreshed_at)
    `);

    for (const h of allHoldings) {
      insert.run(h);
    }
  });
  tx();

  console.log(`  ✅ 写入 ${allHoldings.length} 条持仓记录`);
  showStats(db);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`⏱️ 耗时: ${elapsed}s`);
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
