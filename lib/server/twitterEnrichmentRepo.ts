import 'server-only';

import { getDb, withTransaction } from '@/lib/server/sqlite';

export type TweetEnrichmentStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'skipped';
export type TweetMentionMatchSource = 'ticker' | 'ca' | 'both';
export type TweetMentionSentiment = 'positive' | 'negative' | 'neutral';
export type TweetMentionOrigin = 'text' | 'image';
export type EventTweetRefSource = 'telegram-monitor' | 'telegram-channel' | 'historical-backfill';
export type TweetMentionMarketCapSource =
  | 'dexscreener'
  | 'estimated'
  | 'telegram-monitor-exact'
  | null;

export interface UpsertTwitterTweetEnrichmentInput {
  tweetId: string;
  translationZh: string | null;
  translationStatus: TweetEnrichmentStatus;
  extractionStatus: TweetEnrichmentStatus;
  extractorVersion: string | null;
  translatorVersion: string | null;
  quotedTranslationZh?: string | null;
  quotedTranslationStatus?: TweetEnrichmentStatus;
  visionStatus?: TweetEnrichmentStatus;
  visionProcessedAtMs?: number | null;
  lastProcessedAtMs: number | null;
  lastError: string | null;
}

export interface ReplaceTwitterTweetTokenMentionsInput {
  tweetId: string;
  mentions: Array<{
    tokenAddress?: string | null;
    tokenSymbol?: string | null;
    chain?: string | null;
    matchSource: TweetMentionMatchSource;
    sentiment: TweetMentionSentiment;
    confidence?: number | null;
    rankInTweet?: number | null;
    origin?: TweetMentionOrigin;
    marketCapUsd?: number | null;
    marketCapAtPostUsd?: number | null;
    marketCapAtPostEstimated?: boolean | null;
    marketCapSource?: TweetMentionMarketCapSource;
    resolvedAtMs?: number | null;
  }>;
}

export interface UpsertEventTweetRefInput {
  eventId: string;
  tweetId: string;
  refSource: EventTweetRefSource;
  discoveredAtMs: number;
}

export interface StoredTwitterTweetEnrichment {
  tweetId: string;
  translationZh: string | null;
  translationStatus: TweetEnrichmentStatus;
  extractionStatus: TweetEnrichmentStatus;
  extractorVersion: string | null;
  translatorVersion: string | null;
  quotedTranslationZh: string | null;
  quotedTranslationStatus: TweetEnrichmentStatus;
  visionStatus: TweetEnrichmentStatus;
  visionProcessedAtMs: number | null;
  lastProcessedAtMs: number | null;
  lastError: string | null;
}

export interface StoredTwitterTweetTokenMention {
  id: number;
  tweetId: string;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  chain: string | null;
  matchSource: TweetMentionMatchSource;
  sentiment: TweetMentionSentiment;
  confidence: number | null;
  rankInTweet: number | null;
  origin: TweetMentionOrigin;
  marketCapUsd: number | null;
  marketCapAtPostUsd: number | null;
  marketCapAtPostEstimated: boolean;
  marketCapSource: TweetMentionMarketCapSource;
  resolvedAtMs: number | null;
}

export interface StoredEventTweetRef {
  id: number;
  eventId: string;
  tweetId: string;
  refSource: EventTweetRefSource;
  discoveredAtMs: number;
}

function normalizeOptional(value: string | null | undefined) {
  const next = (value || '').trim();
  return next || null;
}

function normalizeOptionalLower(value: string | null | undefined) {
  const next = (value || '').trim().toLowerCase();
  return next || null;
}

function normalizeStatus(value: string): TweetEnrichmentStatus {
  if (
    value === 'processing' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'skipped'
  ) {
    return value;
  }
  return 'pending';
}

function normalizeMatchSource(value: string): TweetMentionMatchSource {
  if (value === 'ca' || value === 'both') {
    return value;
  }
  return 'ticker';
}

function normalizeSentiment(value: string): TweetMentionSentiment {
  if (value === 'positive' || value === 'negative') {
    return value;
  }
  return 'neutral';
}

function normalizeOrigin(value: string | null | undefined): TweetMentionOrigin {
  return value === 'image' ? 'image' : 'text';
}

function normalizeMarketCapSource(value: string | null | undefined): TweetMentionMarketCapSource {
  if (value === 'dexscreener' || value === 'estimated' || value === 'telegram-monitor-exact') {
    return value;
  }
  return null;
}

function normalizeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeRefSource(value: string): EventTweetRefSource {
  if (value === 'telegram-channel') {
    return value;
  }
  if (value === 'historical-backfill') {
    return value;
  }
  return 'telegram-monitor';
}

