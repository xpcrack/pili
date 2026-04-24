import 'server-only';

import { getDb, withTransaction } from '@/lib/server/sqlite';
import { isLikelyTwitterArtifactText } from '@/lib/twitterArtifactText';
import { normalizeTwitterHandle } from '@/lib/userProfile';

export type TwitterLane = 'timeline' | 'replies';
export type TwitterRelationType = 'reply_target' | 'quote_source';
export type TwitterSyncAction = 'sync' | 'replay' | 'reconcile';
export type TwitterSyncStatus = 'running' | 'success' | 'failed' | 'partial';

export interface TrackedTwitterUser {
  id: string;
  name: string;
  handle: string;
  twitterHandle: string;
}

export interface TwitterCursor {
  userId: string;
  lane: TwitterLane;
  coveredSinceMs: number | null;
  watermarkCreatedAtMs: number | null;
  watermarkTweetId: string | null;
  lastSuccessAtMs: number | null;
  updatedAtMs: number;
}

export interface UpsertTwitterTweetInput {
  tweetId: string;
  authorHandle: string;
  authorName?: string;
  fullText: string;
  createdAtMs: number;
  lane: TwitterLane;
  conversationId?: string;
  replyToTweetId?: string;
  quoteTweetId?: string;
  replyCount?: number;
  retweetCount?: number;
  likeCount?: number;
  viewCount?: number;
  source?: unknown;
}

export interface StoredTwitterTweet {
  tweetId: string;
  authorHandle: string;
  authorName: string | null;
  fullText: string;
  createdAtMs: number;
  lane: TwitterLane;
  conversationId: string | null;
  replyToTweetId: string | null;
  quoteTweetId: string | null;
  replyCount: number;
  retweetCount: number;
  likeCount: number;
  viewCount: number;
}

export interface TwitterLatestTweetSnapshot {
  tweetId: string;
  authorHandle: string;
  createdAtMs: number;
  lastSeenAtMs: number;
}

export interface TwitterLatestVisibleEventSnapshot {
  eventId: string;
  timestamp: number;
  userName: string | null;
}

export interface TwitterLatestRelaySnapshot {
  tweetId: string;
  authorHandle: string;
  createdAtMs: number;
  lastSeenAtMs: number;
  sourceChatId: string | null;
  messageId: number | null;
}

interface TwitterRunSummary {
  fetchedCount?: number;
  storedCount?: number;
  projectedCount?: number;
  backfillEnqueuedCount?: number;
  backfillFetchedCount?: number;
  budgetExhausted?: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
  summary?: unknown;
}

function normalize(value: string | undefined | null) {
  return (value || '').trim().toLowerCase();
}

function toSafeInt(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function parseRowTweet(row: Record<string, unknown>): StoredTwitterTweet {
  return {
    tweetId: String(row.tweet_id || ''),
    authorHandle: String(row.author_handle || ''),
    authorName: row.author_name ? String(row.author_name) : null,
    fullText: String(row.full_text || ''),
    createdAtMs: Number(row.created_at_ms || 0),
    lane: (row.lane === 'replies' ? 'replies' : 'timeline') as TwitterLane,
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    replyToTweetId: row.in_reply_to_tweet_id ? String(row.in_reply_to_tweet_id) : null,
    quoteTweetId: row.quoted_tweet_id ? String(row.quoted_tweet_id) : null,
    replyCount: Number(row.metrics_reply_count || 0),
    retweetCount: Number(row.metrics_retweet_count || 0),
    likeCount: Number(row.metrics_like_count || 0),
    viewCount: Number(row.metrics_view_count || 0),
  };
}

export function listTrackedTwitterUsers() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, name, handle, twitter
       FROM tracked_users
       WHERE twitter IS NOT NULL
       ORDER BY updated_at DESC, created_at DESC`
    )
    .all() as Array<{
    id: string;
    name: string;
    handle: string;
    twitter: string | null;
  }>;

  return rows
    .map((row) => {
      const twitterHandle = normalizeTwitterHandle(row.twitter || '');
      if (!twitterHandle) {
        return null;
      }
      return {
        id: row.id,
        name: row.name,
        handle: row.handle,
        twitterHandle: normalize(twitterHandle),
      } satisfies TrackedTwitterUser;
    })
    .filter((row): row is TrackedTwitterUser => Boolean(row));
}

export function acquireIngestionLease(lockKey: string, owner: string, nowMs: number, ttlMs: number) {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO ingestion_leases (
         lock_key,
         owner,
         expires_at_ms,
         heartbeat_at_ms,
         updated_at_ms
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(lock_key) DO UPDATE SET
         owner = excluded.owner,
         expires_at_ms = excluded.expires_at_ms,
         heartbeat_at_ms = excluded.heartbeat_at_ms,
         updated_at_ms = excluded.updated_at_ms
       WHERE ingestion_leases.expires_at_ms < excluded.updated_at_ms
          OR ingestion_leases.owner = excluded.owner`
    )
    .run(lockKey, owner, nowMs + ttlMs, nowMs, nowMs);

  return result.changes > 0;
}

