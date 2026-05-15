import './server-only-shim.cjs';

import { readEventsFeed } from '@/lib/server/eventsRepo';

function summarizeMatchTypes(feed: ReturnType<typeof readEventsFeed>['feed']) {
  let actionLabelMatch = 0;
  let contentMatch = 0;
  for (const row of feed) {
    const hit = row.activity.metadata.txActionLabel === '建仓';
    const contentHit = (row.activity.content || '').includes('建仓');
    if (hit) actionLabelMatch += 1;
    if (contentHit) contentMatch += 1;
  }
  return { actionLabelMatch, contentMatch };
}

function run() {
  // Warm up: cold start pays for schema migration / index bootstrap.
  const warmupStart = Date.now();
  readEventsFeed({ limit: 1, q: '建仓' });
  const warmupMs = Date.now() - warmupStart;

  const t0 = Date.now();
  const result = readEventsFeed({ limit: 200, q: '建仓' });
  const elapsedMs = Date.now() - t0;

  const { actionLabelMatch, contentMatch } = summarizeMatchTypes(result.feed);

  const sortedTimestamps = result.feed
    .map((row) => row.activity.timestamp)
    .filter((value) => Number.isFinite(value));
  const newest = sortedTimestamps.length > 0 ? Math.max(...sortedTimestamps) : null;
  const oldest = sortedTimestamps.length > 0 ? Math.min(...sortedTimestamps) : null;

  console.log('readEventsFeed action search timing & shape:');
  console.log(`  warmup cold start: ${warmupMs}ms (schema/index bootstrap)`);
  console.log(`  q="建仓" returned ${result.feed.length} rows in ${elapsedMs}ms (total=${result.total})`);
  console.log(`  matches: txActionLabel='建仓' ${actionLabelMatch} / content contains '建仓' ${contentMatch}`);
  if (newest && oldest) {
    console.log(
      `  newest=${new Date(newest).toISOString()} oldest=${new Date(oldest).toISOString()}`
    );
  }

  if (elapsedMs > 1000) {
    throw new Error(`server-side action search slower than 1s: ${elapsedMs}ms`);
  }
  if (result.feed.length === 0) {
    throw new Error('expected at least one row for q="建仓"');
  }
  if (actionLabelMatch + contentMatch === 0) {
    throw new Error('returned rows match neither txActionLabel=="建仓" nor content contains "建仓"');
  }

  const fallback = readEventsFeed({ limit: 50, q: 'alice' });
  console.log(`  fallback q="alice" returned ${fallback.feed.length} rows total=${fallback.total} (sanity check for FTS path)`);

  if (fallback.feed.length === 0) {
    console.log('  (no rows matched "alice"; FTS fallback path still loaded without errors)');
  }

  const socialOnly = readEventsFeed({ limit: 50, q: '建仓', source: 'twitter' });
  const socialContentMatches = socialOnly.feed.filter((row) => (row.activity.content || '').includes('建仓')).length;
  console.log(
    `  q="建仓" + source=twitter returned ${socialOnly.feed.length} rows; ${socialContentMatches} have "建仓" in content (verifies content LIKE branch fires)`
  );
  if (socialOnly.feed.length > 0 && socialContentMatches === 0) {
    throw new Error('expected at least one twitter row whose content contains "建仓"');
  }

  console.log('events action search smoke test: ok');
}

run();