function mapEnrichmentRow(row: Record<string, unknown>): StoredTwitterTweetEnrichment {
  return {
    tweetId: String(row.tweet_id || ''),
    translationZh: row.translation_zh ? String(row.translation_zh) : null,
    translationStatus: normalizeStatus(String(row.translation_status || 'pending')),
    extractionStatus: normalizeStatus(String(row.extraction_status || 'pending')),
    extractorVersion: row.extractor_version ? String(row.extractor_version) : null,
    translatorVersion: row.translator_version ? String(row.translator_version) : null,
    quotedTranslationZh: row.quoted_translation_zh ? String(row.quoted_translation_zh) : null,
    quotedTranslationStatus: normalizeStatus(String(row.quoted_translation_status || 'pending')),
    visionStatus: normalizeStatus(String(row.vision_status || 'pending')),
    visionProcessedAtMs: normalizeFiniteNumber(row.vision_processed_at_ms),
    lastProcessedAtMs: normalizeFiniteNumber(row.last_processed_at_ms),
    lastError: row.last_error ? String(row.last_error) : null,
  };
}

function mapMentionRow(row: Record<string, unknown>): StoredTwitterTweetTokenMention {
  return {
    id: Number(row.id || 0),
    tweetId: String(row.tweet_id || ''),
    tokenAddress: row.token_address ? String(row.token_address) : null,
    tokenSymbol: row.token_symbol ? String(row.token_symbol) : null,
    chain: row.chain ? String(row.chain) : null,
    matchSource: normalizeMatchSource(String(row.match_source || 'ticker')),
    sentiment: normalizeSentiment(String(row.sentiment || 'neutral')),
    confidence: normalizeFiniteNumber(row.confidence),
    rankInTweet: normalizeFiniteNumber(row.rank_in_tweet),
    origin: normalizeOrigin(row.origin ? String(row.origin) : 'text'),
    marketCapUsd: normalizeFiniteNumber(row.market_cap_usd),
    marketCapAtPostUsd: normalizeFiniteNumber(row.market_cap_at_post_usd),
    marketCapAtPostEstimated: Number(row.market_cap_at_post_estimated || 0) === 1,
    marketCapSource: normalizeMarketCapSource(
      row.market_cap_source ? String(row.market_cap_source) : null
    ),
    resolvedAtMs: normalizeFiniteNumber(row.resolved_at_ms),
  };
}

export function upsertTwitterTweetEnrichment(input: UpsertTwitterTweetEnrichmentInput) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO twitter_tweet_enrichments (
       tweet_id,
       translation_zh,
       translation_status,
       extraction_status,
       extractor_version,
       translator_version,
       quoted_translation_zh,
       quoted_translation_status,
       vision_status,
       vision_processed_at_ms,
       last_processed_at_ms,
       last_error,
       created_at_ms,
       updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tweet_id) DO UPDATE SET
       translation_zh = excluded.translation_zh,
       translation_status = excluded.translation_status,
       extraction_status = excluded.extraction_status,
       extractor_version = excluded.extractor_version,
       translator_version = excluded.translator_version,
       quoted_translation_zh = excluded.quoted_translation_zh,
       quoted_translation_status = excluded.quoted_translation_status,
       vision_status = excluded.vision_status,
       vision_processed_at_ms = excluded.vision_processed_at_ms,
       last_processed_at_ms = excluded.last_processed_at_ms,
       last_error = excluded.last_error,
       updated_at_ms = excluded.updated_at_ms`
  ).run(
    input.tweetId,
    normalizeOptional(input.translationZh),
    normalizeStatus(input.translationStatus),
    normalizeStatus(input.extractionStatus),
    normalizeOptional(input.extractorVersion),
    normalizeOptional(input.translatorVersion),
    normalizeOptional(input.quotedTranslationZh),
    normalizeStatus(input.quotedTranslationStatus || 'pending'),
    normalizeStatus(input.visionStatus || 'pending'),
    input.visionProcessedAtMs ?? null,
    input.lastProcessedAtMs,
    normalizeOptional(input.lastError),
    now,
    now
  );
}

export function listTwitterTweetEnrichmentsByTweetIds(tweetIds: string[]) {
  if (tweetIds.length === 0) {
    return [] as StoredTwitterTweetEnrichment[];
  }

  const uniqueIds = Array.from(new Set(tweetIds.map((value) => value.trim()).filter(Boolean)));
  if (uniqueIds.length === 0) {
    return [] as StoredTwitterTweetEnrichment[];
  }

  const db = getDb();
  const placeholders = uniqueIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT
         tweet_id,
         translation_zh,
         translation_status,
         extraction_status,
         extractor_version,
         translator_version,
         quoted_translation_zh,
         quoted_translation_status,
         vision_status,
         vision_processed_at_ms,
         last_processed_at_ms,
         last_error
       FROM twitter_tweet_enrichments
       WHERE tweet_id IN (${placeholders})`
    )
    .all(...uniqueIds) as Array<Record<string, unknown>>;

  return rows.map(mapEnrichmentRow);
}

