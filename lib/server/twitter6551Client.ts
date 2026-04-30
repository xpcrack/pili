import 'server-only';

import { type TwitterLane } from '@/lib/server/twitterRepo';
import {
  asRecord,
  assertOkResponse,
  normalizeTwitterUsername,
  readArray,
  readCursor,
  readHasMore,
  readNestedRecord,
  readNumber,
  readString,
  toCreatedAtMs,
  type StructuredTwitterTweet,
  type StructuredTwitterUser,
  type TwitterProviderFetch,
  type TwitterProviderTweetDetailResult,
  type TwitterProviderTweetsResult,
  type TwitterProviderUserLookupResult,
} from '@/lib/server/twitterProviderTypes';

const DEFAULT_6551_BASE_URL = 'https://ai.6551.io';
const USER_TWEETS_MAX_RESULTS = 100;

function resolve6551Payload(value: unknown) {
  return readNestedRecord(value, 'data') || asRecord(value) || value;
}

function parse6551User(value: unknown): StructuredTwitterUser {
  const payload = resolve6551Payload(value);
  const id = readString(payload, 'userId', 'id', 'restId');
  const handle = normalizeTwitterUsername(
    readString(payload, 'screenName', 'userScreenName', 'username', 'userName') || ''
  );

  if (!id || !handle) {
    throw new Error('twitter_6551_user_lookup_parse_failed');
  }

  return {
    id,
    handle,
    name: readString(payload, 'name', 'userName', 'displayName'),
    description: readString(payload, 'description', 'desc', 'bio'),
    avatarUrl: readString(payload, 'profileImageUrl', 'avatar', 'avatarUrl'),
    verified:
      typeof payload === 'object'
        ? (asRecord(payload)?.verified as boolean | undefined)
        : undefined,
    raw: value,
  };
}

function parse6551Tweet(value: unknown, fallbackHandle?: string): StructuredTwitterTweet | null {
  const payload = asRecord(value);
  if (!payload) {
    return null;
  }

  const tweetId = readString(payload, 'id', 'tweetId', 'tweet_id');
  const authorHandle = normalizeTwitterUsername(
    readString(
      payload,
      'userScreenName',
      'screenName',
      'authorHandle',
      'author',
      'userName',
      'username'
    ) || fallbackHandle || ''
  );
  const fullText = readString(payload, 'text', 'fullText', 'full_text');
  const createdAtMs =
    toCreatedAtMs(payload.createdAt) ||
    toCreatedAtMs(payload.created_at) ||
    toCreatedAtMs(payload.createdAtMs) ||
    0;

  if (!tweetId || !authorHandle || !fullText || !createdAtMs) {
    return null;
  }

  return {
    tweetId,
    authorId: readString(payload, 'userId', 'authorId'),
    authorHandle,
    authorName: readString(payload, 'userName', 'name', 'authorName'),
    fullText,
    createdAtMs,
    conversationId: readString(payload, 'conversationId', 'conversation_id'),
    replyToTweetId: readString(
      payload,
      'inReplyToStatusId',
      'in_reply_to_status_id_str',
      'replyToTweetId',
      'inReplyToId'
    ),
    quoteTweetId: readString(payload, 'quotedStatusId', 'quoteTweetId', 'quoted_tweet_id'),
    replyCount: readNumber(payload, 'replyCount', 'replies'),
    retweetCount: readNumber(payload, 'retweetCount', 'retweets'),
    likeCount: readNumber(payload, 'favoriteCount', 'likeCount', 'likes'),
    viewCount: readNumber(payload, 'viewCount', 'views'),
    raw: value,
  };
}

export function parse6551UserLookupResponse(payload: unknown): TwitterProviderUserLookupResult {
  return {
    provider: '6551',
    user: parse6551User(payload),
    raw: payload,
  };
}

export function parse6551UserTweetsResponse(
  payload: unknown,
  options: { expectedHandle?: string } = {}
): TwitterProviderTweetsResult {
  const root = resolve6551Payload(payload);
  const cursor = readCursor(root);
  const tweets = readArray(root, 'tweets', 'items', 'data')
    .map((item) => parse6551Tweet(item, options.expectedHandle))
    .filter((item): item is StructuredTwitterTweet => Boolean(item));

  return {
    provider: '6551',
    userId: readString(root, 'userId', 'authorId'),
    handle: normalizeTwitterUsername(
      readString(root, 'screenName', 'userScreenName', 'username', 'userName') ||
        options.expectedHandle ||
        ''
    ) || undefined,
    tweets,
    nextCursor: cursor,
    hasMore: readHasMore(root, cursor),
    raw: payload,
  };
}

export function parse6551TweetByIdResponse(payload: unknown): TwitterProviderTweetDetailResult {
  const root = resolve6551Payload(payload);
  return {
    provider: '6551',
    tweet: parse6551Tweet(root),
    raw: payload,
  };
}

async function postJson(fetchImpl: TwitterProviderFetch, url: string, apiKey: string, body: Record<string, unknown>) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  assertOkResponse(response, 'twitter_6551');
  return (await response.json()) as unknown;
}

export function createTwitter6551Client(fetchImpl: TwitterProviderFetch = fetch) {
  const baseUrl = (process.env.TWITTER_6551_BASE_URL || DEFAULT_6551_BASE_URL).replace(/\/+$/, '');

  return {
    async lookupUser(params: { apiKey: string; username: string }) {
      const payload = await postJson(fetchImpl, `${baseUrl}/open/twitter_user_info`, params.apiKey, {
        username: normalizeTwitterUsername(params.username),
      });
      return parse6551UserLookupResponse(payload);
    },

    async fetchUserTweets(params: {
      apiKey: string;
      username: string;
      lane: TwitterLane;
      maxResults?: number;
      cursor?: string | null;
    }) {
      const payload = await postJson(fetchImpl, `${baseUrl}/open/twitter_user_tweets`, params.apiKey, {
        username: normalizeTwitterUsername(params.username),
        includeReplies: params.lane === 'replies',
        includeRetweets: false,
        maxResults: USER_TWEETS_MAX_RESULTS,
        product: 'Latest',
        cursor: params.cursor || undefined,
      });
      return parse6551UserTweetsResponse(payload, {
        expectedHandle: normalizeTwitterUsername(params.username),
      });
    },

    async fetchTweetById(params: { apiKey: string; tweetId: string }) {
      const payload = await postJson(fetchImpl, `${baseUrl}/open/twitter_tweet_detail`, params.apiKey, {
        tweetId: params.tweetId,
      });
      return parse6551TweetByIdResponse(payload);
    },
  };
}
