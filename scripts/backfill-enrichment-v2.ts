// Backfill enrichment v3: AxonHub MIMO translation + quote + CA MC + vision
// Usage:
//   npx tsx scripts/backfill-enrichment-v2.ts
//   npx tsx scripts/backfill-enrichment-v2.ts --tweet-id=123
//   npx tsx scripts/backfill-enrichment-v2.ts --limit=50
//   npx tsx scripts/backfill-enrichment-v2.ts --feed-only --days=14
//   npx tsx scripts/backfill-enrichment-v2.ts --exclude-news
//   npx tsx scripts/backfill-enrichment-v2.ts --force-prod-db   # only if you accept locking prod
// Env: AXONHUB_API_KEY + AXONHUB_BASE_URL (default http://127.0.0.1:8090/v1), model mimo-v2.5
// Refuses default prod DB while pili-web / telegram workers are online (see scripts/lib/prodDbGuard.ts).

import { getDb } from '../lib/server/sqlite';
import { runTweetEnrichmentForTweetIds } from '../lib/server/twitterEnrichmentService';
import { projectTwitterTweetsToFeed } from '../lib/server/twitterFeedMapper';
import { exitIfProdDbHeavyJobBlocked } from './lib/prodDbGuard';

const BATCH_SIZE = 3;
const DELAY_MS = 500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv: string[]) {
  let tweetId: string | null = null;
  let limit: number | null = null;
  let feedOnly = false;
  let days: number | null = null;
  let excludeNews = false;
  for (const arg of argv) {
    if (arg.startsWith('--tweet-id=')) {
      tweetId = arg.slice('--tweet-id='.length).trim() || null;
    } else if (arg.startsWith('--limit=')) {
      const parsed = Number.parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
    } else if (arg === '--feed-only') {
      feedOnly = true;
    } else if (arg === '--exclude-news') {
      excludeNews = true;
    } else if (arg.startsWith('--days=')) {
      const parsed = Number.parseInt(arg.slice('--days='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) days = parsed;
    }
  }
  return { tweetId, limit, feedOnly, days, excludeNews };
}

function listNewsTwitterHandles(db: ReturnType<typeof getDb>) {
  const rows = db
    .prepare(
      `SELECT twitter, handle, name, tags_json
       FROM tracked_users
       WHERE tags_json LIKE '%news%'
          OR name LIKE '%方程%'
          OR name LIKE '%新闻%'`
    )
    .all() as Array<{ twitter?: string | null; handle?: string | null; name?: string | null }>;

  const handles = new Set<string>();
  for (const row of rows) {
    for (const value of [row.twitter, row.handle]) {
      const handle = String(value || '')
        .trim()
        .replace(/^@+/, '')
        .toLowerCase();
      if (handle) handles.add(handle);
    }
  }
  return Array.from(handles);
}

async function main() {
  exitIfProdDbHeavyJobBlocked({ jobName: 'backfill-enrichment-v2' });
  const { tweetId, limit, feedOnly, days, excludeNews } = parseArgs(process.argv.slice(2));
  const apiKey =
    (process.env.ENRICHMENT_LLM_API_KEY || '').trim() ||
    (process.env.AXONHUB_API_KEY || '').trim() ||
    (process.env.NVIDIA_API_KEY || '').trim();
  if (!apiKey) {
    console.warn('WARN: no AXONHUB_API_KEY/ENRICHMENT_LLM_API_KEY — translation will no-op; MC still runs.');
  } else {
    console.log(
      `Using model=${(process.env.ENRICHMENT_LLM_MODEL || process.env.AXONHUB_MODEL || 'mimo-v2.5').trim()} base=${(process.env.ENRICHMENT_LLM_BASE_URL || process.env.AXONHUB_BASE_URL || 'http://127.0.0.1:8090/v1').trim()}`
    );
  }

  const db = getDb();
  let pendingIds: string[] = [];
  const sinceMs = days ? Date.now() - days * 86_400_000 : null;
  const newsHandles = excludeNews ? listNewsTwitterHandles(db) : [];
  if (excludeNews) {
    console.log(
      `Excluding news users/handles: ${newsHandles.length ? newsHandles.join(', ') : '(none with twitter handle; news like 方程式 is TG-only)'}`
    );
  }

  const newsHandleFilterSql =
    newsHandles.length > 0
      ? `AND lower(COALESCE(t.author_handle, '')) NOT IN (${newsHandles.map(() => '?').join(',')})`
      : '';

  if (tweetId) {
    pendingIds = [tweetId];
  } else if (feedOnly) {
    // Feed twitter rows only; join tweets for author filter when excluding news
    const pendingRows = db
      .prepare(
        `
      SELECT REPLACE(af.activity_key, 'twitter:', '') AS tweet_id
      FROM activity_feed af
      LEFT JOIN twitter_tweets t
        ON t.tweet_id = REPLACE(af.activity_key, 'twitter:', '')
      LEFT JOIN twitter_tweet_enrichments e
        ON e.tweet_id = REPLACE(af.activity_key, 'twitter:', '')
      WHERE af.source = 'twitter'
        AND (? IS NULL OR af.timestamp >= ?)
        ${newsHandleFilterSql}
        AND (
          e.tweet_id IS NULL
          OR e.translator_version IS NULL
          OR e.translator_version != 'model-v3'
          OR e.translation_status IN ('pending', 'failed')
        )
      ORDER BY af.timestamp DESC
      ${limit ? `LIMIT ${Math.floor(limit)}` : ''}
    `
      )
      .all(sinceMs, sinceMs, ...newsHandles) as Array<{ tweet_id: string }>;
    pendingIds = pendingRows.map((r) => r.tweet_id).filter(Boolean);
  } else {
    // Full twitter_tweets corpus (social only when --exclude-news)
    const pendingRows = db
      .prepare(
        `
      SELECT t.tweet_id
      FROM twitter_tweets t
      LEFT JOIN twitter_tweet_enrichments e ON t.tweet_id = e.tweet_id
      WHERE (? IS NULL OR t.created_at_ms >= ?)
        ${newsHandleFilterSql}
        AND (
          e.tweet_id IS NULL
          OR e.translator_version IS NULL
          OR e.translator_version != 'model-v3'
          OR e.translation_status IN ('pending', 'failed')
        )
      ORDER BY t.created_at_ms DESC
      ${limit ? `LIMIT ${Math.floor(limit)}` : ''}
    `
      )
      .all(sinceMs, sinceMs, ...newsHandles) as Array<{ tweet_id: string }>;
    pendingIds = pendingRows.map((r) => r.tweet_id);
  }

  console.log(
    `Found ${pendingIds.length} tweets needing model-v3 enrichment` +
      (feedOnly ? ' (feed-only)' : ' (full twitter corpus)') +
      (days ? ` (last ${days}d)` : '') +
      (excludeNews ? ' (exclude-news)' : '')
  );

  let succeeded = 0;
  let failed = 0;
  let batches = 0;

  for (let i = 0; i < pendingIds.length; i += BATCH_SIZE) {
    const batch = pendingIds.slice(i, i + BATCH_SIZE);
    batches += 1;
    console.log(
      `Batch ${batches}: enriching ${batch.length} tweets (${i + 1}-${i + batch.length}/${pendingIds.length})...`
    );

    try {
      const result = await runTweetEnrichmentForTweetIds({ tweetIds: batch });
      succeeded += result.succeeded;
      failed += result.failed;
      console.log(`  Result: ${result.succeeded} succeeded, ${result.failed} failed`);

      projectTwitterTweetsToFeed({ sinceMs: 0, tweetIds: batch });
      console.log(`  Re-projected ${batch.length} tweets to feed`);
    } catch (err) {
      console.error(`  Batch failed:`, err instanceof Error ? err.message : err);
      failed += batch.length;
    }

    if (i + BATCH_SIZE < pendingIds.length) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`\nDone! ${succeeded} succeeded, ${failed} failed out of ${pendingIds.length} total`);
}

void main();