export function replaceTwitterTweetTokenMentions(input: ReplaceTwitterTweetTokenMentionsInput) {
  return withTransaction(() => {
    const db = getDb();
    db.prepare(`DELETE FROM twitter_tweet_token_mentions WHERE tweet_id = ?`).run(input.tweetId);
    const stmt = db.prepare(
      `INSERT INTO twitter_tweet_token_mentions (
         tweet_id,
         token_address,
         token_address_lower,
         token_symbol,
         token_symbol_lower,
         chain,
         match_source,
         sentiment,
         confidence,
         rank_in_tweet,
         origin,
         market_cap_usd,
         market_cap_at_post_usd,
         market_cap_at_post_estimated,
         market_cap_source,
         resolved_at_ms,
         created_at_ms,
         updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const now = Date.now();

    for (const mention of input.mentions) {
      stmt.run(
        input.tweetId,
        normalizeOptional(mention.tokenAddress),
        normalizeOptionalLower(mention.tokenAddress),
        normalizeOptional(mention.tokenSymbol),
        normalizeOptionalLower(mention.tokenSymbol),
        normalizeOptionalLower(mention.chain),
        normalizeMatchSource(mention.matchSource),
        normalizeSentiment(mention.sentiment),
        typeof mention.confidence === 'number' && Number.isFinite(mention.confidence)
          ? mention.confidence
          : null,
        typeof mention.rankInTweet === 'number' && Number.isFinite(mention.rankInTweet)
          ? Math.max(0, Math.floor(mention.rankInTweet))
          : null,
        normalizeOrigin(mention.origin),
        normalizeFiniteNumber(mention.marketCapUsd),
        normalizeFiniteNumber(mention.marketCapAtPostUsd),
        mention.marketCapAtPostEstimated ? 1 : 0,
        normalizeMarketCapSource(mention.marketCapSource),
        normalizeFiniteNumber(mention.resolvedAtMs),
        now,
        now
      );
    }
  });
}

export function listTwitterTweetTokenMentions(tweetId: string) {
  if (!tweetId.trim()) {
    return [] as StoredTwitterTweetTokenMention[];
  }

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         id,
         tweet_id,
         token_address,
         token_symbol,
         chain,
         match_source,
         sentiment,
         confidence,
         rank_in_tweet,
         origin,
         market_cap_usd,
         market_cap_at_post_usd,
         market_cap_at_post_estimated,
         market_cap_source,
         resolved_at_ms
       FROM twitter_tweet_token_mentions
       WHERE tweet_id = ?
       ORDER BY COALESCE(rank_in_tweet, 2147483647) ASC, id ASC`
    )
    .all(tweetId) as Array<Record<string, unknown>>;

  return rows.map(mapMentionRow);
}

export function listTwitterTweetTokenMentionsByTweetIds(tweetIds: string[]) {
  if (tweetIds.length === 0) {
    return [] as StoredTwitterTweetTokenMention[];
  }

  const uniqueIds = Array.from(new Set(tweetIds.map((value) => value.trim()).filter(Boolean)));
  if (uniqueIds.length === 0) {
    return [] as StoredTwitterTweetTokenMention[];
  }

  const db = getDb();
  const placeholders = uniqueIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT
         id,
         tweet_id,
         token_address,
         token_symbol,
         chain,
         match_source,
         sentiment,
         confidence,
         rank_in_tweet,
         origin,
         market_cap_usd,
         market_cap_at_post_usd,
         market_cap_at_post_estimated,
         market_cap_source,
         resolved_at_ms
       FROM twitter_tweet_token_mentions
       WHERE tweet_id IN (${placeholders})
       ORDER BY tweet_id ASC, COALESCE(rank_in_tweet, 2147483647) ASC, id ASC`
    )
    .all(...uniqueIds) as Array<Record<string, unknown>>;

  return rows.map(mapMentionRow);
}

export function upsertEventTweetRef(input: UpsertEventTweetRefInput) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO event_tweet_refs (
       event_id,
       tweet_id,
       ref_source,
       discovered_at_ms,
       created_at_ms
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(event_id, tweet_id) DO UPDATE SET
       ref_source = excluded.ref_source,
       discovered_at_ms = excluded.discovered_at_ms`
  ).run(
    input.eventId,
    input.tweetId,
    normalizeRefSource(input.refSource),
    Math.max(0, Math.floor(input.discoveredAtMs)),
    now
  );
}

export function listEventTweetRefsByTweetId(tweetId: string) {
  if (!tweetId.trim()) {
    return [] as StoredEventTweetRef[];
  }
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, event_id, tweet_id, ref_source, discovered_at_ms
       FROM event_tweet_refs
       WHERE tweet_id = ?
       ORDER BY discovered_at_ms DESC, id DESC`
    )
    .all(tweetId) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: Number(row.id || 0),
    eventId: String(row.event_id || ''),
    tweetId: String(row.tweet_id || ''),
    refSource: normalizeRefSource(String(row.ref_source || 'telegram-monitor')),
    discoveredAtMs: Number(row.discovered_at_ms || 0),
  }));
}
