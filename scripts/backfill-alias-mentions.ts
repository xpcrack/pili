// Backfill alias-based token mentions for monitored KOLs' recent tweets.
// Re-runs enrichment so token name/alias (e.g. $Z ← "gen z" / "Z世代") gets recognized.
// Only touches tweets by monitored KOLs whose text actually contains a configured alias.
//
// Usage:
//   npx tsx scripts/backfill-alias-mentions.ts
//   npx tsx scripts/backfill-alias-mentions.ts --days=30
//   npx tsx scripts/backfill-alias-mentions.ts --dry
//   npx tsx scripts/backfill-alias-mentions.ts --force-prod-db   # only if you accept locking prod
//
// Env: AXONHUB_API_KEY + AXONHUB_BASE_URL (or ENRICHMENT_LLM_*); reads .env.local automatically.
// Refuses default prod DB while pili-web / telegram workers are online (scripts/lib/prodDbGuard.ts).

import fs from 'node:fs';
import path from 'node:path';

import { getDb } from '../lib/server/sqlite';
import { listMonitoredUsers } from '../lib/server/trackedUsersRepo';
import { runTweetEnrichmentForTweetIds } from '../lib/server/twitterEnrichmentService';
import { projectTwitterTweetsToFeed } from '../lib/server/twitterFeedMapper';
import { findAliasHits } from '../lib/server/tokenAliases';
import { normalizeTwitterHandle } from '../lib/canonical';
import { exitIfProdDbHeavyJobBlocked } from './lib/prodDbGuard';

/** No dotenv dep — load .env.local ourselves so manual `tsx` runs have API keys. */
function loadEnvLocal() {
  const envPath = path.join(process.cwd(), '.env.local');
  let txt: string;
  try {
    txt = fs.readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

loadEnvLocal();

const BATCH_SIZE = 3;
const DELAY_MS = 500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv: string[]) {
  let days = 30;
  let dry = false;
  for (const arg of argv) {
    if (arg.startsWith('--days=')) {
      const n = Number.parseInt(arg.slice('--days='.length), 10);
      if (Number.isFinite(n) && n > 0) days = n;
    } else if (arg === '--dry') {
      dry = true;
    }
  }
  return { days, dry };
}

async function main() {
  exitIfProdDbHeavyJobBlocked({ jobName: 'backfill-alias-mentions' });
  const { days, dry } = parseArgs(process.argv.slice(2));

  const handles = new Set<string>();
  for (const user of listMonitoredUsers()) {
    const h = normalizeTwitterHandle(user.twitter || '').trim().toLowerCase();
    if (h) handles.add(h);
  }
  if (handles.size === 0) {
    console.log('no monitored KOL handles found; nothing to do');
    return;
  }
  if (findAliasHits('probe').length === 0 && findAliasHits('gen z').length === 0) {
    console.log('no token aliases configured in .data/token-aliases.json; nothing to do');
    return;
  }

  const cutoff = Date.now() - days * 86_400_000;
  const db = getDb();
  const placeholders = Array.from(handles).map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT tweet_id, full_text
       FROM twitter_tweets
       WHERE lower(author_handle) IN (${placeholders}) AND created_at_ms >= ?`,
    )
    .all(...Array.from(handles), cutoff) as Array<{ tweet_id: string; full_text: string }>;

  const targets = rows
    .filter((r) => findAliasHits(r.full_text || '').length > 0)
    .map((r) => r.tweet_id);

  console.log(
    `monitored KOLs=${handles.size} | tweets(last ${days}d)=${rows.length} | with alias hit=${targets.length}`,
  );
  if (dry || targets.length === 0) return;

  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    const res = await runTweetEnrichmentForTweetIds({ tweetIds: batch });
    succeeded += res.succeeded;
    failed += res.failed;
    try {
      projectTwitterTweetsToFeed({ sinceMs: 0, tweetIds: batch });
    } catch (err) {
      console.warn('[backfill-alias] project failed:', err instanceof Error ? err.message : err);
    }
    console.log(`batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(targets.length / BATCH_SIZE)}: +${res.succeeded} ok`);
    await sleep(DELAY_MS);
  }
  console.log(`done: succeeded=${succeeded} failed=${failed} of ${targets.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