export function heartbeatIngestionLease(lockKey: string, owner: string, nowMs: number, ttlMs: number) {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE ingestion_leases
       SET expires_at_ms = ?,
           heartbeat_at_ms = ?,
           updated_at_ms = ?
       WHERE lock_key = ?
         AND owner = ?`
    )
    .run(nowMs + ttlMs, nowMs, nowMs, lockKey, owner);
  return result.changes > 0;
}

export function releaseIngestionLease(lockKey: string, owner: string) {
  const db = getDb();
  db.prepare('DELETE FROM ingestion_leases WHERE lock_key = ? AND owner = ?').run(lockKey, owner);
}

export function readIngestionLease(lockKey: string) {
  const db = getDb();
  return db
    .prepare(
      `SELECT lock_key, owner, expires_at_ms, heartbeat_at_ms, updated_at_ms
       FROM ingestion_leases
       WHERE lock_key = ?
       LIMIT 1`
    )
    .get(lockKey) as
    | {
        lock_key: string;
        owner: string;
        expires_at_ms: number;
        heartbeat_at_ms: number;
        updated_at_ms: number;
      }
    | undefined;
}

export function createTwitterSyncRun(action: TwitterSyncAction, userId?: string | null, lane?: TwitterLane | null) {
  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO twitter_sync_runs (
         action,
         user_id,
         lane,
         status,
         started_at_ms,
         created_at_ms,
         updated_at_ms
       ) VALUES (?, ?, ?, 'running', ?, ?, ?)`
    )
    .run(action, userId || null, lane || null, now, now, now);

  return {
    id: Number(result.lastInsertRowid),
    startedAtMs: now,
  };
}

export function finishTwitterSyncRun(
  runId: number,
  status: TwitterSyncStatus,
  startedAtMs: number,
  summary: TwitterRunSummary
) {
  const db = getDb();
  const finishedAtMs = Date.now();
  db.prepare(
    `UPDATE twitter_sync_runs
     SET status = ?,
         finished_at_ms = ?,
         duration_ms = ?,
         fetched_count = ?,
         stored_count = ?,
         projected_count = ?,
         backfill_enqueued_count = ?,
         backfill_fetched_count = ?,
         budget_exhausted = ?,
         error_code = ?,
         error_message = ?,
         summary_json = ?,
         updated_at_ms = ?
     WHERE id = ?`
  ).run(
    status,
    finishedAtMs,
    Math.max(0, finishedAtMs - startedAtMs),
    toSafeInt(summary.fetchedCount),
    toSafeInt(summary.storedCount),
    toSafeInt(summary.projectedCount),
    toSafeInt(summary.backfillEnqueuedCount),
    toSafeInt(summary.backfillFetchedCount),
    summary.budgetExhausted ? 1 : 0,
    summary.errorCode || null,
    summary.errorMessage || null,
    safeJsonStringify(summary.summary || {}),
    finishedAtMs,
    runId
  );
}

