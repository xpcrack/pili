import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getDb } from '@/lib/server/sqlite';
import { readEventsFeed, readLatestActivityAtByUser } from '@/lib/server/eventsRepo';
import {
  buildCompletenessWindow,
  computeTwitterBackfillWindowDays,
  readActivityBreakdownByUser,
  resolveUnifiedWindowStartMs,
  resolveTwitterCoverageStartMs,
} from '@/lib/server/feedViewMeta';

const TOKEN_ADDRESS_ONLY_CA = 'CJUrENDAuSm4FxxziUgftnUJqqXjm4VL1zhJgwXupump';
const require = createRequire(import.meta.url);

function runRebuildPathRegression() {
  const repoRoot = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), 'pilipili-events-fts-'));
  const dbPath = join(tempDir, 'rebuild.sqlite');
  const seedScriptPath = join(tempDir, 'seed.ts');
  const rebuildScriptPath = join(tempDir, 'rebuild.ts');
  const tsxCliPath = require.resolve('tsx/cli');
  const sqliteModulePath = join(repoRoot, 'lib/server/sqlite.ts');
  const eventsRepoPath = join(repoRoot, 'lib/server/eventsRepo.ts');
  const shimPath = join(repoRoot, 'scripts/server-only-shim.cjs');

  writeFileSync(
    seedScriptPath,
    `
import assert from 'node:assert/strict';
import { getDb } from ${JSON.stringify(sqliteModulePath)};

const db = getDb();
db.prepare("DELETE FROM events WHERE event_id = 'test-rebuild:1'").run();
db.prepare(
  \`INSERT INTO events (
    event_id, source, kind, timestamp, user_id, user_name, chain, address, content, url, action, token, tweet_id, tx_hash, ingest_source, dedup_key, metadata_json, payload_json, user_json, activity_json, indexed_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`
).run(
  'test-rebuild:1',
  'test-source',
  'transfer',
  1714104000000,
  'rebuild-user',
  'Rebuild User',
  'solana',
  'tracked-wallet-rebuild',
  'rebuild token address event',
  null,
  'buy',
  'HENRY',
  null,
  'rebuild-tx-1',
  'test-source',
  'test-rebuild:1',
  JSON.stringify({
    token: 'HENRY',
    chain: 'solana',
    tokenAddress: ${JSON.stringify(TOKEN_ADDRESS_ONLY_CA)},
    trackedAddress: 'tracked-wallet-rebuild',
    txHash: 'rebuild-tx-1',
    txAction: 'buy',
  }),
  '{}',
  JSON.stringify({
    id: 'rebuild-user',
    name: 'Rebuild User',
    handle: 'rebuild-user',
    avatar: '',
    addresses: [],
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
  }),
  JSON.stringify({
    id: 'test-rebuild-a1',
    userId: 'rebuild-user',
    source: 'blockchain',
    type: 'transfer',
    title: 'rebuild token address event',
    content: 'rebuild token address event',
    timestamp: 1714104000000,
    metadata: {
      token: 'HENRY',
      chain: 'solana',
      tokenAddress: ${JSON.stringify(TOKEN_ADDRESS_ONLY_CA)},
      trackedAddress: 'tracked-wallet-rebuild',
      txHash: 'rebuild-tx-1',
      txAction: 'buy',
    },
  }),
  1714104000000,
  1714104000000,
  1714104000000
);

