/**
 * Delete telegram/xxyy monitor event rows that shadow a live-monitor wallet+tx.
 *
 * live-monitor is authority once it owns the same user/chain/address/tx_hash.
 * Shadows include:
 *   - same token+action pure dups
 *   - conflict rows (counter-flow wrong token/action, e.g. sell JIMOTHY + buy WETH)
 *
 * Usage:
 *   npx tsx scripts/cleanup-live-vs-telegram-shadows.ts --dry
 *   npx tsx scripts/cleanup-live-vs-telegram-shadows.ts --force-prod-db
 *   npx tsx scripts/cleanup-live-vs-telegram-shadows.ts --force-prod-db --conflicts-only
 *   npx tsx scripts/cleanup-live-vs-telegram-shadows.ts --force-prod-db --days=14
 */

import './server-only-shim.cjs';

import { getDb } from '../lib/server/sqlite';
import { exitIfProdDbHeavyJobBlocked } from './lib/prodDbGuard';

function parseArgs(argv: string[]) {
  let dry = false;
  let forceProd = false;
  let conflictsOnly = false;
  let days: number | null = null;
  let limit: number | null = null;
  for (const arg of argv) {
    if (arg === '--dry') dry = true;
    else if (arg === '--force-prod-db') forceProd = true;
    else if (arg === '--conflicts-only') conflictsOnly = true;
    else if (arg.startsWith('--days=')) {
      const n = Number.parseInt(arg.slice('--days='.length), 10);
      if (Number.isFinite(n) && n > 0) days = n;
    } else if (arg.startsWith('--limit=')) {
      const n = Number.parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
  }
  return { dry, forceProd, conflictsOnly, days, limit };
}

type ShadowRow = {
  event_id: string;
  ingest_source: string | null;
  timestamp: number;
  user_id: string;
  chain: string | null;
  address: string | null;
  tx: string;
  token: string;
  action: string;
  live_token: string;
  live_action: string;
  kind: 'conflict' | 'dup';
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.forceProd) {
    process.env.PILIPILI_ALLOW_PROD_DB_HEAVY = '1';
  }
  exitIfProdDbHeavyJobBlocked({ jobName: 'cleanup-live-vs-telegram-shadows' });

  const db = getDb();
  const sinceMs = args.days != null ? Date.now() - args.days * 86_400_000 : null;

  console.log(
    `[shadow-cleanup] dry=${args.dry} conflictsOnly=${args.conflictsOnly} days=${args.days ?? 'all'} limit=${args.limit ?? 'none'}`
  );

  db.exec(`
    CREATE TEMP TABLE live_auth AS
    SELECT
      user_id,
      chain,
      address,
      LOWER(tx_hash) AS tx,
      LOWER(COALESCE(json_extract(activity_json, '$.metadata.tokenAddress'), '')) AS token,
      LOWER(COALESCE(json_extract(activity_json, '$.metadata.txAction'), '')) AS action
    FROM events
    WHERE source = 'blockchain'
      AND (
        ingest_source LIKE 'live-monitor%'
        OR event_id LIKE 'live-monitor:%'
      )
      AND tx_hash IS NOT NULL
      AND length(tx_hash) > 0;

    CREATE INDEX tmp_live_auth_key ON live_auth(user_id, chain, address, tx);

    CREATE TEMP TABLE tg_cand AS
    SELECT
      event_id,
      user_id,
      chain,
      address,
      LOWER(tx_hash) AS tx,
      timestamp,
      ingest_source,
      LOWER(COALESCE(json_extract(activity_json, '$.metadata.tokenAddress'), '')) AS token,
      LOWER(COALESCE(json_extract(activity_json, '$.metadata.txAction'), '')) AS action
    FROM events
    WHERE source = 'blockchain'
      AND (
        ingest_source LIKE 'telegram-monitor%'
        OR event_id LIKE 'xxyy-monitor:%'
      )
      AND tx_hash IS NOT NULL
      AND length(tx_hash) > 0
      ${sinceMs != null ? `AND timestamp >= ${sinceMs}` : ''};

    CREATE INDEX tmp_tg_cand_key ON tg_cand(user_id, chain, address, tx);
  `);

  const shadows = db
    .prepare(
      `SELECT
         tg.event_id,
         tg.ingest_source,
         tg.timestamp,
         tg.user_id,
         tg.chain,
         tg.address,
         tg.tx,
         tg.token,
         tg.action,
         live.token AS live_token,
         live.action AS live_action,
         CASE
           WHEN live.token != tg.token OR live.action != tg.action THEN 'conflict'
           ELSE 'dup'
         END AS kind
       FROM tg_cand tg
       JOIN live_auth live
         ON live.user_id = tg.user_id
        AND live.chain = tg.chain
        AND live.address = tg.address
        AND live.tx = tg.tx
       ${args.conflictsOnly ? `WHERE live.token != tg.token OR live.action != tg.action` : ''}
       ORDER BY tg.timestamp DESC, tg.event_id ASC
       ${args.limit != null ? `LIMIT ${args.limit}` : ''}`
    )
    .all() as ShadowRow[];

  const byKind = { conflict: 0, dup: 0 };
  const byIngest = new Map<string, number>();
  for (const row of shadows) {
    byKind[row.kind] += 1;
    const key = row.ingest_source || '(null)';
    byIngest.set(key, (byIngest.get(key) || 0) + 1);
  }

  console.log(
    JSON.stringify(
      {
        candidates: shadows.length,
        byKind,
        byIngest: Object.fromEntries(byIngest),
        sample: shadows.slice(0, 8).map((row) => ({
          kind: row.kind,
          event_id: row.event_id,
          ingest_source: row.ingest_source,
          live: `${row.live_action}:${row.live_token}`,
          shadow: `${row.action}:${row.token}`,
          tx: row.tx,
        })),
      },
      null,
      2
    )
  );

  if (args.dry || shadows.length === 0) {
    console.log(`[shadow-cleanup] dry-run done; would delete ${shadows.length}`);
    return;
  }

  const deleteEvent = db.prepare(`DELETE FROM events WHERE event_id = ?`);
  const deleteRefs = db.prepare(`DELETE FROM event_tweet_refs WHERE event_id = ?`);

  let deleted = 0;
  const applyBatch = db.transaction((ids: string[]) => {
    for (const eventId of ids) {
      deleteRefs.run(eventId);
      deleteEvent.run(eventId);
    }
  });

  const batch: string[] = [];
  for (const row of shadows) {
    batch.push(row.event_id);
    if (batch.length >= 200) {
      applyBatch(batch.splice(0, batch.length));
      deleted += 200;
      if (deleted % 1000 === 0) {
        console.log(`[shadow-cleanup] deleted=${deleted}/${shadows.length}`);
      }
    }
  }
  if (batch.length > 0) {
    applyBatch(batch);
    deleted += batch.length;
  }

  console.log(JSON.stringify({ dry: false, deleted }, null, 2));

  // Fast residual check via rebuilt temp tables (avoid full-table CTE join).
  db.exec(`DROP TABLE IF EXISTS live_auth; DROP TABLE IF EXISTS tg_cand;`);
  db.exec(`
    CREATE TEMP TABLE live_auth AS
    SELECT user_id, chain, address, LOWER(tx_hash) AS tx,
      LOWER(COALESCE(json_extract(activity_json,'$.metadata.tokenAddress'),'')) AS token,
      LOWER(COALESCE(json_extract(activity_json,'$.metadata.txAction'),'')) AS action
    FROM events
    WHERE source='blockchain'
      AND (ingest_source LIKE 'live-monitor%' OR event_id LIKE 'live-monitor:%')
      AND tx_hash IS NOT NULL AND length(tx_hash)>0;
    CREATE INDEX tmp_live_auth_key2 ON live_auth(user_id, chain, address, tx);

    CREATE TEMP TABLE tg_cand AS
    SELECT user_id, chain, address, LOWER(tx_hash) AS tx,
      LOWER(COALESCE(json_extract(activity_json,'$.metadata.tokenAddress'),'')) AS token,
      LOWER(COALESCE(json_extract(activity_json,'$.metadata.txAction'),'')) AS action
    FROM events
    WHERE source='blockchain'
      AND (ingest_source LIKE 'telegram-monitor%' OR event_id LIKE 'xxyy-monitor:%')
      AND tx_hash IS NOT NULL AND length(tx_hash)>0
      ${sinceMs != null ? `AND timestamp >= ${sinceMs}` : ''};
    CREATE INDEX tmp_tg_cand_key2 ON tg_cand(user_id, chain, address, tx);
  `);

  const remaining = db
    .prepare(
      `SELECT
         SUM(CASE WHEN live.token != tg.token OR live.action != tg.action THEN 1 ELSE 0 END) AS conflicts,
         SUM(CASE WHEN live.token = tg.token AND live.action = tg.action THEN 1 ELSE 0 END) AS dups
       FROM tg_cand tg
       JOIN live_auth live
         ON live.user_id = tg.user_id
        AND live.chain = tg.chain
        AND live.address = tg.address
        AND live.tx = tg.tx
       ${args.conflictsOnly ? `WHERE live.token != tg.token OR live.action != tg.action` : ''}`
    )
    .get() as { conflicts: number | null; dups: number | null };

  console.log(
    JSON.stringify(
      {
        remainingConflicts: remaining.conflicts || 0,
        remainingDups: remaining.dups || 0,
      },
      null,
      2
    )
  );
}

main();