export function readRecentTwitterSyncRuns(limit = 20) {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  return db
    .prepare(
      `SELECT id, action, user_id, lane, status, started_at_ms, finished_at_ms, duration_ms,
              fetched_count, stored_count, projected_count, backfill_enqueued_count, backfill_fetched_count,
              budget_exhausted, error_code, error_message, summary_json
       FROM twitter_sync_runs
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(safeLimit) as Array<Record<string, unknown>>;
}

export function readTwitterCursor(userId: string, lane: TwitterLane): TwitterCursor | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT user_id, lane, covered_since_ms, watermark_created_at_ms, watermark_tweet_id, last_success_at_ms, updated_at_ms
       FROM twitter_sync_cursor
       WHERE user_id = ? AND lane = ?
       LIMIT 1`
    )
    .get(userId, lane) as Record<string, unknown> | undefined;

  if (!row) {
    return null;
  }

  return {
    userId: String(row.user_id || ''),
    lane: (row.lane === 'replies' ? 'replies' : 'timeline') as TwitterLane,
    coveredSinceMs: typeof row.covered_since_ms === 'number' ? row.covered_since_ms : null,
    watermarkCreatedAtMs:
      typeof row.watermark_created_at_ms === 'number' ? row.watermark_created_at_ms : null,
    watermarkTweetId: typeof row.watermark_tweet_id === 'string' ? row.watermark_tweet_id : null,
    lastSuccessAtMs: typeof row.last_success_at_ms === 'number' ? row.last_success_at_ms : null,
    updatedAtMs: typeof row.updated_at_ms === 'number' ? row.updated_at_ms : Date.now(),
  };
}

