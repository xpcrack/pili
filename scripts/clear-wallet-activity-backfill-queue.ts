/**
 * Clear the wallet-activity backfill queue (app_state key wallet_activity_backfill_queue_v1).
 *
 * Used to break a stuck drain loop: addresses that keep hitting the shared GMGN
 * ban renew it every cycle, starving live-monitor and breaking the on-chain feed.
 * After clearing, restart pili-background-worker so the in-memory queue reloads empty.
 *
 *   npx tsx scripts/clear-wallet-activity-backfill-queue.ts
 */
import './server-only-shim.cjs';

import { getDb } from '../lib/server/sqlite';

const QUEUE_APP_STATE_KEY = 'wallet_activity_backfill_queue_v1';

function readItems(): unknown[] {
  const db = getDb();
  const row = db
    .prepare('SELECT value_json FROM app_state WHERE key = ?')
    .get(QUEUE_APP_STATE_KEY) as { value_json: string } | undefined;
  if (!row?.value_json) return [];
  try {
    const parsed = JSON.parse(row.value_json) as { items?: unknown[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

const before = readItems() as Array<{ address?: string; reason?: string }>;
console.log(`[clear-backfill-queue] before: ${before.length} item(s)`);
for (const it of before.slice(0, 30)) {
  console.log(`  - ${it.address ?? '?'} reason=${it.reason ?? '?'}`);
}

if (before.length === 0) {
  console.log('[clear-backfill-queue] already empty, nothing to do.');
  process.exit(0);
}

const db = getDb();
db.prepare(
  `INSERT INTO app_state (key, value_json, updated_at)
   VALUES (?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
).run(QUEUE_APP_STATE_KEY, JSON.stringify({ items: [] }), Date.now());

const after = readItems();
console.log(`[clear-backfill-queue] after: ${after.length} item(s)`);
console.log(
  '[clear-backfill-queue] done. Now restart pili-background-worker so its in-memory queue reloads empty: pm2 restart pili-background-worker'
);
