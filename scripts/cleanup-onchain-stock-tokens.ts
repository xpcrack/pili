/**
 * 清理库里已存在的链上股票代币(tokenized stock)事件。
 *
 * 背景:监控人物在 PancakeSwap 买 starman 这类 meme,路由 `BUSD → SPCXB → starman`,
 * SPCXB 只是被借道的链上股票代币,却被链上监控当成"买了 ~290U 的 SPCXB"入库。
 * 见 lib/onchainStockTokens.ts;新数据已由 gmgnWalletActivity / telegramMonitorIngest 过滤,
 * 本脚本清掉历史残留。
 *
 * 清理目标(地址集与 onchainStockTokens.ONCHAIN_STOCK_ADDRESSES 保持一致):
 *   SPCXB / AAPLB / NVDAB / AAPLon / NVDAon — 约 377 条 events(blockchain/transfer) +
 *   telegram_monitor_events 原始行(防重投递重插)。
 *
 * events 删除会经 events_ad AFTER-DELETE 触发器自动同步 events_fts(external-content),无需手动维护。
 *
 * 用法:
 *   npx tsx scripts/cleanup-onchain-stock-tokens.ts            # dry-run,只打印不删
 *   npx tsx scripts/cleanup-onchain-stock-tokens.ts --apply    # 真删
 */

/* eslint-disable @typescript-eslint/no-require-imports */
import Database from 'better-sqlite3';

const STOCK_ADDRS = [
  '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1', // SPCXB — SpaceX
  '0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a', // AAPLB — Apple
  '0x02fca66c1d1afb4e2a7884261eb00f63598a7436', // NVDAB — NVIDIA Corp
  '0x390a684ef9cade28a7ad0dfa61ab1eb3842618c4', // AAPLon — Apple (Ondo Tokenized)
  '0xa9ee28c80f960b889dfbd1902055218cba016f75', // NVDAon — NVIDIA (Ondo Tokenized)
];

const apply = process.argv.includes('--apply');
const dbPath = process.env.PILI_DB_PATH || '.data/web3-feed.sqlite';
const db = new Database(dbPath, apply ? undefined : { readonly: true });

const placeholders = STOCK_ADDRS.map(() => '?').join(',');

// events 表:按 metadata_json.tokenAddress 命中(blockchain/transfer 的 tokenAddress 写在 metadata)。
const eventsCount = db
  .prepare(
    `SELECT lower(json_extract(metadata_json,'$.tokenAddress')) addr, COUNT(*) n
     FROM events
     WHERE lower(json_extract(metadata_json,'$.tokenAddress')) IN (${placeholders})
     GROUP BY addr ORDER BY n DESC`,
  )
  .all(...STOCK_ADDRS) as Array<{ addr: string; n: number }>;

console.log(`模式: ${apply ? 'APPLY(真删)' : 'DRY-RUN(不删,加 --apply 才删)'}\n`);
console.log('=== 待清理 events(blockchain/transfer) ===');
let totalEvents = 0;
for (const r of eventsCount) {
  console.log(`  ${r.addr}  ${r.n} 条`);
  totalEvents += r.n;
}
console.log(`  合计 events: ${totalEvents}`);

const tmCount = db
  .prepare(
    `SELECT COUNT(*) n FROM telegram_monitor_events
     WHERE token_address_lower IN (${placeholders})`,
  )
  .get(...STOCK_ADDRS) as { n: number };
console.log(`  telegram_monitor_events 原始行: ${tmCount.n}`);

if (!apply) {
  console.log('\n(dry-run,未删除。加 --apply 执行真删。)');
  db.close();
  process.exit(0);
}

const txn = db.transaction(() => {
  const ev = db
    .prepare(
      `DELETE FROM events
       WHERE lower(json_extract(metadata_json,'$.tokenAddress')) IN (${placeholders})`,
    )
    .run(...STOCK_ADDRS);
  const tm = db
    .prepare(`DELETE FROM telegram_monitor_events WHERE token_address_lower IN (${placeholders})`)
    .run(...STOCK_ADDRS);
  console.log(`\n已删除: events ${ev.changes} 条, telegram_monitor_events ${tm.changes} 条`);
});
txn();
db.close();