export function upsertTwitterCursor(payload: {
  userId: string;
  lane: TwitterLane;
  coveredSinceMs: number | null;
  watermarkCreatedAtMs: number | null;
  watermarkTweetId: string | null;
  lastSuccessAtMs: number;
}) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO twitter_sync_cursor (
       user_id,
       lane,
       covered_since_ms,
       watermark_created_at_ms,
       watermark_tweet_id,
       last_success_at_ms,
       updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, lane) DO UPDATE SET
       covered_since_ms = excluded.covered_since_ms,
       watermark_created_at_ms = excluded.watermark_created_at_ms,
       watermark_tweet_id = excluded.watermark_tweet_id,
       last_success_at_ms = excluded.last_success_at_ms,
       updated_at_ms = excluded.updated_at_ms`
  ).run(
    payload.userId,
    payload.lane,
    payload.coveredSinceMs,
    payload.watermarkCreatedAtMs,
    payload.watermarkTweetId,
    payload.lastSuccessAtMs,
    now
  );
}

export function touchTwitterCursorLastSuccess(
  userId: string,
  lane: TwitterLane,
  lastSuccessAtMs: number,
  coveredSinceMs: number | null
) {
  const existing = readTwitterCursor(userId, lane);
  if (!existing) {
    upsertTwitterCursor({
      userId,
      lane,
      coveredSinceMs,
      watermarkCreatedAtMs: null,
      watermarkTweetId: null,
      lastSuccessAtMs,
    });
    return;
  }

  upsertTwitterCursor({
    userId,
    lane,
    coveredSinceMs,
    watermarkCreatedAtMs: existing.watermarkCreatedAtMs,
    watermarkTweetId: existing.watermarkTweetId,
    lastSuccessAtMs,
  });
}

export function upsertTwitterTweets(tweets: UpsertTwitterTweetInput[]) {
  if (tweets.length === 0) {
    return {
      storedCount: 0,
      relationCount: 0,
    };
  }

  return withTransaction(() => {
    const db = getDb();
    const now = Date.now();
    const seenTweetIds = new Set<string>();
    const seenRelationKeys = new Set<string>();
    let relationCount = 0;

    const upsertTweetStmt = db.prepare(
      `INSERT INTO twitter_tweets (
         tweet_id,
         author_handle,
         author_name,
         full_text,
         created_at_ms,
         lane,
         conversation_id,
         in_reply_to_tweet_id,
         quoted_tweet_id,
         metrics_reply_count,
         metrics_retweet_count,
         metrics_like_count,
         metrics_view_count,
         source_json,
         first_seen_at_ms,
         last_seen_at_ms,
         updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tweet_id) DO UPDATE SET
         author_handle = excluded.author_handle,
         author_name = excluded.author_name,
         full_text = excluded.full_text,
         created_at_ms = excluded.created_at_ms,
         lane = excluded.lane,
         conversation_id = excluded.conversation_id,
         in_reply_to_tweet_id = excluded.in_reply_to_tweet_id,
         quoted_tweet_id = excluded.quoted_tweet_id,
         metrics_reply_count = excluded.metrics_reply_count,
         metrics_retweet_count = excluded.metrics_retweet_count,
         metrics_like_count = excluded.metrics_like_count,
         metrics_view_count = excluded.metrics_view_count,
         source_json = excluded.source_json,
         last_seen_at_ms = excluded.last_seen_at_ms,
         updated_at_ms = excluded.updated_at_ms`
    );

    const upsertRelationStmt = db.prepare(
      `INSERT INTO twitter_tweet_relations (
         source_tweet_id,
         relation_type,
         target_tweet_id,
         created_at_ms,
         updated_at_ms
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_tweet_id, relation_type, target_tweet_id) DO UPDATE SET
         updated_at_ms = excluded.updated_at_ms`
    );

    for (const tweet of tweets) {
      const tweetId = (tweet.tweetId || '').trim();
      const authorHandle = normalize(tweet.authorHandle);
      const fullText = tweet.fullText?.trim() || '';
      const createdAtMs = Number.isFinite(tweet.createdAtMs)
        ? Math.max(0, Math.floor(tweet.createdAtMs))
        : 0;

      if (!tweetId || !authorHandle || !fullText || !createdAtMs || isLikelyTwitterArtifactText(fullText)) {
        continue;
      }

      seenTweetIds.add(tweetId);
      upsertTweetStmt.run(
        tweetId,
        authorHandle,
        tweet.authorName?.trim() || null,
        fullText,
        createdAtMs,
        tweet.lane,
        tweet.conversationId?.trim() || null,
        tweet.replyToTweetId?.trim() || null,
        tweet.quoteTweetId?.trim() || null,
        toSafeInt(tweet.replyCount),
        toSafeInt(tweet.retweetCount),
        toSafeInt(tweet.likeCount),
        toSafeInt(tweet.viewCount),
        safeJsonStringify(tweet.source || {}),
        now,
        now,
        now
      );

      if (tweet.replyToTweetId?.trim()) {
        const target = tweet.replyToTweetId.trim();
        const relationKey = `${tweetId}|reply_target|${target}`;
        if (!seenRelationKeys.has(relationKey)) {
          seenRelationKeys.add(relationKey);
          relationCount += 1;
        }
        upsertRelationStmt.run(tweetId, 'reply_target', target, now, now);
      }

      if (tweet.quoteTweetId?.trim()) {
        const target = tweet.quoteTweetId.trim();
        const relationKey = `${tweetId}|quote_source|${target}`;
        if (!seenRelationKeys.has(relationKey)) {
          seenRelationKeys.add(relationKey);
          relationCount += 1;
        }
        upsertRelationStmt.run(tweetId, 'quote_source', target, now, now);
      }
    }

    return {
      storedCount: seenTweetIds.size,
      relationCount,
    };
  });
}

export function listMissingReferencedTweetIds(limit: number) {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = db
    .prepare(
      `SELECT DISTINCT r.target_tweet_id
       FROM twitter_tweet_relations r
       LEFT JOIN twitter_tweets t ON t.tweet_id = r.target_tweet_id
       WHERE t.tweet_id IS NULL
       ORDER BY r.id DESC
       LIMIT ?`
    )
    .all(safeLimit) as Array<{ target_tweet_id: string }>;

  return rows.map((row) => row.target_tweet_id).filter(Boolean);
}

export function listTwitterTweetsByIds(tweetIds: string[]) {
  if (tweetIds.length === 0) {
    return [] as StoredTwitterTweet[];
  }
  const db = getDb();
  const uniqueIds = Array.from(new Set(tweetIds.map((value) => value.trim()).filter(Boolean)));
  if (uniqueIds.length === 0) {
    return [] as StoredTwitterTweet[];
  }

  const placeholders = uniqueIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT tweet_id, author_handle, author_name, full_text, created_at_ms, lane,
              conversation_id, in_reply_to_tweet_id, quoted_tweet_id,
              metrics_reply_count, metrics_retweet_count, metrics_like_count, metrics_view_count
       FROM twitter_tweets
       WHERE tweet_id IN (${placeholders})`
    )
    .all(...uniqueIds) as Array<Record<string, unknown>>;

  return rows.map(parseRowTweet);
}

