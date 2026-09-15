import 'server-only';

import { type Activity, type User } from '@/types';
import { cleanTwitterDisplayText } from '@/lib/activityCardSocial';
import { getDb, withTransaction } from '@/lib/server/sqlite';
import { upsertEventsFromFeedRows } from '@/lib/server/eventsRepo';
import { scoreFeedRowsAgainstDatabase } from '@/lib/server/activityImportanceService';
import {
  listTwitterTweetEnrichmentsByTweetIds,
  listTwitterTweetTokenMentionsByTweetIds,
  type StoredTwitterTweetEnrichment,
  type StoredTwitterTweetTokenMention,
} from '@/lib/server/twitterEnrichmentRepo';
import {
  listTwitterTweetsByAuthorAndWindow,
  listTwitterTweetsByIds,
  type StoredTwitterTweet,
} from '@/lib/server/twitterRepo';
import { listMonitoredUsers } from '@/lib/server/trackedUsersRepo';
import { normalizeTwitterHandle } from '@/lib/userProfile';
import {
  publishRuleMentionsForTweet,
  runTweetEnrichmentForTweetIds,
} from '@/lib/server/twitterEnrichmentService';
import { extractQuotedTextFromSourceJson } from '@/lib/server/tweetSourceTexts';

function normalize(value: string | undefined | null) {
  return (value || '').trim().toLowerCase();
}

/**
 * Minimum age of the last attempt before a tweet stuck in
 * pending/processing is re-enqueued for enrichment. Must stay above the
 * slowest enrichment request (body call timeout) so an in-flight attempt is
 * never duplicated by the next projection cycle.
 */
const ENRICHMENT_RETRY_FLOOR_MS = 3 * 60_000;

/** How long a failed enrichment is left alone before it may be retried. */
const ENRICHMENT_FAILURE_BACKOFF_MS = 30 * 60_000;

/**
 * Whether a tweet's enrichment should be (re)queued this projection cycle.
 *
 * Extracted from the projector so the retry policy is testable on its own —
 * retries triggered from projection run fire-and-forget against the real model
 * and cannot be observed by injecting a stub.
 *
 * `now` is injectable for the same reason.
 */
export function shouldQueueEnrichment(
  enrich: StoredTwitterTweetEnrichment | undefined,
  now: number = Date.now(),
): boolean {
  if (!enrich) return true;
  const lastProcessedAt = enrich.lastProcessedAtMs ?? 0;
  if (enrich.translationStatus === 'pending' || enrich.translationStatus === 'processing') {
    // Still mid-flight (or crashed mid-flight): re-queue only once the previous
    // attempt is stale, so an in-flight relay call is never duplicated.
    return now - lastProcessedAt >= ENRICHMENT_RETRY_FLOOR_MS;
  }
  // B5: 毒丸退避——上一次处理刚失败且最近 30 分钟内已尝试过，则本轮跳过，
  // 避免同一个持续抛错的推文在每个投影周期都重跑整批 LLM/vision/DexScreener。
  if (enrich.lastError) {
    return now - lastProcessedAt >= ENRICHMENT_FAILURE_BACKOFF_MS;
  }
  return false;
}

function uniqStrings(values: Array<string | null>) {
  const deduped = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = (value || '').trim();
    if (!normalized) continue;
    if (deduped.has(normalized)) continue;
    deduped.add(normalized);
    result.push(normalized);
  }
  return result;
}

function readRelayAction(sourceJson: string): 'tweet' | 'quote' | 'reply' | null {
  try {
    const source = JSON.parse(sourceJson || '{}') as { provider?: unknown; action?: unknown };
    if (source.provider !== 'bot2bot') {
      return null;
    }
    return source.action === 'reply' || source.action === 'quote' || source.action === 'tweet'
      ? source.action
      : null;
  } catch {
    return null;
  }
}

function readRelayQuoteMetadata(sourceJson: string) {
  try {
    const source = JSON.parse(sourceJson || '{}') as {
      provider?: unknown;
      quotedAuthorHandle?: unknown;
      quotedContent?: unknown;
    };
    if (source.provider === 'bot2bot') {
      return {
        quotedAuthorHandle:
          typeof source.quotedAuthorHandle === 'string' ? source.quotedAuthorHandle.trim() : '',
        quotedContent: typeof source.quotedContent === 'string' ? source.quotedContent.trim() : '',
      };
    }
  } catch {
    // fall through
  }
  return {
    quotedAuthorHandle: '',
    quotedContent: extractQuotedTextFromSourceJson(sourceJson),
  };
}

