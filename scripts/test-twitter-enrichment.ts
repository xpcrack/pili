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

  // Chinese $ticker + #hashtag (pool 社媒提及 depends on these).
  // #a too short; $Sundog带头 must NOT swallow trailing CJK.
  const cn = extractTweetTokenMentions('meme是个轮回 #熊猫头 and $熊猫头 again #a #FOO $Sundog带头');
  assert.deepEqual(
    cn.map((item) => ({
      tokenSymbol: item.tokenSymbol,
      tokenAddress: item.tokenAddress,
      matchSource: item.matchSource,
    })),
    [
      { tokenSymbol: '熊猫头', tokenAddress: null, matchSource: 'ticker' },
      { tokenSymbol: 'FOO', tokenAddress: null, matchSource: 'ticker' },
      { tokenSymbol: 'SUNDOG', tokenAddress: null, matchSource: 'ticker' },
    ]
  );

  // #a too short; bare Chinese name without $/# not extracted
  const bare = extractTweetTokenMentions('我看好熊猫头 没有标签');
  assert.equal(bare.length, 0);

  // bare TitleCase needs primary-pool allowlist (fail closed without it)
  const bareNoPool = extractTweetTokenMentions(
    'Jimothy hit the floor on the 8h chart, hitting RSI50, be patient'
  );
  assert.equal(bareNoPool.length, 0);

  const pool = new Set(['jimothy', 'pons']);
  const bareEn = extractTweetTokenMentions(
    'Jimothy hit the floor on the 8h chart, hitting RSI50, be patient',
    { bareSymbolAllowlist: pool },
  );
  assert.deepEqual(
    bareEn.map((item) => ({
      tokenSymbol: item.tokenSymbol,
      tokenAddress: item.tokenAddress,
      matchSource: item.matchSource,
    })),
    [{ tokenSymbol: 'JIMOTHY', tokenAddress: null, matchSource: 'ticker' }]
  );

  // @handle not a bare ticker; only official-twitter map counts
  const handle = extractTweetTokenMentions('@Unipioneer bought 666 sol $Jimothy', {
    bareSymbolAllowlist: new Set(['unipioneer', 'jimothy']),
  });
  assert.deepEqual(
    handle.map((item) => item.tokenSymbol),
    ['JIMOTHY']
  );

  // @official → token mention (primary-pool official twitter)
  const official = extractTweetTokenMentions('@pepecoin moon and $FOO', {
    bareSymbolAllowlist: new Set(['pepe']),
    officialTwitterByHandle: new Map([
      ['pepecoin', [{ symbol: 'PEPE', address: 'SoPePe1111111111111111111111111111111111111' }]],
    ]),
  });
  assert.deepEqual(
    official.map((item) => ({
      tokenSymbol: item.tokenSymbol,
      tokenAddress: item.tokenAddress,
      matchSource: item.matchSource,
    })),
    [
      {
        tokenSymbol: 'PEPE',
        tokenAddress: 'SoPePe1111111111111111111111111111111111111',
        matchSource: 'official_twitter',
      },
      { tokenSymbol: 'FOO', tokenAddress: null, matchSource: 'ticker' },
    ]
  );

  // ambiguous official handle → multi-mention + callback
  const ambiguousHandles: string[] = [];
  const multi = extractTweetTokenMentions('check @shared', {
    officialTwitterByHandle: new Map([
      [
        'shared',
        [
          { symbol: 'AAA', address: 'AddrA' },
          { symbol: 'BBB', address: 'AddrB' },
        ],
      ],
    ]),
    onAmbiguousOfficialTwitter: (info) => ambiguousHandles.push(info.handle),
  });
  assert.deepEqual(ambiguousHandles, ['shared']);
  assert.deepEqual(
    multi.map((item) => item.tokenSymbol),
    ['AAA', 'BBB']
  );

  // yeonwoo sample: only pool symbols; Bankr not in pool as BANKR → drop
  const yeon = extractTweetTokenMentions(
    'Personally disappointed. Longxyz fees high. PONS and Bankr compete in RWA space.',
    { bareSymbolAllowlist: new Set(['pons', 'rwa']) },
  );
  assert.deepEqual(
    yeon.map((item) => item.tokenSymbol),
    ['PONS', 'RWA']
  );

  // stopwords / chart jargon must not become tickers
  const stop = extractTweetTokenMentions('Patience and Conviction on the Chart Floor', {
    bareSymbolAllowlist: new Set(['patience', 'conviction', 'chart', 'floor']),
  });
  assert.equal(stop.length, 0);

  // $TICKER still preferred; bare duplicate of same symbol collapsed;
  // sentence-initial "Buying" is a stopword, must not become a ticker
  // $ does not need pool; bare Jimothy does
  const mixed = extractTweetTokenMentions('Buying more $Jimothy today Jimothy looks strong', {
    bareSymbolAllowlist: new Set(['jimothy']),
  });
  assert.deepEqual(
    mixed.map((item) => item.tokenSymbol),
    ['JIMOTHY']
  );

  // $TICKER without pool still works
  const dollarOnly = extractTweetTokenMentions('ape $FOOBAR now');
  assert.deepEqual(
    dollarOnly.map((item) => item.tokenSymbol),
    ['FOOBAR']
  );

  // ALLCAPS shout: short English + DOGE-in-phrase drop; SWOGE (≥5 + pool) keeps
  // TESLA is ≥5 but not in pool → drop; DOGE is 4 < shout min → drop
  const shout = extractTweetTokenMentions(
    'WTF TESLA ACC JUST POSTED IN THE SWOGE X COMM SAYING HES NOT STOPPING UNTIL SWOLE DOGE MEME IS EVERYWHERE',
    { bareSymbolAllowlist: new Set(['swoge', 'doge', 'in', 'tesla']) },
  );
  assert.deepEqual(
    shout.map((item) => item.tokenSymbol),
    ['TESLA', 'SWOGE']
  );
  const shoutPoolOnly = extractTweetTokenMentions(
    'WTF TESLA ACC JUST POSTED IN THE SWOGE X COMM SAYING HES NOT STOPPING UNTIL SWOLE DOGE MEME IS EVERYWHERE',
    { bareSymbolAllowlist: new Set(['swoge', 'doge', 'in']) },
  );
  assert.deepEqual(
    shoutPoolOnly.map((item) => item.tokenSymbol),
    ['SWOGE']
  );

  // $SWOGE in shout still works without pool
  const shoutDollar = extractTweetTokenMentions(
    'WTF TESLA POSTED $SWOGE EVERYWHERE DOGE MEME',
    { bareSymbolAllowlist: new Set(['doge']) },
  );
  assert.deepEqual(
    shoutDollar.map((item) => item.tokenSymbol),
    ['SWOGE']
  );

  // hashtag + following CA binds like $TICKER CA
  const hashCa = extractTweetTokenMentions(
    '#熊猫头 0x1234567890abcdef1234567890abcdef12345678'
  );
  assert.deepEqual(
    hashCa.map((item) => ({
      tokenSymbol: item.tokenSymbol,
      tokenAddress: item.tokenAddress,
      matchSource: item.matchSource,
    })),
    [
      {
        tokenSymbol: '熊猫头',
        tokenAddress: '0x1234567890abcdef1234567890abcdef12345678',
        matchSource: 'both',
      },
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

async function testQuotedTranslationAndMcFields() {
  const { getDb } = await import('../lib/server/sqlite');
  const { upsertTwitterTweets } = await import('../lib/server/twitterRepo');
  const { runTweetEnrichmentForTweetIds } = await import('../lib/server/twitterEnrichmentService');
  const { listTwitterTweetEnrichmentsByTweetIds, listTwitterTweetTokenMentions } =
    await import('../lib/server/twitterEnrichmentRepo');
  const { projectTwitterTweetsToFeed } = await import('../lib/server/twitterFeedMapper');
  const { readEventsFeed } = await import('../lib/server/eventsRepo');

  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO tracked_users (
      id, name, handle, avatar, twitter, telegram, tags_json,
      total_asset_usd, historical_max_asset_usd, asset_updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, '', ?, null, '[]', 0, 0, null, ?, ?)`
  ).run('user-quote-v2', 'Quote V2 User', 'quote-v2-user', 'quotev2user', now, now);

  upsertTwitterTweets([
    {
      tweetId: 'tweet-quote-v2',
      authorHandle: 'quotev2user',
      fullText: 'Agree with this take on $PEPE',
      createdAtMs: 1_700_000_000_300,
      lane: 'timeline',
      source: {
        provider: 'bot2bot',
        action: 'quote',
        quotedAuthorHandle: 'alpha',
        quotedContent: 'This is a strong setup for the next leg higher.',
      },
    },
  ]);

  await runTweetEnrichmentForTweetIds({
    tweetIds: ['tweet-quote-v2'],
    model: {
      enrichTweet: async (input) => {
        if (input.tweetId === 'quoted-content') {
          return {
            translationZh: '这是下一波上涨的强势布局。',
            sentiments: [],
          };
        }
        return {
          translationZh: '同意这个关于 PEPE 的看法',
          sentiments: [{ tokenSymbol: 'PEPE', sentiment: 'positive', confidence: 0.9 }],
        };
      },
    },
    visionModel: {
      extractMentionsFromImageUrl: async () => [],
    },
  });

  const enrichment = listTwitterTweetEnrichmentsByTweetIds(['tweet-quote-v2'])[0];
  assert.equal(enrichment?.translationZh, '同意这个关于 PEPE 的看法');
  assert.equal(enrichment?.quotedTranslationZh, '这是下一波上涨的强势布局。');
  assert.equal(enrichment?.quotedTranslationStatus, 'succeeded');
  assert.equal(enrichment?.translatorVersion, 'model-v4');
  assert.equal(enrichment?.visionStatus, 'skipped');

  const mentions = listTwitterTweetTokenMentions('tweet-quote-v2');
  assert.equal(mentions[0]?.tokenSymbol, 'PEPE');
  assert.equal(mentions[0]?.origin, 'text');
  // marketCap fields exist (null without CA)
  assert.equal(mentions[0]?.marketCapAtPostUsd, null);

  projectTwitterTweetsToFeed({ sinceMs: 0, tweetIds: ['tweet-quote-v2'] });
  const feed = readEventsFeed({ limit: 20 }).feed;
  const item = feed.find((row) => row.activity.metadata.tweetId === 'tweet-quote-v2');
  assert.equal(item?.activity.metadata.quotedTweetTranslationZh, '这是下一波上涨的强势布局。');
  assert.equal(item?.activity.metadata.translationZh, '同意这个关于 PEPE 的看法');
}

async function testMediaUrlExtraction() {
  const { listImageUrlsFromSourceJson } = await import('../lib/server/tweetMediaUrls');
  const urls = listImageUrlsFromSourceJson(
    JSON.stringify({
      provider: 'xread',
      raw: {
        legacy: {
          entities: {
            media: [
              { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/abc.jpg' },
              { type: 'video', media_url_https: 'https://video.twimg.com/x.mp4' },
            ],
          },
        },
      },
    })
  );
  assert.deepEqual(urls, ['https://pbs.twimg.com/media/abc.jpg']);
}

async function testVisionOcrPoolMatching() {
  const { extractPoolMentionsFromOcrTexts } = await import('../lib/server/visionEnrichmentModel');

  const mentions = extractPoolMentionsFromOcrTexts(
    [
      'CASHCAT / Tether PERPETUAL FUTURES - 1h - MEXC',
      'Sold all my $CASHCAT at a 50% loss today',
      '市有/SPYB（Market C...',
    ],
    new Set(['cashcat', '币有', 'usdc'])
  );

  assert.deepEqual(
    mentions.map((item) => item.tokenSymbol),
    ['CASHCAT', '币有']
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
    await testQuotedTranslationAndMcFields();
    await testMediaUrlExtraction();
    await testVisionOcrPoolMatching();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
