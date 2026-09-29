/**
 * 一次性修复:用 buildTradeDisplayMetadata 重建指定 tx 存量 feed 行的展示种子。
 * 用法: cd /Users/xp/vibecoding/pilipili && NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' npx tsx scripts/oneoff/repair-display-seed-2026-09-29.ts
 */
import { loadRuntimeEnv } from '../../server/env';

import { getDb } from '../../lib/server/sqlite';
import { buildTradeDisplayMetadata } from '../../lib/tradeDisplay';

const TX_HASH = '0xb488abd3e9f28b11ebd8a730627c5a853f663c466d4c0eb0688f6028226b9f47';

function run() {
  loadRuntimeEnv(process.cwd());
  const db = getDb();
  const row = db
    .prepare(`SELECT rowid, activity_json FROM events WHERE tx_hash = ?`)
    .get(TX_HASH) as { rowid: number; activity_json: string } | undefined;
  if (!row) {
    console.log('row not found');
    return;
  }
  const activity = JSON.parse(row.activity_json);
  const m = activity.metadata;
  const display = buildTradeDisplayMetadata({
    // canonical 链上数据重建展示:不喂历史推送文案
    walletLabel: m.monitorWalletAliasLabel || m.monitorWalletLabel || m.displayWalletLabel,
    fallbackWalletLabel: m.displayWalletLabel,
    actionVariant: m.txActionVariant,
    txActionLabel: m.txActionLabel,
    quoteAmount: m.quoteAmount || null,
    quoteToken: m.quoteToken || null,
    value: m.value || null,
    tokenSymbol: m.token || null,
    marketCapText: m.displayMarketCapText,
    marketCapUsd: m.marketCapAtTxUsd ?? null,
    tokenAddress: m.displayTokenAvatarTokenAddress || m.tokenAddress || null,
  });
  m.displayTradeAmountText = display.displayTradeAmountText ?? m.displayTradeAmountText;
  m.displayMarketCapText = display.displayMarketCapText ?? m.displayMarketCapText;
  activity.metadata = m;
  db.prepare(`UPDATE events SET activity_json = ?, updated_at = ? WHERE rowid = ?`).run(
    JSON.stringify(activity),
    Date.now(),
    row.rowid
  );
  console.log('updated row', row.rowid, {
    displayTradeAmountText: m.displayTradeAmountText,
    displayMarketCapText: m.displayMarketCapText,
  });
}

run();
