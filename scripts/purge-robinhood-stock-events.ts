/**
 * One-shot: purge official Robinhood equity-token events from feed DB.
 *
 * Usage:
 *   bun scripts/purge-robinhood-stock-events.ts           # dry-run
 *   bun scripts/purge-robinhood-stock-events.ts --apply   # delete
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { ROBINHOOD_OFFICIAL_STOCK_ADDRESSES } from '../lib/robinhoodStockTokens';

const apply = process.argv.includes('--apply');
const dbPath =
  process.env.PILI_DB_PATH?.trim() ||
  path.join(process.cwd(), '.data', 'web3-feed.sqlite');

if (!existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}

const addresses = [...ROBINHOOD_OFFICIAL_STOCK_ADDRESSES];
const placeholders = addresses.map(() => '?').join(',');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const eventCount = (
  db
    .prepare(
      `SELECT COUNT(*) AS c FROM events
       WHERE lower(chain) = 'robinhood'
         AND lower(json_extract(metadata_json, '$.tokenAddress')) IN (${placeholders})`
    )
    .get(...addresses) as { c: number }
).c;

const monitorCount = (
  db
    .prepare(
      `SELECT COUNT(*) AS c FROM telegram_monitor_events
       WHERE lower(chain) = 'robinhood'
         AND token_address_lower IN (${placeholders})`
    )
    .get(...addresses) as { c: number }
).c;

const byToken = db
  .prepare(
    `SELECT upper(token) AS sym,
            lower(json_extract(metadata_json, '$.tokenAddress')) AS ca,
            COUNT(*) AS c
     FROM events
     WHERE lower(chain) = 'robinhood'
       AND lower(json_extract(metadata_json, '$.tokenAddress')) IN (${placeholders})
     GROUP BY 1, 2
     ORDER BY c DESC`
  )
  .all(...addresses) as Array<{ sym: string; ca: string; c: number }>;

console.log(`DB: ${dbPath}`);
console.log(`Official stock CAs: ${addresses.length}`);
console.log(`events rows: ${eventCount}`);
console.log(`telegram_monitor_events rows: ${monitorCount}`);
for (const row of byToken) {
  console.log(`  ${row.sym || '?'} ${row.ca} × ${row.c}`);
}

if (!apply) {
  console.log('\nDry-run only. Re-run with --apply to delete.');
  db.close();
  process.exit(0);
}

const tx = db.transaction(() => {
  const delEvents = db
    .prepare(
      `DELETE FROM events
       WHERE lower(chain) = 'robinhood'
         AND lower(json_extract(metadata_json, '$.tokenAddress')) IN (${placeholders})`
    )
    .run(...addresses);

  const delMonitor = db
    .prepare(
      `DELETE FROM telegram_monitor_events
       WHERE lower(chain) = 'robinhood'
         AND token_address_lower IN (${placeholders})`
    )
    .run(...addresses);

  return { events: delEvents.changes, monitor: delMonitor.changes };
});

const result = tx();
console.log(`\nDeleted events=${result.events} telegram_monitor_events=${result.monitor}`);
// FTS is maintained by DELETE triggers on events — no manual rebuild needed.
db.close();
