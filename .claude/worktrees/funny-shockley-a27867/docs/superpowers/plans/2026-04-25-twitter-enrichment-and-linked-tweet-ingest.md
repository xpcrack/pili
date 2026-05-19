# Twitter Enrichment And Linked Tweet Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persisted tweet enrichment, per-token sentiment, Chinese-first tweet rendering, and trade-linked tweet ingest/backfill without breaking the existing `twitterSyncService -> twitterRepo -> twitterFeedMapper -> events` pipeline.

**Architecture:** Keep `twitter_tweets` as the source of truth for tweet bodies and `twitter:${tweetId}` as the only feed identity for tweet cards. Add three focused persistence layers around it: tweet enrichment state, tweet-to-token mentions, and event-to-tweet references. Run enrichment asynchronously after tweet upsert/project, and let trade-linked tweet discovery only attach references plus fetch missing tweets by id.

**Tech Stack:** Next.js 16 route handlers, TypeScript, better-sqlite3, existing script-based `tsx` tests, React 19 client components.

---

## File Structure

### Existing files to modify

- `types/index.ts`
  Extend `Activity['metadata']` with tweet translation and token mention display fields.
- `lib/server/sqlite.ts`
  Add schema for `twitter_tweet_enrichments`, `twitter_tweet_token_mentions`, and `event_tweet_refs`, plus helpful indexes.
- `lib/server/twitterRepo.ts`
  Add repo APIs for enrichment rows, mention rows, and event tweet references.
- `lib/server/twitterFeedMapper.ts`
  Join tweet enrichment into projected tweet metadata and content.
- `lib/server/twitterSyncService.ts`
  Schedule enrichment after successful tweet upsert/project and expose replay entrypoints.
- `lib/server/telegramMonitorRepo.ts`
  Persist message links in monitor payload rows and expose recent rows for tweet-ref backfill scans.
- `lib/server/telegramMonitorIngest.ts`
  Detect tweet links during ingest and register event-to-tweet references / fetch-missing flow.
- `lib/smartSearch.ts`
  Include tweet mention tickers/CAs in free-text search and suggestion sources.
- `components/ActivityCard.tsx`
  Render Chinese-first tweet content and per-token sentiment chips.
- `package.json`
  Add test script entries for new tweet enrichment and linked-ingest test files.

### New files to create

- `lib/twitter/extractTweetTokenMentions.ts`
  Deterministic rule extractor for `$TICKER`, `CA:`, and mention normalization.
- `lib/server/twitterEnrichmentRepo.ts`
  Focused persistence helpers for enrichment rows and mention rows if `twitterRepo.ts` becomes too crowded.
- `lib/server/twitterEnrichmentService.ts`
  Orchestrates translation + sentiment generation and persists projection-ready metadata.
- `lib/server/twitterLinkRefs.ts`
  Shared helpers to parse tweet ids from URLs, upsert `event_tweet_refs`, and fetch missing tweets by id.
- `lib/server/twitterEnrichmentModel.ts`
  Small model adapter boundary for translation/sentiment generation; easy to fake in tests.
- `scripts/test-twitter-enrichment.ts`
  Repo + extractor + enrichment service integration tests.
- `scripts/test-twitter-linked-ingest.ts`
  Trade-linked tweet ref realtime/backfill tests.

### Optional split only if needed during implementation

- If `lib/server/twitterRepo.ts` becomes unwieldy, move the new enrichment and ref helpers into:
  - `lib/server/twitterEnrichmentRepo.ts`
  - `lib/server/twitterEventRefRepo.ts`

## Task 1: Add persistence schema and repo APIs

**Files:**
- Create: `lib/server/twitterEnrichmentRepo.ts`
- Modify: `lib/server/sqlite.ts`
- Modify: `lib/server/twitterRepo.ts`
- Test: `scripts/test-twitter-enrichment.ts`

