import 'server-only';

import { type Activity, type User } from '@/types';
import { getDb, withTransaction } from '@/lib/server/sqlite';
import { upsertEventsFromFeedRows } from '@/lib/server/eventsRepo';
import {
  listTwitterTweetsByAuthorAndWindow,
  listTwitterTweetsByIds,
  type StoredTwitterTweet,
} from '@/lib/server/twitterRepo';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import { normalizeTwitterHandle } from '@/lib/userProfile';

function normalize(value: string | undefined | null) {
  return (value || '').trim().toLowerCase();
}

function toActivity(tweet: StoredTwitterTweet, user: User): Activity {
  const isReply = tweet.lane === 'replies' || Boolean(tweet.replyToTweetId);
  const isQuote = !isReply && Boolean(tweet.quoteTweetId);
  const tweetKind: Activity['metadata']['tweetKind'] = isReply ? 'reply' : isQuote ? 'quote' : 'tweet';
  const title = isReply ? '回复推文' : isQuote ? '引用推文' : '发布推文';

  return {
    id: `twitter:${tweet.tweetId}`,
    userId: user.id,
    source: 'twitter',
    type: 'post',
    title,
    content: tweet.fullText,
    timestamp: tweet.createdAtMs,
    metadata: {
      tweetId: tweet.tweetId,
      tweetUrl: `https://x.com/${tweet.authorHandle}/status/${tweet.tweetId}`,
      tweetKind,
      likes: Math.max(0, Math.floor(tweet.likeCount)),
      replies: Math.max(0, Math.floor(tweet.replyCount)),
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

  upsertEventsFromFeedRows(rows, 'twitter-projector');
  return updated;
}

export function projectTwitterTweetsToFeed(options: {
  sinceMs: number;
  userId?: string | null;
  tweetIds?: string[];
}) {
  const users = listTrackedUsers();
  const userByTwitter = new Map<string, User>();
  for (const user of users) {
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
            sinceMs: options.sinceMs,
          });
        });

  const upsertRows: Array<{ user: User; activity: Activity }> = [];
  for (const tweet of tweetCandidates) {
    const matchedUser = userByTwitter.get(normalize(tweet.authorHandle));
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
      activity: toActivity(tweet, matchedUser),
    });
  }

  const projectedCount = upsertFeedRows(upsertRows);
  return {
    projectedCount,
  };
}