export function listTwitterTweetsByAuthorAndWindow(options: {
  authorHandle: string;
  sinceMs: number;
}) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT tweet_id, author_handle, author_name, full_text, created_at_ms, lane,
              conversation_id, in_reply_to_tweet_id, quoted_tweet_id,
              metrics_reply_count, metrics_retweet_count, metrics_like_count, metrics_view_count
       FROM twitter_tweets
       WHERE author_handle = ?
         AND created_at_ms >= ?
       ORDER BY created_at_ms DESC, tweet_id DESC`
    )
    .all(normalize(options.authorHandle), options.sinceMs) as Array<Record<string, unknown>>;

  return rows.map(parseRowTweet);
}

export function listTwitterTweetsForReconcile(options: { userId?: string | null; sinceMs: number }) {
  const db = getDb();
  const hasUserFilter = typeof options.userId === 'string' && options.userId.trim().length > 0;
  const rows = hasUserFilter
    ? (db
        .prepare(
          `SELECT t.tweet_id
           FROM twitter_tweets t
           INNER JOIN tracked_users u ON lower(u.twitter) = t.author_handle
           LEFT JOIN activity_feed f ON f.activity_key = ('twitter:' || t.tweet_id)
           WHERE u.id = ?
             AND t.created_at_ms >= ?
             AND f.id IS NULL`
        )
        .all(options.userId?.trim(), options.sinceMs) as Array<{ tweet_id: string }>)
    : (db
        .prepare(
          `SELECT t.tweet_id
           FROM twitter_tweets t
           INNER JOIN tracked_users u ON lower(u.twitter) = t.author_handle
           LEFT JOIN activity_feed f ON f.activity_key = ('twitter:' || t.tweet_id)
           WHERE t.created_at_ms >= ?
             AND f.id IS NULL`
        )
        .all(options.sinceMs) as Array<{ tweet_id: string }>);

  return rows.map((row) => row.tweet_id).filter(Boolean);
}

export function countTwitterStaleFeedRows() {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(1) AS count
       FROM activity_feed f
       LEFT JOIN twitter_tweets t ON f.activity_key = ('twitter:' || t.tweet_id)
       WHERE f.source = 'twitter'
         AND t.tweet_id IS NULL`
    )
    .get() as { count: number };
  return row?.count || 0;
}

export function readLatestTwitterTweet() {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT tweet_id, author_handle, created_at_ms, last_seen_at_ms
       FROM twitter_tweets
       ORDER BY created_at_ms DESC, tweet_id DESC
       LIMIT 1`
    )
    .get() as
    | {
        tweet_id: string;
        author_handle: string;
        created_at_ms: number;
        last_seen_at_ms: number;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    tweetId: row.tweet_id,
    authorHandle: row.author_handle,
    createdAtMs: row.created_at_ms,
    lastSeenAtMs: row.last_seen_at_ms,
  } satisfies TwitterLatestTweetSnapshot;
}

export function readLatestTwitterVisibleEvent() {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT event_id, timestamp, user_name
       FROM events
       WHERE source = 'twitter'
       ORDER BY timestamp DESC, event_id DESC
       LIMIT 1`
    )
    .get() as
    | {
        event_id: string;
        timestamp: number;
        user_name: string | null;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    eventId: row.event_id,
    timestamp: row.timestamp,
    userName: row.user_name || null,
  } satisfies TwitterLatestVisibleEventSnapshot;
}

export function readLatestTwitterRelay() {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT tweet_id,
              author_handle,
              created_at_ms,
              last_seen_at_ms,
              json_extract(source_json, '$.sourceChatId') AS source_chat_id,
              json_extract(source_json, '$.messageId') AS message_id
       FROM twitter_tweets
       WHERE json_extract(source_json, '$.provider') = 'bot2bot'
       ORDER BY last_seen_at_ms DESC, tweet_id DESC
       LIMIT 1`
    )
    .get() as
    | {
        tweet_id: string;
        author_handle: string;
        created_at_ms: number;
        last_seen_at_ms: number;
        source_chat_id: string | null;
        message_id: number | null;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    tweetId: row.tweet_id,
    authorHandle: row.author_handle,
    createdAtMs: row.created_at_ms,
    lastSeenAtMs: row.last_seen_at_ms,
    sourceChatId: row.source_chat_id || null,
    messageId: typeof row.message_id === 'number' ? row.message_id : null,
  } satisfies TwitterLatestRelaySnapshot;
}