db.prepare("DELETE FROM app_state WHERE key IN ('events_fts_address_index_v2', 'events_fts_metadata_index_v3')").run();
db.prepare("INSERT INTO events_fts(events_fts) VALUES ('delete-all')").run();
db.prepare(
  \`INSERT INTO events_fts(rowid, event_id, content, token, address, reference, user_name)
   SELECT rowid,
          event_id,
          content,
          coalesce(token, ''),
          coalesce(address, ''),
          coalesce(tweet_id, coalesce(tx_hash, coalesce(url, ''))),
          coalesce(user_name, '')
   FROM events
   WHERE event_id = 'test-rebuild:1'\`
).run();

const brokenMatches = db.prepare("SELECT count(1) AS count FROM events_fts WHERE events_fts MATCH ?").get(${JSON.stringify(
      TOKEN_ADDRESS_ONLY_CA
    )}) as { count: number };
assert.equal(brokenMatches.count, 0);
`
  );

  writeFileSync(
    rebuildScriptPath,
    `
import assert from 'node:assert/strict';
import { readEventsFeed } from ${JSON.stringify(eventsRepoPath)};

const result = readEventsFeed({ limit: 10, source: 'test-source', q: ${JSON.stringify(TOKEN_ADDRESS_ONLY_CA)} });
assert.equal(
  result.total,
  1,
  'FTS rebuild should repair tokenAddress-only search hits for pre-existing rows'
);
`
  );

  try {
    execFileSync(process.execPath, [tsxCliPath, seedScriptPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: `--require ${shimPath}`,
        PILIPILI_DB_PATH: dbPath,
      },
      stdio: 'pipe',
    });

    execFileSync(process.execPath, [tsxCliPath, rebuildScriptPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: `--require ${shimPath}`,
        PILIPILI_DB_PATH: dbPath,
      },
      stdio: 'pipe',
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function run() {
  const db = getDb();
  const now = new Date('2026-04-23T04:00:00.000Z').getTime();

  const userId1 = 'test-feed-total-user-1';
  const userId2 = 'test-feed-total-user-2';

  db.prepare("DELETE FROM events WHERE event_id LIKE 'test-feed-total:%'").run();
  db.prepare("DELETE FROM activity_feed WHERE activity_key LIKE 'test-feed-total:%'").run();

  const insert = db.prepare(
    `INSERT INTO events (
      event_id,
      source,
      kind,
      timestamp,
      user_id,
      user_name,
      chain,
      address,
      content,
      url,
      action,
      token,
      tweet_id,
      tx_hash,
      ingest_source,
      dedup_key,
      metadata_json,
      payload_json,
      user_json,
      activity_json,
      indexed_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertFeed = db.prepare(
    `INSERT INTO activity_feed (
      user_id,
      activity_key,
      timestamp,
      tx_hash_lower,
      chain,
      tracked_address_lower,
      source,
      type,
      user_json,
      activity_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const makeUser = (id: string, name: string) =>
    JSON.stringify({
      id,
      name,
      handle: id,
      avatar: '',
      addresses: [],
      totalAssetUsd: 0,
      historicalMaxAssetUsd: 0,
      assetUpdatedAt: null,
      tags: [],
    });

  const makeActivity = (
    activityId: string,
    userId: string,
    source: 'twitter' | 'blockchain',
    token: string,
    content: string,
    metadataOverrides: Record<string, unknown> = {}
  ) =>
    JSON.stringify({
      id: activityId,
      userId,
      source,
      type: source === 'twitter' ? 'post' : 'transfer',
      title: content,
      content,
      timestamp: now,
      metadata: {
        token,
        chain: source === 'twitter' ? undefined : 'bsc',
        ...metadataOverrides,
      },
    });

  insert.run(
    'test-feed-total:1',
    'test-source',
    'post',
    now - 3000,
    userId1,
    'Alice',
    null,
    null,
    'alpha keyword one',
    null,
    null,
    'ALPHA',
    'tweet-test-1',
    null,
    'test-source',
    'test-feed-total:1',
    '{}',
    '{}',
    makeUser(userId1, 'Alice'),
    makeActivity('test-feed-total-a1', userId1, 'twitter', 'ALPHA', 'alpha keyword one'),
    now,
    now,
    now
  );
  insertFeed.run(
    userId1,
    'test-feed-total:1',
    now - 3000,
    null,
    null,
    null,
    'twitter',
    'post',
    makeUser(userId1, 'Alice'),
    makeActivity('test-feed-total-a1', userId1, 'twitter', 'ALPHA', 'alpha keyword one'),
    now
  );

  insert.run(
    'test-feed-total:2',
    'test-source',
    'post',
    now - 2000,
    userId2,
    'Bob',
    null,
    null,
    'beta keyword two',
    null,
    null,
    'BETA',
    'tweet-test-2',
    null,
    'test-source',
    'test-feed-total:2',
    '{}',
    '{}',
    makeUser(userId2, 'Bob'),
    makeActivity('test-feed-total-a2', userId2, 'twitter', 'BETA', 'beta keyword two'),
    now,
    now,
    now
  );
  insertFeed.run(
    userId2,
    'test-feed-total:2',
    now - 2000,
    null,
    null,
    null,
    'twitter',
    'post',
    makeUser(userId2, 'Bob'),
    makeActivity('test-feed-total-a2', userId2, 'twitter', 'BETA', 'beta keyword two'),
    now
  );

  insert.run(
    'test-feed-total:3',
    'test-source',
    'transfer',
    now - 1000,
    userId1,
    'Alice',
    'bsc',
    '0xabc',
    'alpha chain transfer',
    null,
    'buy',
    'ALPHA',
    null,
    '0xtx3',
    'test-source',
    'test-feed-total:3',
    '{}',
    '{}',
    makeUser(userId1, 'Alice'),
    makeActivity('test-feed-total-a3', userId1, 'blockchain', 'ALPHA', 'alpha chain transfer'),
    now,
    now,
    now
  );
  insertFeed.run(
    userId1,
    'test-feed-total:3',
    now - 1000,
    '0xtx3',
    'bsc',
    '0xabc',
    'blockchain',
    'transfer',
    makeUser(userId1, 'Alice'),
    makeActivity('test-feed-total-a3', userId1, 'blockchain', 'ALPHA', 'alpha chain transfer'),
    now
  );

  insert.run(
    'test-feed-total:4',
    'test-source',
    'transfer',
    now - 500,
    userId1,
    'Alice',
    'solana',
    'tracked-wallet-1',
    'henry launch trade',
    null,
    'buy',
    'HENRY',
    null,
    'solana-tx-1',
    'test-source',
    'test-feed-total:4',
    JSON.stringify({
      token: 'HENRY',
      chain: 'solana',
      tokenAddress: TOKEN_ADDRESS_ONLY_CA,
      trackedAddress: 'tracked-wallet-1',
      txHash: 'solana-tx-1',
      txAction: 'buy',
    }),
    '{}',
    makeUser(userId1, 'Alice'),
    makeActivity('test-feed-total-a4', userId1, 'blockchain', 'HENRY', 'henry launch trade', {
      tokenAddress: TOKEN_ADDRESS_ONLY_CA,
      trackedAddress: 'tracked-wallet-1',
      txHash: 'solana-tx-1',
      txAction: 'buy',
    }),
    now,
    now,
    now
  );
  insertFeed.run(
    userId1,
    'test-feed-total:4',
    now - 500,
    'solana-tx-1',
    'solana',
    'tracked-wallet-1',
    'blockchain',
    'transfer',
    makeUser(userId1, 'Alice'),
    makeActivity('test-feed-total-a4', userId1, 'blockchain', 'HENRY', 'henry launch trade', {
      tokenAddress: TOKEN_ADDRESS_ONLY_CA,
      trackedAddress: 'tracked-wallet-1',
      txHash: 'solana-tx-1',
      txAction: 'buy',
    }),
    now
  );

  insert.run(
    'test-feed-total:5',
    'test-source',
    'post',
    now - 3500,
    userId2,
    'Bob',
    null,
    null,
    'plain unrelated tweet body',
    null,
    null,
    null,
    'tweet-test-5',
    null,
    'test-source',
    'test-feed-total:5',
    JSON.stringify({
      tweetId: 'tweet-test-5',
      mentionedTickers: ['MOON'],
      mentionedTokenAddresses: ['0xmoonca'],
      tokenSentiments: [
        {
          tokenSymbol: 'MOON',
          tokenAddress: '0xmoonca',
          chain: 'base',
          sentiment: 'positive',
          matchSource: 'both',
        },
      ],
    }),
    '{}',
    makeUser(userId2, 'Bob'),
    makeActivity('test-feed-total-a5', userId2, 'twitter', '', 'plain unrelated tweet body', {
      tweetId: 'tweet-test-5',
      mentionedTickers: ['MOON'],
      mentionedTokenAddresses: ['0xmoonca'],
      tokenSentiments: [
        {
          tokenSymbol: 'MOON',
          tokenAddress: '0xmoonca',
          chain: 'base',
          sentiment: 'positive',
          matchSource: 'both',
        },
      ],
    }),
    now,
    now,
    now
  );
  insertFeed.run(
    userId2,
    'test-feed-total:5',
    now - 3500,
    null,
    null,
    null,
    'twitter',
    'post',
    makeUser(userId2, 'Bob'),
    makeActivity('test-feed-total-a5', userId2, 'twitter', '', 'plain unrelated tweet body', {
      tweetId: 'tweet-test-5',
      mentionedTickers: ['MOON'],
      mentionedTokenAddresses: ['0xmoonca'],
      tokenSentiments: [
        {
          tokenSymbol: 'MOON',
          tokenAddress: '0xmoonca',
          chain: 'base',
          sentiment: 'positive',
          matchSource: 'both',
        },
      ],
    }),
    now
  );

  insert.run(
    'test-feed-total:6',
    'test-source',
    'transfer',
    now - 4500,
    userId2,
    'Profit',
    'ethereum',
    '0xprofit',
    'upegstr opening trade',
    null,
    'buy',
    'UPEGSTR',
    null,
    '0xtx6',
    'test-source',
    'test-feed-total:6',
    JSON.stringify({
      token: 'UPEGSTR',
      chain: 'ethereum',
      tokenAddress: '0xupegstr',
      trackedAddress: '0xprofit',
      txHash: '0xtx6',
      txAction: 'buy',
    }),
    '{}',
    makeUser(userId2, 'Profit'),
    makeActivity('test-feed-total-a6', userId2, 'blockchain', 'UPEGSTR', 'upegstr opening trade', {
      tokenAddress: '0xupegstr',
      trackedAddress: '0xprofit',
      txHash: '0xtx6',
      txAction: 'buy',
    }),
    now,
    now,
    now
  );
  insertFeed.run(
    userId2,
    'test-feed-total:6',
    now - 4500,
    '0xtx6',
    'ethereum',
    '0xprofit',
    'blockchain',
    'transfer',
    makeUser(userId2, 'Profit'),
    makeActivity('test-feed-total-a6', userId2, 'blockchain', 'UPEGSTR', 'upegstr opening trade', {
      tokenAddress: '0xupegstr',
      trackedAddress: '0xprofit',
      txHash: '0xtx6',
      txAction: 'buy',
    }),
    now
  );

  const filteredBySourceAndUser = readEventsFeed({
    limit: 50,
    source: 'test-source',
    userId: userId1,
  });
  assert.equal(filteredBySourceAndUser.total, 3);

  const latestByUser = readLatestActivityAtByUser();
  assert.ok((latestByUser[userId1] ?? 0) > 0);
  assert.ok((latestByUser[userId2] ?? 0) > 0);
  assert.ok((latestByUser[userId1] ?? 0) >= (latestByUser[userId2] ?? 0));

  const userBreakdown = readActivityBreakdownByUser(userId1);
  assert.deepEqual(userBreakdown, {
    twitterCount: 1,
    tradeCount: 2,
  });

  const globalWindow = buildCompletenessWindow({
    scope: 'global',
    endMs: now,
    windowState: {
      globalEarliestMs: now - 7 * 24 * 60 * 60 * 1000,
      perUserEarliestMs: {
        [userId1]: now - 2 * 24 * 60 * 60 * 1000,
      },
      perUserHistoryComplete: {
        [userId1]: false,
      },
      perUserLastBackfillAt: {},
      perUserLocalQualifiedCount: {},
      globalAlignment: 'partial',
      updatedAt: now,
    },
  });
  assert.equal(globalWindow.scope, 'global');
  assert.equal(globalWindow.startMs, now - 7 * 24 * 60 * 60 * 1000);
  assert.equal(globalWindow.endMs, now);
  assert.equal(globalWindow.complete, false);
  assert.equal(globalWindow.label, '2026-04-16 12:00');

  const userWindow = buildCompletenessWindow({
    scope: 'user',
    userId: userId1,
    endMs: now,
    windowState: {
      globalEarliestMs: now - 7 * 24 * 60 * 60 * 1000,
      perUserEarliestMs: {
        [userId1]: now - 2 * 24 * 60 * 60 * 1000,
      },
      perUserHistoryComplete: {
        [userId1]: false,
      },
      perUserLastBackfillAt: {},
      perUserLocalQualifiedCount: {},
      globalAlignment: 'aligned',
      updatedAt: now,
    },
  });
  assert.equal(userWindow.scope, 'user');
  assert.equal(userWindow.startMs, now - 2 * 24 * 60 * 60 * 1000);
  assert.equal(userWindow.endMs, now);
  assert.equal(userWindow.complete, true);
  assert.equal(userWindow.label, '2026-04-21 12:00');

  assert.equal(
    resolveUnifiedWindowStartMs(now - 7 * 24 * 60 * 60 * 1000, [now - 2 * 24 * 60 * 60 * 1000]),
    now - 2 * 24 * 60 * 60 * 1000
  );
  assert.equal(resolveUnifiedWindowStartMs(now - 7 * 24 * 60 * 60 * 1000, [null]), null);
  assert.equal(computeTwitterBackfillWindowDays(now - 10 * 24 * 60 * 60 * 1000, now), 10);
  assert.equal(computeTwitterBackfillWindowDays(now - 33 * 24 * 60 * 60 * 1000, now), 30);
  assert.equal(computeTwitterBackfillWindowDays(null, now), 7);
  assert.equal(
    resolveTwitterCoverageStartMs([
      { lane: 'timeline', coveredSinceMs: now - 10 * 24 * 60 * 60 * 1000 },
      { lane: 'replies', coveredSinceMs: now - 8 * 24 * 60 * 60 * 1000 },
    ]),
    now - 8 * 24 * 60 * 60 * 1000
  );
  assert.equal(
    resolveTwitterCoverageStartMs([
      { lane: 'timeline', coveredSinceMs: now - 10 * 24 * 60 * 60 * 1000 },
      { lane: 'replies', coveredSinceMs: null },
    ]),
    null
  );

  const incompleteByTwitterWindow = buildCompletenessWindow({
    scope: 'user',
    userId: userId1,
    endMs: now,
    requiredSourceStarts: [null],
    windowState: {
      globalEarliestMs: now - 7 * 24 * 60 * 60 * 1000,
      perUserEarliestMs: {
        [userId1]: now - 7 * 24 * 60 * 60 * 1000,
      },
      perUserHistoryComplete: {
        [userId1]: true,
      },
      perUserLastBackfillAt: {},
      perUserLocalQualifiedCount: {},
      globalAlignment: 'aligned',
      updatedAt: now,
    },
  });
  assert.equal(incompleteByTwitterWindow.startMs, null);
  assert.equal(incompleteByTwitterWindow.complete, false);
  assert.equal(incompleteByTwitterWindow.label, null);

  const filteredBySearch = readEventsFeed({
    limit: 50,
    source: 'test-source',
    q: 'alpha',
  });
  assert.equal(filteredBySearch.total, 2);

  const filteredByTokenAddress = readEventsFeed({
    limit: 50,
    source: 'test-source',
    q: TOKEN_ADDRESS_ONLY_CA,
  });
  assert.equal(
    filteredByTokenAddress.total,
    1,
    'search should match blockchain activity metadata.tokenAddress values via the FTS index'
  );

  const filteredByMentionedTicker = readEventsFeed({
    limit: 50,
    source: 'test-source',
    q: 'moon',
  });
  assert.equal(
    filteredByMentionedTicker.feed.some((item) => item.activity.metadata.tweetId === 'tweet-test-5'),
    true,
    'search should match enrichment-only mentioned tickers for twitter activities'
  );

  const filteredByMentionedTokenAddress = readEventsFeed({
    limit: 50,
    source: 'test-source',
    q: '0xmoonca',
  });
  assert.equal(
    filteredByMentionedTokenAddress.feed.some((item) => item.activity.metadata.tweetId === 'tweet-test-5'),
    true,
    'search should match enrichment-only mentioned token addresses for twitter activities'
  );

  const filteredByTokenPrefix = readEventsFeed({
    limit: 50,
    source: 'test-source',
    q: 'upeg',
  });
  assert.equal(
    filteredByTokenPrefix.feed.some((item) => item.activity.metadata.token === 'UPEGSTR'),
    true,
    'plain token search should match token prefixes such as UPEGSTR'
  );

  const filteredByChainAndSearch = readEventsFeed({
    limit: 50,
    source: 'test-source',
    chain: 'bsc',
    q: 'alpha',
  });
  assert.equal(filteredByChainAndSearch.total, 1);

  const filteredByUserName = readEventsFeed({
    limit: 1,
    source: 'test-source',
    q: 'alice',
  });
  assert.equal(filteredByUserName.total, 3);
  assert.equal(filteredByUserName.feed.length, 1);
  assert.equal(filteredByUserName.hasMore, true);

  const filteredByUserNamePage2 = readEventsFeed({
    limit: 1,
    source: 'test-source',
    q: 'alice',
    cursor: filteredByUserName.nextCursor,
  });
  assert.equal(filteredByUserNamePage2.total, 2);
  assert.equal(filteredByUserNamePage2.feed.length, 1);
  assert.equal(filteredByUserNamePage2.hasMore, true);

  const page1 = readEventsFeed({
    limit: 1,
    source: 'test-source',
    userId: userId1,
  });
  assert.equal(page1.total, 3);
  assert.equal(page1.feed.length, 1);

  const page2 = readEventsFeed({
    limit: 1,
    source: 'test-source',
    userId: userId1,
    cursor: page1.nextCursor,
  });
  assert.equal(page2.total, 2);

  runRebuildPathRegression();

  db.prepare("DELETE FROM events WHERE event_id LIKE 'test-feed-total:%'").run();
  db.prepare("DELETE FROM activity_feed WHERE activity_key LIKE 'test-feed-total:%'").run();

  console.log('events feed total tests: ok');
}

run();
