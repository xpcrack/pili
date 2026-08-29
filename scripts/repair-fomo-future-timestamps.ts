#!/usr/bin/env node
/**
 * Repair fomo-pump future timestamp events (2026-08-29 回归).
 * 根因: fomoPumpTelegramParser.parseClockTime 用本地时区 setHours 解释
 *       平台(UTC)标注时间 -> events.timestamp 偏 +12h 显示为"未来"。
 * 修复: 重放修复后的 parseFomoPumpTelegramText，用 rawText 标注时间 +
 *       created_at(≈message.date) 重算正确 UTC epoch，回写 events.timestamp
 *       及 activity_json 嵌套 timestamp。
 *
 * 用法: 加 --write 才真正写库；否则 dry-run 打印差异。
 */
import './server-only-shim.cjs';
import { getDb, withTransaction } from '../lib/server/sqlite';
import { parseFomoPumpTelegramText } from '../lib/server/fomoPumpTelegramParser';

const WRITE = process.argv.includes('--write');

const db = getDb();
const rows = db
  .prepare(
    `SELECT event_id, created_at, timestamp AS bad_ts, activity_json
     FROM events
     WHERE ingest_source = 'fomo-pump-telegram'
       AND datetime(timestamp/1000,'unixepoch','localtime') > datetime('now','localtime')`
  )
  .all() as Array<{
  event_id: string;
  created_at: number;
  bad_ts: number;
  activity_json: string;
}>;

console.log(`found ${rows.length} future fomo events`);

let fixedCount = 0;
let skipped = 0;

// 先在事务外完成全部计算（只读），再单事务写入，避免长事务阻塞 live 进程。
const fixes: Array<{ eventId: string; goodTs: number; activityJson: string }> = [];

for (const row of rows) {
  const activity = JSON.parse(row.activity_json);
  const rawText = activity?.metadata?.rawText as string | undefined;
  if (!rawText) {
    skipped++;
    console.log(`SKIP ${row.event_id}: no rawText`);
    continue;
  }
  // 用修复后的 parser 重放：fallbackMs 取 created_at(≈message.date)，保证锚点一致。
  const parsed = parseFomoPumpTelegramText(rawText, row.created_at);
  const trade = parsed.trades[0];
  if (!trade || typeof trade.eventTimeMs !== 'number') {
    skipped++;
    console.log(`SKIP ${row.event_id}: no trade/eventTimeMs`);
    continue;
  }
  const goodTs = trade.eventTimeMs;
  if (goodTs > row.bad_ts) {
    // 修复后仍晚于旧值(异常)，跳过避免误伤
    skipped++;
    console.log(`SKIP ${row.event_id}: goodTs(${goodTs}) > badTs(${row.bad_ts})`);
    continue;
  }
  fixes.push({ eventId: row.event_id, goodTs, activityJson: JSON.stringify({ ...activity, timestamp: goodTs }) });
  fixedCount++;
  console.log(
    `FIX ${row.event_id}: ${new Date(row.bad_ts).toISOString()} -> ${new Date(goodTs).toISOString()} (${row.bad_ts - goodTs}ms earlier)`
  );
}

if (WRITE && fixes.length > 0) {
  withTransaction(() => {
    const stmt = db.prepare(
      `UPDATE events SET timestamp = ?, activity_json = ?, updated_at = ? WHERE event_id = ?`
    );
    for (const fix of fixes) {
      stmt.run(fix.goodTs, fix.activityJson, Date.now(), fix.eventId);
    }
  });
}

console.log(`\n${WRITE ? 'WROTE' : 'DRY-RUN'} results: fixed=${fixedCount}, skipped=${skipped}`);
