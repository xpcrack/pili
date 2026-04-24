import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { extractTweetTokenMentions } from '../lib/twitter/extractTweetTokenMentions';

import './server-only-shim.cjs';

async function runSchemaTest() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-twitter-enrichment-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
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
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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

async function run() {
  await runSchemaTest();
  testExtractTweetTokenMentions();
}

void run();
