import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Activity } from '@/types';

import { extractTweetTokenMentions } from '../lib/twitter/extractTweetTokenMentions';

import './server-only-shim.cjs';

async function runSchemaTest() {
  const { getDb } = await import('../lib/server/sqlite');
  const {
    upsertTwitterTweetEnrichment,
    replaceTwitterTweetTokenMentions,
    listTwitterTweetTokenMentions,
    upsertEventTweetRef,
    listEventTweetRefsByTweetId,
  } = await import('../lib/server/twitterEnrichmentRepo');

  const db = getDb();
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('twitter_tweet_enrichments','twitter_tweet_token_mentions','event_tweet_refs')"
    )
    .all() as Array<{ name: string }>;

  assert.deepEqual(
    tables.map((row) => row.name).sort(),
    ['event_tweet_refs', 'twitter_tweet_enrichments', 'twitter_tweet_token_mentions']
  );

  upsertTwitterTweetEnrichment({
    tweetId: 'tweet-schema-1',
    translationZh: '测试翻译',
    translationStatus: 'succeeded',
    extractionStatus: 'succeeded',
    extractorVersion: 'rule-v1',
    translatorVersion: 'model-v1',
    lastProcessedAtMs: 1_700_000_000_000,
    lastError: null,
  });

  replaceTwitterTweetTokenMentions({
    tweetId: 'tweet-schema-1',
    mentions: [
      {
        tokenAddress: '0xabc',
        tokenSymbol: 'ABC',
        chain: 'bsc',
        matchSource: 'both',
        sentiment: 'positive',
        confidence: 0.9,
        rankInTweet: 1,
      },
    ],
  });

  upsertEventTweetRef({
    eventId: 'event-1',
    tweetId: 'tweet-schema-1',
    refSource: 'telegram-monitor',
    discoveredAtMs: 1_700_000_000_001,
  });

  assert.equal(listTwitterTweetTokenMentions('tweet-schema-1').length, 1);
  assert.equal(listEventTweetRefsByTweetId('tweet-schema-1').length, 1);
  console.log('PASS twitter enrichment schema + repo');
}

function testExtractTweetTokenMentions() {
  const mentions = extractTweetTokenMentions(
    'Adding more size on $ABC. CA: 0x1234567890abcdef1234567890abcdef12345678 but staying neutral on $XYZ.'
  );

  assert.deepEqual(
    mentions.map((item) => ({
      tokenSymbol: item.tokenSymbol,
      tokenAddress: item.tokenAddress,
      matchSource: item.matchSource,
    })),
    [
      { tokenSymbol: 'ABC', tokenAddress: '0x1234567890abcdef1234567890abcdef12345678', matchSource: 'both' },
      { tokenSymbol: 'XYZ', tokenAddress: null, matchSource: 'ticker' },
    ]
  );
}

async function testEnrichmentProjectionMetadata() {
  const { getDb } = await import('../lib/server/sqlite');
  const { upsertTwitterTweets } = await import('../lib/server/twitterRepo');
  const { runTweetEnrichmentForTweetIds } = await import('../lib/server/twitterEnrichmentService');
  const { projectTwitterTweetsToFeed } = await import('../lib/server/twitterFeedMapper');
  const { readEventsFeed } = await import('../lib/server/eventsRepo');

  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO tracked_users (
      id,
      name,
      handle,
      avatar,
      twitter,
      telegram,
      tags_json,
      total_asset_usd,
      historical_max_asset_usd,
      asset_updated_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, '', ?, null, '[]', 0, 0, null, ?, ?)`
  ).run('user-enrichment-1', 'Twitter Enrichment User', 'enrichment-user', 'testtwittersyncuser', now, now);

  upsertTwitterTweets([
    {
      tweetId: 'tweet-enrichment-1',
      authorHandle: 'testtwittersyncuser',
      fullText: 'Still bullish on $ABC, neutral on $XYZ.',
      createdAtMs: 1_700_000_000_100,
      lane: 'timeline',
    },
  ]);

  await runTweetEnrichmentForTweetIds({
    tweetIds: ['tweet-enrichment-1'],
    model: {
      enrichTweet: async () => ({
        translationZh: '我依然看好 ABC，对 XYZ 保持中性。',
        sentiments: [
          { tokenSymbol: 'ABC', sentiment: 'positive', confidence: 0.95 },
          { tokenSymbol: 'XYZ', sentiment: 'neutral', confidence: 0.72 },
        ],
      }),
    },
  });

  projectTwitterTweetsToFeed({ sinceMs: 0, tweetIds: ['tweet-enrichment-1'] });
  const feed = readEventsFeed({ limit: 10 }).feed;
  const tweetItem = feed.find((item) => item.activity.metadata.tweetId === 'tweet-enrichment-1');

  assert.equal(tweetItem?.activity.metadata.translationZh, '我依然看好 ABC，对 XYZ 保持中性。');
  assert.deepEqual(tweetItem?.activity.metadata.mentionedTickers, ['ABC', 'XYZ']);
  assert.equal(tweetItem?.activity.metadata.tokenSentiments?.[0]?.sentiment, 'positive');
}

async function testQuoteRelayProjectionMetadata() {
  const { getDb } = await import('../lib/server/sqlite');
  const { upsertTwitterTweets } = await import('../lib/server/twitterRepo');
  const { projectTwitterTweetsToFeed } = await import('../lib/server/twitterFeedMapper');
  const { readEventsFeed } = await import('../lib/server/eventsRepo');

  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO tracked_users (
      id,
      name,
      handle,
      avatar,
      twitter,
      telegram,
      tags_json,
      total_asset_usd,
      historical_max_asset_usd,
      asset_updated_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, '', ?, null, '[]', 0, 0, null, ?, ?)`
  ).run('user-quote-1', 'Quote Relay User', 'quote-relay-user', 'cookerflips', now, now);

  upsertTwitterTweets([
    {
      tweetId: '2051340798957113505',
      authorHandle: 'cookerflips',
      fullText: 'https://t.co/MU3UISkJ0r',
      createdAtMs: 1_700_000_000_200,
      lane: 'timeline',
      source: {
        provider: 'bot2bot',
        action: 'quote',
        quotedAuthorHandle: 'tradexyz',
        quotedContent: 'DRAM is now live. 20x leverage, 24/7, 365. https://t.co/4671GVIP0h',
      },
    },
  ]);

  projectTwitterTweetsToFeed({ sinceMs: 0, tweetIds: ['2051340798957113505'] });
  const feed = readEventsFeed({ limit: 10 }).feed;
  const tweetItem = feed.find((item) => item.activity.metadata.tweetId === '2051340798957113505');

  assert.equal(tweetItem?.activity.content, '');
  assert.equal(
    (tweetItem?.activity.metadata as Activity['metadata'] & { quotedTweetAuthorHandle?: string })?.quotedTweetAuthorHandle,
    'tradexyz'
  );
  assert.equal(
    (tweetItem?.activity.metadata as Activity['metadata'] & { quotedTweetContent?: string })?.quotedTweetContent,
    'DRAM is now live. 20x leverage, 24/7, 365.'
  );
}

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-twitter-enrichment-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    await runSchemaTest();
    testExtractTweetTokenMentions();
    await testEnrichmentProjectionMetadata();
    await testQuoteRelayProjectionMetadata();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
