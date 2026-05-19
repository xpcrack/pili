// One-time script to backfill enrichment for existing tweets
// Usage: NVIDIA_API_KEY=xxx npx tsx scripts/backfill-enrichment.ts

import { getDb } from '../lib/server/sqlite';
import { runTweetEnrichmentForTweetIds } from '../lib/server/twitterEnrichmentService';
import { projectTwitterTweetsToFeed } from '../lib/server/twitterFeedMapper';

const BATCH_SIZE = 10; // small batches to avoid rate limiting
const DELAY_MS = 2000; // 2s between batches

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const apiKey = (process.env.NVIDIA_API_KEY || '').trim();
  if (!apiKey) {
    console.error('ERROR: NVIDIA_API_KEY not set. Aborting.');
    process.exit(1);
  }

  const db = getDb();

  // Find tweets that haven't been successfully enriched
  const pendingRows = db.prepare(`
    SELECT t.tweet_id
    FROM twitter_tweets t
    LEFT JOIN twitter_tweet_enrichments e ON t.tweet_id = e.tweet_id
    WHERE e.tweet_id IS NULL OR e.translation_status = 'pending' OR e.translation_status = 'failed'
    ORDER BY t.created_at_ms DESC
  `).all() as Array<{ tweet_id: string }>;

  const pendingIds = pendingRows.map(r => r.tweet_id);
  console.log(`Found ${pendingIds.length} tweets needing enrichment`);

  let succeeded = 0;
  let failed = 0;
  let batches = 0;

  for (let i = 0; i < pendingIds.length; i += BATCH_SIZE) {
    const batch = pendingIds.slice(i, i + BATCH_SIZE);
    batches += 1;
    console.log(`Batch ${batches}: enriching ${batch.length} tweets (${i + 1}-${i + batch.length}/${pendingIds.length})...`);

    try {
      const result = await runTweetEnrichmentForTweetIds({ tweetIds: batch });
      succeeded += result.succeeded;
      failed += result.failed;
      console.log(`  Result: ${result.succeeded} succeeded, ${result.failed} failed`);

      // Re-project successfully enriched tweets to update feed
      if (result.succeeded > 0) {
        const enrichedIds = batch.slice(0, result.succeeded);
        projectTwitterTweetsToFeed({ sinceMs: 0, tweetIds: enrichedIds });
        console.log(`  Re-projected ${enrichedIds.length} enriched tweets to feed`);
      }
    } catch (err) {
      console.error(`  Batch failed:`, err instanceof Error ? err.message : err);
      failed += batch.length;
    }

    // Rate limit: pause between batches
    if (i + BATCH_SIZE < pendingIds.length) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`\nDone! ${succeeded} succeeded, ${failed} failed out of ${pendingIds.length} total`);
}

void main();
