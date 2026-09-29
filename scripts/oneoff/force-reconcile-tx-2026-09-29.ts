/**
 * 一次性修复:强制对账指定的 XXYY monitor tx,用 OKX 链上数据覆盖推送文案。
 * 用法: cd /Users/xp/vibecoding/pilipili && NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' npx tsx scripts/oneoff/force-reconcile-tx-2026-09-29.ts
 */
import { loadRuntimeEnv } from '../../server/env';

import { getDb } from '../../lib/server/sqlite';
import { reconcileTelegramMonitorTxState } from '../../lib/server/telegramMonitorReconciler';

const TX_HASH = '0xb488abd3e9f28b11ebd8a730627c5a853f663c466d4c0eb0688f6028226b9f47';
const WALLET = '0xf1582d82c0bb81a9e4a8a2cd3fef73271b00a9a9';

function printStateBefore() {
  const db = getDb();
  const before = db
    .prepare(
      `SELECT reconciliation_status, provisional_market_cap_usd, provisional_price_usd,
              provisional_quote_amount, provisional_token_amount
       FROM telegram_monitor_tx_states WHERE tx_hash_lower = ?`
    )
    .all(TX_HASH);
  console.log('state rows before:', JSON.stringify(before, null, 2));
}

function printStateAfter() {
  const db = getDb();
  const after = db
    .prepare(
      `SELECT reconciliation_status, reconciled_source, last_error FROM telegram_monitor_tx_states
       WHERE tx_hash_lower = ?`
    )
    .all(TX_HASH);
  console.log('state rows after:', JSON.stringify(after, null, 2));

  const feedRow = db
    .prepare(
      `SELECT activity_json FROM events WHERE tx_hash = ? AND ingest_source LIKE 'telegram-monitor%'
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(TX_HASH) as { activity_json: string } | undefined;
  if (feedRow) {
    const activity = JSON.parse(feedRow.activity_json);
    const m = activity.metadata;
    console.log('feed row:', {
      quoteAmount: m.quoteAmount,
      quoteToken: m.quoteToken,
      value: m.value,
      marketCapAtTxUsd: m.marketCapAtTxUsd,
      marketCapAtTxSource: m.marketCapAtTxSource,
      tradeAmountUsdAtTx: m.tradeAmountUsdAtTx,
      reconciliation: m.monitorReconciliationStatus,
      reconciledSource: m.monitorReconciledSource,
      displayMarketCapText: m.displayMarketCapText,
      displayTradeAmountText: m.displayTradeAmountText,
    });
  } else {
    console.log('no feed row found for tx');
  }
}

async function run() {
  loadRuntimeEnv(process.cwd());
  printStateBefore();

  const result = await reconcileTelegramMonitorTxState({
    chain: 'bsc',
    trackedWalletAddress: WALLET,
    txHash: TX_HASH,
    force: true,
  });
  console.log('reconcile result:', JSON.stringify(result));
  printStateAfter();
}

void run();