function toActivity(
  tweet: StoredTwitterTweet,
  user: User,
  options: {
    enrichment?: StoredTwitterTweetEnrichment | null;
    mentions?: StoredTwitterTweetTokenMention[];
    quotedTweet?: StoredTwitterTweet | null;
    quotedEnrichment?: StoredTwitterTweetEnrichment | null;
  }
): Activity {
  const relayAction = readRelayAction(tweet.sourceJson);
  const relayQuote = readRelayQuoteMetadata(tweet.sourceJson);
  const isReply = relayAction === 'reply' || tweet.lane === 'replies' || Boolean(tweet.replyToTweetId);
  const isQuote =
    !isReply &&
    (relayAction === 'quote' || Boolean(tweet.quoteTweetId) || Boolean(relayQuote.quotedContent));
  const tweetKind: Activity['metadata']['tweetKind'] = isReply ? 'reply' : isQuote ? 'quote' : 'tweet';
  const title = isReply ? '回复推文' : isQuote ? '引用推文' : '发布推文';
  const enrichment = options.enrichment || null;
  const mentions = options.mentions || [];
  const mentionedTickers = uniqStrings(mentions.map((item) => item.tokenSymbol));
  const mentionedTokenAddresses = uniqStrings(mentions.map((item) => item.tokenAddress));
  const translationZh = enrichment?.translationZh?.trim() || '';
  const quotedTweet = options.quotedTweet || null;
  const quotedEnrichment = options.quotedEnrichment || null;
  const quotedTweetAuthorHandle = normalize(quotedTweet?.authorHandle || relayQuote.quotedAuthorHandle);
  const quotedTweetContent = cleanTwitterDisplayText(
    quotedTweet?.fullText || relayQuote.quotedContent || extractQuotedTextFromSourceJson(tweet.sourceJson) || ''
  );
  const quotedTweetTranslationZh =
    quotedEnrichment?.translationZh?.trim() ||
    enrichment?.quotedTranslationZh?.trim() ||
    '';
  const content = cleanTwitterDisplayText(tweet.fullText);

  return {
    id: `twitter:${tweet.tweetId}`,
    userId: user.id,
    source: 'twitter',
    type: 'post',
    title,
    content,
    timestamp: tweet.createdAtMs,
    metadata: {
      tweetId: tweet.tweetId,
      tweetUrl: `https://x.com/${tweet.authorHandle}/status/${tweet.tweetId}`,
      tweetKind,
      quotedTweetId: quotedTweet?.tweetId || tweet.quoteTweetId || undefined,
      quotedTweetUrl:
        quotedTweetAuthorHandle && (quotedTweet?.tweetId || tweet.quoteTweetId)
          ? `https://x.com/${quotedTweetAuthorHandle}/status/${quotedTweet?.tweetId || tweet.quoteTweetId}`
          : undefined,
      quotedTweetAuthorHandle: quotedTweetAuthorHandle || undefined,
      quotedTweetContent: quotedTweetContent || undefined,
      quotedTweetTranslationZh: quotedTweetTranslationZh || undefined,
      likes: Math.max(0, Math.floor(tweet.likeCount)),
      replies: Math.max(0, Math.floor(tweet.replyCount)),
      translationZh: translationZh || undefined,
      translationStatus: enrichment?.translationStatus || 'pending',
      mentionedTickers: mentionedTickers.length > 0 ? mentionedTickers : undefined,
      mentionedTokenAddresses: mentionedTokenAddresses.length > 0 ? mentionedTokenAddresses : undefined,
      tokenSentiments:
        mentions.length > 0
          ? mentions.map((item) => ({
              tokenSymbol: item.tokenSymbol || undefined,
              tokenAddress: item.tokenAddress || undefined,
              chain: item.chain || undefined,
              sentiment: item.sentiment,
              matchSource: item.matchSource,
              marketCapUsd: item.marketCapUsd || undefined,
              marketCapAtPostUsd: item.marketCapAtPostUsd || undefined,
              marketCapAtPostEstimated: item.marketCapAtPostEstimated || undefined,
              marketCapSource: item.marketCapSource || undefined,
            }))
          : undefined,
    },
  };
}

function upsertFeedRows(rows: Array<{ user: User; activity: Activity }>) {
  if (rows.length === 0) {
    return 0;
  }

  const updated = withTransaction(() => {
    const db = getDb();
    const now = Date.now();
    let updatedCount = 0;
    const stmt = db.prepare(
      `INSERT INTO activity_feed (
         user_id,
         activity_key,
         timestamp,
         source,
         type,
         user_json,
         activity_json,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(activity_key) DO UPDATE SET
         user_id = excluded.user_id,
         timestamp = excluded.timestamp,
         source = excluded.source,
         type = excluded.type,
         user_json = excluded.user_json,
         activity_json = excluded.activity_json`
    );

    for (const row of rows) {
      const activityKey = row.activity.metadata.tweetId
        ? `twitter:${row.activity.metadata.tweetId}`
        : row.activity.id;
      stmt.run(
        row.user.id,
        activityKey,
        row.activity.timestamp,
        row.activity.source,
        row.activity.type,
        JSON.stringify(row.user),
        JSON.stringify(row.activity),
        now
      );
      updatedCount += 1;
    }

    return updatedCount;
  });

  return updated;
}