- [ ] **Step 1: Write the failing schema/repo test**

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function runSchemaTest() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-twitter-enrichment-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { getDb } = await import('@/lib/server/sqlite');
    const {
      upsertTwitterTweetEnrichment,
      replaceTwitterTweetTokenMentions,
      listTwitterTweetTokenMentions,
      upsertEventTweetRef,
      listEventTweetRefsByTweetId,
    } = await import('@/lib/server/twitterEnrichmentRepo');

    const db = getDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('twitter_tweet_enrichments','twitter_tweet_token_mentions','event_tweet_refs')"
    ).all() as Array<{ name: string }>;
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

void runSchemaTest();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-twitter-enrichment.ts`
Expected: FAIL with missing table names or missing exports such as `upsertTwitterTweetEnrichment`.

- [ ] **Step 3: Add the new SQLite tables and indexes**

```ts
CREATE TABLE IF NOT EXISTS twitter_tweet_enrichments (
  tweet_id TEXT PRIMARY KEY,
  translation_zh TEXT,
  translation_status TEXT NOT NULL DEFAULT 'pending',
  extraction_status TEXT NOT NULL DEFAULT 'pending',
  extractor_version TEXT,
  translator_version TEXT,
  last_processed_at_ms INTEGER,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS twitter_tweet_token_mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tweet_id TEXT NOT NULL,
  token_address TEXT,
  token_address_lower TEXT,
  token_symbol TEXT,
  token_symbol_lower TEXT,
  chain TEXT,
  match_source TEXT NOT NULL,
  sentiment TEXT NOT NULL,
  confidence REAL,
  rank_in_tweet INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_twitter_tweet_token_mentions_identity
ON twitter_tweet_token_mentions(tweet_id, chain, token_address_lower, token_symbol_lower);

CREATE TABLE IF NOT EXISTS event_tweet_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  tweet_id TEXT NOT NULL,
  ref_source TEXT NOT NULL,
  discovered_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(event_id, tweet_id)
);
```

- [ ] **Step 4: Add minimal repo helpers**

```ts
export function upsertTwitterTweetEnrichment(input: {
  tweetId: string;
  translationZh: string | null;
  translationStatus: 'pending' | 'processing' | 'succeeded' | 'failed';
  extractionStatus: 'pending' | 'processing' | 'succeeded' | 'failed';
  extractorVersion: string | null;
  translatorVersion: string | null;
  lastProcessedAtMs: number | null;
  lastError: string | null;
}) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO twitter_tweet_enrichments (
       tweet_id, translation_zh, translation_status, extraction_status,
       extractor_version, translator_version, last_processed_at_ms, last_error, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tweet_id) DO UPDATE SET
       translation_zh = excluded.translation_zh,
       translation_status = excluded.translation_status,
       extraction_status = excluded.extraction_status,
       extractor_version = excluded.extractor_version,
       translator_version = excluded.translator_version,
       last_processed_at_ms = excluded.last_processed_at_ms,
       last_error = excluded.last_error,
       updated_at_ms = excluded.updated_at_ms`
  ).run(
    input.tweetId,
    input.translationZh,
    input.translationStatus,
    input.extractionStatus,
    input.extractorVersion,
    input.translatorVersion,
    input.lastProcessedAtMs,
    input.lastError,
    now,
    now
  );
}

export function replaceTwitterTweetTokenMentions(input: {
  tweetId: string;
  mentions: Array<{
    tokenAddress?: string | null;
    tokenSymbol?: string | null;
    chain?: string | null;
    matchSource: 'ticker' | 'ca' | 'both';
    sentiment: 'positive' | 'negative' | 'neutral';
    confidence?: number | null;
    rankInTweet?: number | null;
  }>;
}) {
  return withTransaction(() => {
    const db = getDb();
    db.prepare(`DELETE FROM twitter_tweet_token_mentions WHERE tweet_id = ?`).run(input.tweetId);
    const stmt = db.prepare(
      `INSERT INTO twitter_tweet_token_mentions (
         tweet_id, token_address, token_address_lower, token_symbol, token_symbol_lower, chain,
         match_source, sentiment, confidence, rank_in_tweet, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const now = Date.now();
    for (const mention of input.mentions) {
      stmt.run(
        input.tweetId,
        mention.tokenAddress || null,
        (mention.tokenAddress || '').trim().toLowerCase() || null,
        mention.tokenSymbol || null,
        (mention.tokenSymbol || '').trim().toLowerCase() || null,
        mention.chain || null,
        mention.matchSource,
        mention.sentiment,
        mention.confidence ?? null,
        mention.rankInTweet ?? null,
        now,
        now
      );
    }
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-twitter-enrichment.ts`
Expected: PASS with `PASS twitter enrichment schema + repo`.

- [ ] **Step 6: Commit**

```bash
git add lib/server/sqlite.ts lib/server/twitterRepo.ts lib/server/twitterEnrichmentRepo.ts scripts/test-twitter-enrichment.ts
git commit -m "feat: add twitter enrichment persistence"
```

## Task 2: Add deterministic ticker/CA extraction

**Files:**
- Create: `lib/twitter/extractTweetTokenMentions.ts`
- Modify: `scripts/test-twitter-enrichment.ts`
- Test: `scripts/test-twitter-enrichment.ts`

- [ ] **Step 1: Extend the failing test with extraction coverage**

```ts
import { extractTweetTokenMentions } from '@/lib/twitter/extractTweetTokenMentions';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-twitter-enrichment.ts`
Expected: FAIL with `Cannot find module '@/lib/twitter/extractTweetTokenMentions'`.

- [ ] **Step 3: Implement the extraction helper**

```ts
export interface ExtractedTweetTokenMention {
  tokenAddress: string | null;
  tokenSymbol: string | null;
  matchSource: 'ticker' | 'ca' | 'both';
  rankInTweet: number;
}

const EVM_CA_PATTERN = /\b0x[a-fA-F0-9]{40}\b/g;
const SOL_CA_PATTERN = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const TICKER_PATTERN = /\$([A-Za-z][A-Za-z0-9]{1,14})\b/g;

export function extractTweetTokenMentions(text: string): ExtractedTweetTokenMention[] {
  const normalizedText = text || '';
  const results: ExtractedTweetTokenMention[] = [];
  const bySymbol = new Map<string, ExtractedTweetTokenMention>();
  let rank = 0;

  for (const match of normalizedText.matchAll(TICKER_PATTERN)) {
    const tokenSymbol = (match[1] || '').toUpperCase();
    if (!tokenSymbol) continue;
    rank += 1;
    const existing = bySymbol.get(tokenSymbol);
    if (existing) continue;
    const record = {
      tokenAddress: null,
      tokenSymbol,
      matchSource: 'ticker' as const,
      rankInTweet: rank,
    };
    bySymbol.set(tokenSymbol, record);
    results.push(record);
  }

  for (const match of normalizedText.matchAll(EVM_CA_PATTERN)) {
    rank += 1;
    const tokenAddress = match[0];
    const latest = results[results.length - 1];
    if (latest && latest.tokenAddress === null) {
      latest.tokenAddress = tokenAddress;
      latest.matchSource = latest.tokenSymbol ? 'both' : 'ca';
      continue;
    }
    results.push({
      tokenAddress,
      tokenSymbol: null,
      matchSource: 'ca',
      rankInTweet: rank,
    });
  }

  for (const match of normalizedText.matchAll(SOL_CA_PATTERN)) {
    const tokenAddress = match[0];
    if (results.some((item) => item.tokenAddress === tokenAddress)) continue;
    rank += 1;
    results.push({
      tokenAddress,
      tokenSymbol: null,
      matchSource: 'ca',
      rankInTweet: rank,
    });
  }

  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-twitter-enrichment.ts`
Expected: PASS for schema/repo tests and extraction coverage.

- [ ] **Step 5: Commit**

```bash
git add lib/twitter/extractTweetTokenMentions.ts scripts/test-twitter-enrichment.ts
git commit -m "feat: add deterministic tweet token extraction"
```

## Task 3: Add enrichment service and tweet projection metadata

**Files:**
- Create: `lib/server/twitterEnrichmentModel.ts`
- Create: `lib/server/twitterEnrichmentService.ts`
- Modify: `lib/server/twitterFeedMapper.ts`
- Modify: `types/index.ts`
- Modify: `scripts/test-twitter-enrichment.ts`
- Test: `scripts/test-twitter-enrichment.ts`

- [ ] **Step 1: Add the failing enrichment projection test**

```ts
async function testEnrichmentProjectionMetadata() {
  const { upsertTwitterTweets } = await import('@/lib/server/twitterRepo');
  const { runTweetEnrichmentForTweetIds } = await import('@/lib/server/twitterEnrichmentService');
  const { projectTwitterTweetsToFeed } = await import('@/lib/server/twitterFeedMapper');
  const { readEventsFeed } = await import('@/lib/server/eventsRepo');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-twitter-enrichment.ts`
Expected: FAIL with missing `runTweetEnrichmentForTweetIds` or missing metadata fields.

- [ ] **Step 3: Add the model boundary and enrichment service**

```ts
export interface TweetEnrichmentModel {
  enrichTweet(input: {
    tweetId: string;
    text: string;
    mentions: Array<{ tokenSymbol: string | null; tokenAddress: string | null; matchSource: 'ticker' | 'ca' | 'both' }>;
  }): Promise<{
    translationZh: string | null;
    sentiments: Array<{ tokenSymbol?: string; tokenAddress?: string; sentiment: 'positive' | 'negative' | 'neutral'; confidence?: number }>;
  }>;
}

export async function runTweetEnrichmentForTweetIds(params: {
  tweetIds: string[];
  model?: TweetEnrichmentModel;
}) {
  const tweets = listTwitterTweetsByIds(params.tweetIds);
  const model = params.model || getDefaultTweetEnrichmentModel();

  for (const tweet of tweets) {
    const mentions = extractTweetTokenMentions(tweet.fullText);
    upsertTwitterTweetEnrichment({
      tweetId: tweet.tweetId,
      translationZh: null,
      translationStatus: 'processing',
      extractionStatus: 'processing',
      extractorVersion: 'rule-v1',
      translatorVersion: 'model-v1',
      lastProcessedAtMs: Date.now(),
      lastError: null,
    });

    const result = await model.enrichTweet({
      tweetId: tweet.tweetId,
      text: tweet.fullText,
      mentions,
    });

    replaceTwitterTweetTokenMentions({
      tweetId: tweet.tweetId,
      mentions: mentions.map((mention) => {
        const sentiment = result.sentiments.find((item) =>
          (item.tokenAddress && item.tokenAddress === mention.tokenAddress) ||
          (item.tokenSymbol && item.tokenSymbol.toUpperCase() === (mention.tokenSymbol || '').toUpperCase())
        );
        return {
          tokenAddress: mention.tokenAddress,
          tokenSymbol: mention.tokenSymbol,
          chain: null,
          matchSource: mention.matchSource,
          sentiment: sentiment?.sentiment || 'neutral',
          confidence: sentiment?.confidence ?? null,
          rankInTweet: mention.rankInTweet,
        };
      }),
    });

    upsertTwitterTweetEnrichment({
      tweetId: tweet.tweetId,
      translationZh: result.translationZh,
      translationStatus: result.translationZh ? 'succeeded' : 'failed',
      extractionStatus: 'succeeded',
      extractorVersion: 'rule-v1',
      translatorVersion: 'model-v1',
      lastProcessedAtMs: Date.now(),
      lastError: null,
    });
  }
}
```

- [ ] **Step 4: Update tweet feed projection metadata**

```ts
metadata: {
  tweetId: tweet.tweetId,
  tweetUrl: `https://x.com/${tweet.authorHandle}/status/${tweet.tweetId}`,
  tweetKind,
  likes: Math.max(0, Math.floor(tweet.likeCount)),
  replies: Math.max(0, Math.floor(tweet.replyCount)),
  translationZh: enrichment?.translationZh || undefined,
  translationStatus: enrichment?.translationStatus || 'pending',
  mentionedTickers: mentions.map((item) => item.tokenSymbol).filter((value): value is string => Boolean(value)),
  mentionedTokenAddresses: mentions.map((item) => item.tokenAddress).filter((value): value is string => Boolean(value)),
  tokenSentiments: mentions.map((item) => ({
    tokenSymbol: item.tokenSymbol || undefined,
    tokenAddress: item.tokenAddress || undefined,
    chain: item.chain || undefined,
    sentiment: item.sentiment,
    matchSource: item.matchSource,
  })),
},
content: enrichment?.translationZh?.trim() || tweet.fullText,
```

- [ ] **Step 5: Add the metadata types**

```ts
translationZh?: string;
translationStatus?: 'pending' | 'processing' | 'succeeded' | 'failed';
mentionedTickers?: string[];
mentionedTokenAddresses?: string[];
tokenSentiments?: Array<{
  tokenSymbol?: string;
  tokenAddress?: string;
  chain?: string;
  sentiment: 'positive' | 'negative' | 'neutral';
  matchSource: 'ticker' | 'ca' | 'both';
}>;
referencedByEventCount?: number;
```

- [ ] **Step 6: Run test to verify it passes**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-twitter-enrichment.ts`
Expected: PASS for enrichment projection metadata.

- [ ] **Step 7: Commit**

```bash
git add types/index.ts lib/server/twitterEnrichmentModel.ts lib/server/twitterEnrichmentService.ts lib/server/twitterFeedMapper.ts scripts/test-twitter-enrichment.ts
git commit -m "feat: project enriched tweet metadata to feed"
```

## Task 4: Render Chinese-first tweets and sentiment chips in the card UI

**Files:**
- Modify: `components/ActivityCard.tsx`
- Modify: `types/index.ts`
- Test: `npm run lint`

- [ ] **Step 1: Add the UI rendering plan as a failing manual checklist**

```md
- tweet card body shows `translationZh` first when present
- original tweet text remains visible below as secondary text
- each `tokenSentiments` item renders as a chip with `正面 / 负面 / 中性`
- chips dedupe by `(tokenAddress || tokenSymbol)`
```

- [ ] **Step 2: Run lint before changes to capture a clean baseline**

Run: `npm run lint`
Expected: PASS before UI edits.

- [ ] **Step 3: Implement Chinese-first rendering and chips**

```tsx
const twitterPrimaryText =
  isTwitter ? (activity.metadata.translationZh || twitterContent) : primaryText;
const twitterSecondaryText =
  isTwitter && activity.metadata.translationZh ? twitterContent : secondaryText;
const tweetSentimentChips = isTwitter
  ? (activity.metadata.tokenSentiments || []).filter((item, index, items) => {
      const key = `${item.tokenAddress || ''}|${item.tokenSymbol || ''}`.toLowerCase();
      return items.findIndex((candidate) =>
        `${candidate.tokenAddress || ''}|${candidate.tokenSymbol || ''}`.toLowerCase() === key
      ) === index;
    })
  : [];

{isTwitter ? (
  <div className="space-y-1">
    <p className="whitespace-pre-wrap text-zinc-200">{twitterPrimaryText}</p>
    {twitterSecondaryText ? (
      <p className="whitespace-pre-wrap text-xs text-zinc-500">Original: {twitterSecondaryText}</p>
    ) : null}
    {tweetSentimentChips.length > 0 ? (
      <div className="flex flex-wrap gap-1.5 pt-1">
        {tweetSentimentChips.map((chip, index) => (
          <span
            key={`${chip.tokenAddress || chip.tokenSymbol || 'token'}:${index}`}
            className={
              chip.sentiment === 'positive'
                ? 'rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300'
                : chip.sentiment === 'negative'
                  ? 'rounded-full bg-rose-500/15 px-2 py-0.5 text-[11px] text-rose-300'
                  : 'rounded-full bg-zinc-700/70 px-2 py-0.5 text-[11px] text-zinc-200'
            }
          >
            {(chip.tokenSymbol || chip.tokenAddress || 'TOKEN').toUpperCase()} {chip.sentiment === 'positive' ? '正面' : chip.sentiment === 'negative' ? '负面' : '中性'}
          </span>
        ))}
      </div>
    ) : null}
  </div>
) : null}
```

- [ ] **Step 4: Run lint to verify the component is clean**

Run: `npm run lint`
Expected: PASS with no new TypeScript/ESLint errors.

- [ ] **Step 5: Commit**

```bash
git add components/ActivityCard.tsx types/index.ts
git commit -m "feat: render chinese-first enriched tweet cards"
```

## Task 5: Add realtime event tweet refs and fetch-missing flow for Telegram monitor events

**Files:**
- Create: `lib/server/twitterLinkRefs.ts`
- Modify: `lib/server/telegramMonitorIngest.ts`
- Modify: `lib/server/telegramMonitorRepo.ts`
- Modify: `lib/server/twitterSyncService.ts`
- Modify: `scripts/test-twitter-linked-ingest.ts`
- Modify: `package.json`
- Test: `scripts/test-twitter-linked-ingest.ts`

- [ ] **Step 1: Write the failing linked-ingest test**

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function testTelegramMonitorTweetRefIngest() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-twitter-linked-ingest-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { getDb } = await import('@/lib/server/sqlite');
    const { ingestTelegramMonitorUpdate } = await import('@/lib/server/telegramMonitorIngest');
    const { listTwitterTweetsByIds } = await import('@/lib/server/twitterRepo');
    const { listEventTweetRefsByTweetId } = await import('@/lib/server/twitterEnrichmentRepo');

    const db = getDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO tracked_users (id, name, handle, avatar, twitter, telegram, tags_json, total_asset_usd, historical_max_asset_usd, asset_updated_at, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, null, '[]', 0, 0, null, ?, ?)`
    ).run('user-1', 'Monitor User', 'monitor-user', 'monitorhandle', now, now);
    db.prepare(
      `INSERT INTO tracked_addresses (id, user_id, address, address_lower, name, chain, total_asset_usd, asset_updated_at, last_synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'bsc', null, null, null, ?, ?)`
    ).run('addr-1', 'user-1', '0x123', '0x123', '#1', now, now);

    process.env.TELEGRAM_MONITOR_INGEST_TOKEN = 'secret';
    db.prepare(`INSERT INTO system_config (key, value_json, updated_at) VALUES ('telegramTradeMonitorSourceChatId', json(?), ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(JSON.stringify('-1001'), now);

    const result = await ingestTelegramMonitorUpdate({
      update_id: 1,
      message: {
        message_id: 100,
        date: Math.floor(now / 1000),
        chat: { id: '-1001' },
        text: '[Monitor][#1]\\nNew buy 1 BNB\\nCA: 0xabc1234567890abcdef1234567890abcdef1234',
        reply_markup: {
          inline_keyboard: [[{ text: 'tweet', url: 'https://x.com/alpha/status/1912345678901234567' }]],
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(listTwitterTweetsByIds(['1912345678901234567']).length, 1);
    assert.equal(listEventTweetRefsByTweetId('1912345678901234567').length, 1);
    console.log('PASS telegram monitor tweet ref ingest');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void testTelegramMonitorTweetRefIngest();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-twitter-linked-ingest.ts`
Expected: FAIL because no helper currently parses/stores tweet refs for telegram monitor events.

- [ ] **Step 3: Add the shared tweet-ref helper**

```ts
export function parseTweetIdFromUrl(urlText: string) {
  try {
    const url = new URL(urlText);
    if (url.hostname !== 'x.com' && url.hostname !== 'twitter.com') {
      return '';
    }
    const match = url.pathname.match(/\/(?:i\/)?status\/(\d+)/i);
    return match?.[1] || '';
  } catch {
    return '';
  }
}

export async function upsertEventTweetRefAndFetchMissing(params: {
  eventId: string;
  tweetUrls: string[];
  refSource: 'telegram-monitor' | 'historical-backfill';
  fetchTweetsByIds: (ids: string[]) => Promise<{ provider: string; tweets: UpsertTwitterTweetInput[] }>;
}) {
  const tweetIds = Array.from(new Set(params.tweetUrls.map(parseTweetIdFromUrl).filter(Boolean)));
  for (const tweetId of tweetIds) {
    upsertEventTweetRef({
      eventId: params.eventId,
      tweetId,
      refSource: params.refSource,
      discoveredAtMs: Date.now(),
    });
  }

  const missingIds = tweetIds.filter((tweetId) => listTwitterTweetsByIds([tweetId]).length === 0);
  if (missingIds.length === 0) return;

  const fetched = await params.fetchTweetsByIds(missingIds);
  if (fetched.tweets.length > 0) {
    upsertTwitterTweets(fetched.tweets);
    projectTwitterTweetsToFeed({ sinceMs: 0, tweetIds: fetched.tweets.map((item) => item.tweetId) });
  }
}
```

- [ ] **Step 4: Call the helper from telegram monitor ingest**

```ts
const projected = projectTelegramMonitorEvent({ ... });

if (projected) {
  upsertEventsFromFeedRows([projected], 'telegram-monitor-ingest');
  const tweetUrls = messageLinks.filter((item) => parseTweetIdFromUrl(item));
  if (tweetUrls.length > 0) {
    await upsertEventTweetRefAndFetchMissing({
      eventId: projected.activity.id,
      tweetUrls,
      refSource: 'telegram-monitor',
      fetchTweetsByIds: async (ids) => {
        const fetcher = createTwitterFetcher();
        return fetcher.fetchTweetsByIds({ ids, intent: 'detail' });
      },
    });
  }
}
```

- [ ] **Step 5: Add a backfill entrypoint for recent telegram monitor rows**

```ts
export async function backfillRecentTelegramMonitorTweetRefs(limit = 200) {
  const rows = listRecentTelegramMonitorEvents(limit);
  for (const row of rows) {
    const payload = row.rawText || '';
    const links = collectTwitterStatusUrls(payload);
    if (links.length === 0) continue;
    await upsertEventTweetRefAndFetchMissing({
      eventId: `xxyy-monitor:${row.chain}:${row.txHash || row.tokenAddress}:${row.eventTimeMs}`,
      tweetUrls: links,
      refSource: 'historical-backfill',
      fetchTweetsByIds: async (ids) => createTwitterFetcher().fetchTweetsByIds({ ids, intent: 'detail' }),
    });
  }
}
```

- [ ] **Step 6: Add the npm script and run the new test**

```json
"test:twitter-enrichment": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-twitter-enrichment.ts",
"test:twitter-linked-ingest": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-twitter-linked-ingest.ts"
```

Run: `npm run test:twitter-linked-ingest`
Expected: PASS with `PASS telegram monitor tweet ref ingest`.

- [ ] **Step 7: Commit**

```bash
git add lib/server/twitterLinkRefs.ts lib/server/telegramMonitorIngest.ts lib/server/telegramMonitorRepo.ts lib/server/twitterSyncService.ts scripts/test-twitter-linked-ingest.ts package.json
git commit -m "feat: ingest trade-linked tweet references"
```

## Task 6: Expand search coverage and run the verification suite

**Files:**
- Modify: `lib/smartSearch.ts`
- Modify: `package.json`
- Test: `scripts/test-twitter-enrichment.ts`
- Test: `scripts/test-twitter-linked-ingest.ts`
- Test: `scripts/test-twitter-sync-service.ts`
- Test: `npm run lint`

- [ ] **Step 1: Add the failing search coverage assertion**

```ts
import { matchesSearchQuery, parseSearchQuery } from '@/lib/smartSearch';

function testTweetSearchMatchesMentionedTicker() {
  const item = {
    user: { name: 'Alice', handle: 'alice', twitter: 'alice', telegram: null, avatar: '', addresses: [], totalAssetUsd: 0, historicalMaxAssetUsd: 0, assetUpdatedAt: null, tags: [], id: 'u1' },
    activity: {
      id: 'twitter:1',
      userId: 'u1',
      source: 'twitter',
      type: 'post',
      content: '我看好 ABC',
      timestamp: 1,
      metadata: {
        tweetId: '1',
        mentionedTickers: ['ABC'],
        mentionedTokenAddresses: ['0xabc'],
        tokenSentiments: [{ tokenSymbol: 'ABC', tokenAddress: '0xabc', sentiment: 'positive', matchSource: 'both' }],
      },
    },
  };

  assert.equal(matchesSearchQuery(item as never, parseSearchQuery('ticker:abc')), true);
  assert.equal(matchesSearchQuery(item as never, parseSearchQuery('ca:0xabc')), true);
}
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-twitter-enrichment.ts`
Expected: FAIL because `smartSearch` only looks at `activity.metadata.token` / `tokenAddress`.

- [ ] **Step 3: Extend search sources for enriched tweets**

```ts
if (field === 'ca') {
  return [
    activity.metadata.tokenAddress,
    ...(activity.metadata.mentionedTokenAddresses || []),
    ...((activity.metadata.tokenSentiments || []).map((item) => item.tokenAddress).filter(Boolean) as string[]),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

if (field === 'ticker') {
  return [
    activity.metadata.token,
    ...(activity.metadata.mentionedTickers || []),
    ...((activity.metadata.tokenSentiments || []).map((item) => item.tokenSymbol).filter(Boolean) as string[]),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}
```

- [ ] **Step 4: Run the verification suite**

Run: `npm run test:twitter-enrichment && npm run test:twitter-linked-ingest && npm run test:twitter-sync-service && npm run lint`
Expected:
- `PASS twitter enrichment schema + repo`
- `PASS telegram monitor tweet ref ingest`
- existing `twitter sync` assertions still pass
- lint exits 0

- [ ] **Step 5: Commit**

```bash
git add lib/smartSearch.ts package.json scripts/test-twitter-enrichment.ts scripts/test-twitter-linked-ingest.ts
git commit -m "feat: wire enriched tweets into search and verification"
```

## Self-Review Checklist

- [ ] Confirm every spec section maps to at least one task:
  - persistence: Task 1
  - extraction: Task 2
  - model-driven translation/sentiment: Task 3
  - Chinese-first UI: Task 4
  - realtime + backfill trade-linked ingest: Task 5
  - search integration: Task 6
- [ ] Search the finished plan for forbidden placeholders such as `TODO`, `TBD`, `implement later`, or `similar to`.
- [ ] Make sure the names used across tasks stay consistent:
  - `twitter_tweet_enrichments`
  - `twitter_tweet_token_mentions`
  - `event_tweet_refs`
  - `runTweetEnrichmentForTweetIds`
  - `upsertEventTweetRefAndFetchMissing`

