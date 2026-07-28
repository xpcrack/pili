/**
 * Reset `historical_max_asset_usd` for people whose peak was set by an inflated
 * provider reading.
 *
 * `historical_max_asset_usd` is a permanent MAX(), so one bad OKX total sticks
 * forever. 老王 sat at $8.685B off a bag of illiquid tokens that the holdings
 * filter (MIN_LIQUIDITY_USD = $5k) drops completely — his liquid holdings are $0.
 *
 * The write-side guard now lives in `updateAssetSnapshots`; this cleans up the
 * damage already recorded.
 *
 *   npm run peaks:repair            # dry run, prints what it would change
 *   npm run peaks:repair -- --apply
 */
import './server-only-shim.cjs';

import { isDetailTotalMismatch } from '../lib/server/assetAnomalyRules';
import { getDb, withSqliteBusyRetry } from '../lib/server/sqlite';

interface Row {
  id: string;
  name: string;
  total_asset_usd: number;
  historical_max_asset_usd: number;
  holdings_usd: number;
  refreshed: number;
}

function money(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

async function run() {
  const apply = process.argv.slice(2).includes('--apply');
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.total_asset_usd, u.historical_max_asset_usd,
              COALESCE(h.holdings_usd, 0) AS holdings_usd,
              COALESCE(s.refreshed, 0) AS refreshed
       FROM tracked_users u
       LEFT JOIN (SELECT user_id, SUM(value_usd) holdings_usd FROM current_holdings GROUP BY user_id) h
         ON h.user_id = u.id
       LEFT JOIN (SELECT user_id, COUNT(1) refreshed FROM current_holdings_wallet_status GROUP BY user_id) s
         ON s.user_id = u.id
       WHERE u.historical_max_asset_usd > 0`
    )
    .all() as Row[];

  // A peak far above CURRENT holdings is a normal drawdown, not pollution —
  // rop peaked at $537K and now holds $203K, which is just how trading works.
  // The only provable pollution is: the CURRENT reading is itself inflated
  // (raw total >> liquidity-filtered holdings) AND the peak was set by that
  // very reading. Anything else is indistinguishable from a real drawdown
  // without historical asset snapshots, which we do not keep.
  const PEAK_MATCH_TOLERANCE = 0.01;
  const suspects = rows.filter((row) => {
    if (row.refreshed <= 0) return false;
    if (!isDetailTotalMismatch(row.total_asset_usd, row.holdings_usd)) return false;
    if (row.total_asset_usd <= row.holdings_usd) return false;
    const peakSetByThisReading =
      row.historical_max_asset_usd > 0 &&
      Math.abs(row.historical_max_asset_usd - row.total_asset_usd) / row.historical_max_asset_usd <=
        PEAK_MATCH_TOLERANCE;
    return peakSetByThisReading;
  });

  // Disabled people never get a holdings refresh, so their last raw total is
  // frozen forever and cannot be verified either way. Report, never auto-fix.
  const unverifiable = rows.filter(
    (row) => row.refreshed <= 0 && row.historical_max_asset_usd >= 1_000_000
  );

  const reportUnverifiable = () => {
    if (unverifiable.length === 0) return;
    console.log('');
    console.log('以下人物已停止监控（飞书禁用），持仓不再刷新，最后一次读数被永久冻结：');
    console.log('无法证实也无法证伪，**不会自动修改**，需要你人工判断：');
    for (const row of unverifiable.sort((a, b) => b.historical_max_asset_usd - a.historical_max_asset_usd)) {
      console.log(`  ${row.name.padEnd(14)}  峰值 ${money(row.historical_max_asset_usd)}`);
    }
  };

  if (suspects.length === 0) {
    console.log('没有发现可证实的污染峰值（峰值高于当前持仓属于正常回撤，不算污染）。');
    reportUnverifiable();
    return;
  }

  console.log('');
  console.log(apply ? '正在修复被污染的历史最高资产…' : '试运行（不写库）——以下峰值由虚高读数造成：');
  console.log('');
  console.log('判据：当前读数本身虚高（原始总额 >> 有流动性持仓），且峰值正是被这次读数顶上去的。');
  console.log('');
  console.log('人物              当前峰值      有流动性持仓   将修正为      虚高倍数');
  console.log('─'.repeat(78));

  const updates: Array<{ id: string; next: number }> = [];
  for (const row of suspects.sort((a, b) => b.historical_max_asset_usd - a.historical_max_asset_usd)) {
    // Fall back to the liquid holdings we can actually verify. A peak we cannot
    // substantiate is worse than a conservative one.
    const next = Math.max(row.holdings_usd, 0);
    const inflate = row.holdings_usd > 0 ? row.historical_max_asset_usd / row.holdings_usd : Infinity;
    console.log(
      `${row.name.padEnd(14)}  ${money(row.historical_max_asset_usd).padEnd(12)}  ${money(row.holdings_usd).padEnd(13)}  ${money(next).padEnd(12)}  ${Number.isFinite(inflate) ? `${inflate.toFixed(0)}x` : '全部无流动性'}`
    );
    updates.push({ id: row.id, next });
  }

  console.log('');
  if (!apply) {
    console.log(`共 ${updates.length} 人。确认无误后加 --apply 执行。`);
    reportUnverifiable();
    return;
  }

  const now = Date.now();
  withSqliteBusyRetry(
    () => {
      const stmt = db.prepare(
        `UPDATE tracked_users SET historical_max_asset_usd = ?, updated_at = ? WHERE id = ?`
      );
      for (const update of updates) {
        stmt.run(update.next, now, update.id);
      }
    },
    { label: 'repairInflatedAssetPeaks' }
  );

  console.log(`已修正 ${updates.length} 人的历史最高资产。`);
  console.log('写入侧的防护已加在 updateAssetSnapshots，之后不会再被虚高读数顶上去。');
  reportUnverifiable();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