export function projectTwitterTweetsToFeed(options: {
  sinceMs: number;
  userId?: string | null;
  tweetIds?: string[];
}) {
  const users = listMonitoredUsers();
  const userByTwitterUserId = new Map<string, User>();
  const userByTwitter = new Map<string, User>();
  for (const user of users) {
    const twitterUserId = (user.twitterUserId || '').trim();
    if (twitterUserId) {
      userByTwitterUserId.set(twitterUserId, user);
    }
    const twitterHandle = normalizeTwitterHandle(user.twitter || '');
    if (!twitterHandle) {
      continue;
    }
    userByTwitter.set(normalize(twitterHandle), user);
  }

  const hasUserFilter = typeof options.userId === 'string' && options.userId.trim().length > 0;
  const filteredUsers = hasUserFilter
    ? users.filter((user) => user.id === options.userId?.trim())
    : users;

  const tweetCandidates =
    Array.isArray(options.tweetIds) && options.tweetIds.length > 0
      ? listTwitterTweetsByIds(options.tweetIds)
      : filteredUsers.flatMap((user) => {
          const twitterHandle = normalizeTwitterHandle(user.twitter || '');
          if (!twitterHandle) {
            return [] as StoredTwitterTweet[];
          }
          return listTwitterTweetsByAuthorAndWindow({
            authorHandle: twitterHandle,
            authorUserId: user.twitterUserId || null,
            sinceMs: options.sinceMs,
          });
        });
  const tweetIds = tweetCandidates.map((tweet) => tweet.tweetId);
  const quotedTweetIds = uniqStrings(tweetCandidates.map((tweet) => tweet.quoteTweetId));
  const enrichmentRows = listTwitterTweetEnrichmentsByTweetIds([...tweetIds, ...quotedTweetIds]);
  const mentionRows = listTwitterTweetTokenMentionsByTweetIds(tweetIds);
  const quotedTweets = listTwitterTweetsByIds(quotedTweetIds);
  const enrichmentByTweetId = new Map(enrichmentRows.map((row) => [row.tweetId, row] as const));
  const quotedTweetById = new Map(quotedTweets.map((row) => [row.tweetId, row] as const));
  const mentionsByTweetId = new Map<string, StoredTwitterTweetTokenMention[]>();
  for (const row of mentionRows) {
    const list = mentionsByTweetId.get(row.tweetId) || [];
    list.push(row);
    mentionsByTweetId.set(row.tweetId, list);
  }

  const upsertRows: Array<{ user: User; activity: Activity }> = [];
  for (const tweet of tweetCandidates) {
    const matchedUser =
      (tweet.authorUserId ? userByTwitterUserId.get(tweet.authorUserId) : null) ||
      userByTwitter.get(normalize(tweet.authorHandle));
    if (!matchedUser) {
      continue;
    }
    if (hasUserFilter && matchedUser.id !== options.userId?.trim()) {
      continue;
    }
    if (tweet.createdAtMs < options.sinceMs) {
      continue;
    }

    const quotedTweet = tweet.quoteTweetId ? quotedTweetById.get(tweet.quoteTweetId) || null : null;
    upsertRows.push({
      user: matchedUser,
      activity: toActivity(tweet, matchedUser, {
        enrichment: enrichmentByTweetId.get(tweet.tweetId) || null,
        mentions: mentionsByTweetId.get(tweet.tweetId) || [],
        quotedTweet,
        quotedEnrichment: tweet.quoteTweetId
          ? enrichmentByTweetId.get(tweet.quoteTweetId) || null
          : null,
      }),
    });
  }

  const scoredRows = scoreFeedRowsAgainstDatabase(upsertRows);
  const projectedCount = upsertFeedRows(scoredRows);
  upsertEventsFromFeedRows(scoredRows, 'twitter-projector');

  // Trigger background enrichment for tweets that haven't been enriched yet
  // Legacy → model-v2 upgrades go through scripts/backfill-enrichment-v2.ts
  const pendingTweetIds = tweetCandidates
    .filter((tweet) => shouldQueueEnrichment(enrichmentByTweetId.get(tweet.tweetId)))
    .map((t) => t.tweetId);

  if (pendingTweetIds.length > 0) {
    // Sync rule extract FIRST (ms) so newone Bark can fire before LLM queue drains.
    const pendingTweets = listTwitterTweetsByIds(pendingTweetIds);
    let fastHits = 0;
    for (const tweet of pendingTweets) {
      try {
        fastHits += publishRuleMentionsForTweet(tweet);
      } catch (err) {
        console.warn(
          '[enrichment] sync fast-publish failed:',
          tweet.tweetId,
          err instanceof Error ? err.message : err
        );
      }
    }
    if (fastHits > 0) {
      console.log(`[enrichment] sync fast-publish mentions=${fastHits} tweets=${pendingTweets.length}`);
    }

    void runTweetEnrichmentForTweetIds({ tweetIds: pendingTweetIds })
      .then((result) => {
        if (result.succeeded > 0) {
          console.log(`[enrichment] ${result.succeeded}/${result.total} succeeded`);
          projectTwitterTweetsToFeed({ sinceMs: 0, tweetIds: pendingTweetIds });
        }
        if (result.failed > 0) {
          console.warn(`[enrichment] ${result.failed}/${result.total} failed`);
        }
      })
      .catch((err) => {
        console.warn('[enrichment] background enrichment error:', err instanceof Error ? err.message : err);
      });
  }

  return {
    projectedCount,
  };
}
