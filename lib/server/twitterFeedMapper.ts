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
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import { normalizeTwitterHandle } from '@/lib/userProfile';
import { runTweetEnrichmentForTweetIds } from '@/lib/server/twitterEnrichmentService';

function normalize(value: string | undefined | null) {
  return (value || '').trim().toLowerCase();
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
    if (source.provider !== 'bot2bot') {
      return {
        quotedAuthorHandle: '',
        quotedContent: '',
      };
    }

    return {
      quotedAuthorHandle: typeof source.quotedAuthorHandle === 'string' ? source.quotedAuthorHandle.trim() : '',
      quotedContent: typeof source.quotedContent === 'string' ? source.quotedContent.trim() : '',
    };
  } catch {
    return {
      quotedAuthorHandle: '',
      quotedContent: '',
    };
  }
}

function toActivity(
  tweet: StoredTwitterTweet,
  user: User,
  options: {
    enrichment?: StoredTwitterTweetEnrichment | null;
    mentions?: StoredTwitterTweetTokenMention[];
    quotedTweet?: StoredTwitterTweet | null;
  }
): Activity {
  const relayAction = readRelayAction(tweet.sourceJson);
  const isReply = relayAction === 'reply' || tweet.lane === 'replies' || Boolean(tweet.replyToTweetId);
  const isQuote = !isReply && (relayAction === 'quote' || Boolean(tweet.quoteTweetId));
  const tweetKind: Activity['metadata']['tweetKind'] = isReply ? 'reply' : isQuote ? 'quote' : 'tweet';
  const title = isReply ? '回复推文' : isQuote ? '引用推文' : '发布推文';
  const enrichment = options.enrichment || null;
  const mentions = options.mentions || [];
  const mentionedTickers = uniqStrings(mentions.map((item) => item.tokenSymbol));
  const mentionedTokenAddresses = uniqStrings(mentions.map((item) => item.tokenAddress));
  const translationZh = enrichment?.translationZh?.trim() || '';
  const relayQuote = readRelayQuoteMetadata(tweet.sourceJson);
  const quotedTweet = options.quotedTweet || null;
  const quotedTweetAuthorHandle = normalize(quotedTweet?.authorHandle || relayQuote.quotedAuthorHandle);
  const quotedTweetContent = cleanTwitterDisplayText(quotedTweet?.fullText || relayQuote.quotedContent || '');
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
  const users = listTrackedUsers();
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
  const enrichmentRows = listTwitterTweetEnrichmentsByTweetIds(tweetIds);
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

    upsertRows.push({
      user: matchedUser,
      activity: toActivity(tweet, matchedUser, {
        enrichment: enrichmentByTweetId.get(tweet.tweetId) || null,
        mentions: mentionsByTweetId.get(tweet.tweetId) || [],
        quotedTweet: tweet.quoteTweetId ? quotedTweetById.get(tweet.quoteTweetId) || null : null,
      }),
    });
  }

  const scoredRows = scoreFeedRowsAgainstDatabase(upsertRows);
  const projectedCount = upsertFeedRows(scoredRows);
  upsertEventsFromFeedRows(scoredRows, 'twitter-projector');

  // Trigger background enrichment for tweets that haven't been enriched yet
  const pendingTweetIds = tweetCandidates
    .filter((tweet) => {
      const enrich = enrichmentByTweetId.get(tweet.tweetId);
      return !enrich || enrich.translationStatus === 'pending';
    })
    .map((t) => t.tweetId);

  if (pendingTweetIds.length > 0) {
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
