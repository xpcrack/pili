import 'server-only';

import {
  upsertEventTweetRef,
  type EventTweetRefSource,
} from '@/lib/server/twitterEnrichmentRepo';
import {
  listTwitterTweetsByIds,
  upsertTwitterTweets,
  type UpsertTwitterTweetInput,
} from '@/lib/server/twitterRepo';
import { projectTwitterTweetsToFeed } from '@/lib/server/twitterFeedMapper';

const STATUS_URL_PATTERN = /https?:\/\/(?:x\.com|twitter\.com)\/(?:[A-Za-z0-9_]+|i)\/status\/\d+(?:\?[^\s]*)?/gi;

export function parseTweetIdFromUrl(urlText: string) {
  const trimmed = (urlText || '').trim();
  if (!trimmed) return '';

  try {
    const url = new URL(trimmed);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'x.com' && hostname !== 'twitter.com') {
      return '';
    }
    const match = url.pathname.match(/\/(?:[A-Za-z0-9_]+|i)\/status\/(\d+)/i);
    return match?.[1] || '';
  } catch {
    return '';
  }
}

export function collectTwitterStatusUrls(text: string) {
  const normalized = (text || '').trim();
  if (!normalized) {
    return [] as string[];
  }

  const urls = new Set<string>();
  let match: RegExpExecArray | null;
  STATUS_URL_PATTERN.lastIndex = 0;
  while ((match = STATUS_URL_PATTERN.exec(normalized))) {
    const value = (match[0] || '').trim();
    if (!value) continue;
    if (!parseTweetIdFromUrl(value)) continue;
    urls.add(value);
  }

  return Array.from(urls);
}

export async function upsertEventTweetRefAndFetchMissing(params: {
  eventId: string;
  tweetUrls: string[];
  refSource: EventTweetRefSource;
  fetchTweetsByIds: (ids: string[]) => Promise<{ provider: string; tweets: UpsertTwitterTweetInput[] }>;
}) {
  const tweetIds = Array.from(
    new Set(
      params.tweetUrls
        .map((urlText) => parseTweetIdFromUrl(urlText))
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );

  for (const tweetId of tweetIds) {
    upsertEventTweetRef({
      eventId: params.eventId,
      tweetId,
      refSource: params.refSource,
      discoveredAtMs: Date.now(),
    });
  }

  if (tweetIds.length === 0) {
    return {
      refCount: 0,
      missingCount: 0,
      fetchedCount: 0,
    };
  }

  const existingTweetIds = new Set(listTwitterTweetsByIds(tweetIds).map((item) => item.tweetId));
  const missingIds = tweetIds.filter((tweetId) => !existingTweetIds.has(tweetId));
  if (missingIds.length === 0) {
    return {
      refCount: tweetIds.length,
      missingCount: 0,
      fetchedCount: 0,
    };
  }

  const fetched = await params.fetchTweetsByIds(missingIds);
  if (fetched.tweets.length > 0) {
    upsertTwitterTweets(fetched.tweets);
    projectTwitterTweetsToFeed({
      sinceMs: 0,
      tweetIds: fetched.tweets.map((item) => item.tweetId),
    });
  }

  return {
    refCount: tweetIds.length,
    missingCount: missingIds.length,
    fetchedCount: fetched.tweets.length,
  };
}
