import 'server-only';

import { type TwitterLane } from '@/lib/server/twitterRepo';
import {
  asRecord,
  assertOkResponse,
  readBoolean,
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

const DEFAULT_XREAD_BASE_URL = 'http://65.109.123.54/consumer';

function resolveXreadPayload(value: unknown) {
  return readNestedRecord(value, 'data') || asRecord(value) || value;
}

function parseXreadUser(value: unknown): StructuredTwitterUser {
  const payload = resolveXreadPayload(value);
  const userResults = readNestedRecord(payload, 'user_results');
  const userRecord = readNestedRecord(userResults, 'result') || asRecord(payload);
  const userCore = readNestedRecord(userRecord, 'core') || readNestedRecord(userRecord, 'legacy') || userRecord;
  const id = readString(userResults, 'rest_id') || readString(userRecord, 'rest_id', 'id', 'userId', 'rest_id');
  const handle = normalizeTwitterUsername(
    readString(userCore, 'screen_name', 'userName', 'screenName', 'username') || ''
  );

  if (!id || !handle) {
    throw new Error('twitter_xread_user_lookup_parse_failed');
  }

  return {
    id,
    handle,
    name: readString(userCore, 'name', 'displayName'),
    description:
      readString(readNestedRecord(userRecord, 'profile_bio'), 'description') || readString(userCore, 'description', 'desc'),
    avatarUrl:
      readString(readNestedRecord(userRecord, 'avatar'), 'image_url') ||
      readString(userCore, 'profile_image_url_https', 'profilePicture', 'avatar', 'avatarUrl'),
    verified:
      readBoolean(readNestedRecord(userRecord, 'verification'), 'is_blue_verified', 'verified') ||
      readBoolean(userCore, 'verified'),
    raw: value,
  };
}

function readXreadNoteTweetText(payload: Record<string, unknown>, legacy: Record<string, unknown> | null) {
  const noteTweet =
    asRecord(payload.note_tweet) ||
    asRecord(payload.noteTweet) ||
    asRecord(legacy?.note_tweet) ||
    asRecord(legacy?.noteTweet);
  const noteResult =
    readNestedRecord(noteTweet, 'note_tweet_results', 'result') ||
    readNestedRecord(noteTweet, 'result') ||
    noteTweet;
  return readString(noteResult, 'text', 'full_text', 'fullText');
}

function parseXreadTweet(value: unknown, fallbackHandle?: string): StructuredTwitterTweet | null {
  const wrapper = asRecord(value);
  const tweetResults = readNestedRecord(wrapper, 'tweet_results') || wrapper;
  const payload =
    readNestedRecord(tweetResults, 'result') ||
    readNestedRecord(wrapper, 'result') ||
    wrapper;
  if (!payload) {
    return null;
  }

  const legacy = readNestedRecord(payload, 'legacy') || payload;
  const core = readNestedRecord(payload, 'core') || payload;
  const userResult =
    readNestedRecord(core, 'user_result') ||
    readNestedRecord(core, 'user_results') ||
    readNestedRecord(payload, 'author') ||
    readNestedRecord(payload, 'user');
  const userRecord = readNestedRecord(userResult, 'result') || asRecord(userResult);
  const userCore =
    readNestedRecord(userRecord, 'legacy') ||
    readNestedRecord(userRecord, 'core') ||
    asRecord(userRecord) ||
    asRecord(payload.author) ||
    asRecord(payload.user);
  const tweetId = readString(payload, 'rest_id', 'id', 'tweetId') || readString(tweetResults, 'rest_id');
  const authorHandle = normalizeTwitterUsername(
    readString(userCore, 'screen_name', 'userName', 'screenName', 'username') ||
      readString(payload, 'userName', 'screenName', 'username') ||
    fallbackHandle ||
      ''
  );
  const fullText = readXreadNoteTweetText(payload, legacy) || readString(legacy, 'full_text', 'text', 'fullText');
  const createdAtMs =
    toCreatedAtMs(legacy.created_at) ||
    toCreatedAtMs(payload.createdAt) ||
    toCreatedAtMs(payload.created_at) ||
    toCreatedAtMs(payload.createdAtMs) ||
    0;

  if (!tweetId || !authorHandle || !fullText || !createdAtMs) {
    return null;
  }

  const quotedTweet = asRecord(payload.quoted_tweet) || asRecord(payload.quotedTweet);
  const views = asRecord(payload.views);
  return {
    tweetId,
    authorId: readString(userRecord, 'rest_id', 'id', 'userId') || readString(userCore, 'id_str', 'id', 'userId'),
    authorHandle,
    authorName: readString(userCore, 'name', 'displayName'),
    fullText,
    createdAtMs,
    conversationId: readString(legacy, 'conversation_id_str', 'conversationId', 'conversation_id'),
    replyToTweetId: readString(
      legacy,
      'in_reply_to_status_id_str',
      'inReplyToId',
      'replyToTweetId'
    ),
    quoteTweetId:
      readString(legacy, 'quoted_status_id_str') ||
      readString(quotedTweet, 'id', 'tweetId', 'rest_id') ||
      readString(payload, 'quotedStatusId'),
    replyCount: readNumber(legacy, 'reply_count', 'replyCount'),
    retweetCount: readNumber(legacy, 'retweet_count', 'retweetCount'),
    likeCount: readNumber(legacy, 'favorite_count', 'likeCount', 'favoriteCount', 'likes'),
    viewCount: readNumber(views, 'count') || readNumber(payload, 'viewCount', 'view_count', 'views'),
    raw: value,
  };
}

export function parseXreadUserIdResponse(payload: unknown): TwitterProviderUserLookupResult {
  return {
    provider: 'xread',
    user: parseXreadUser(payload),
    raw: payload,
  };
}

export function parseXreadUserTweetsResponse(
  payload: unknown,
  options: { expectedHandle?: string } = {}
): TwitterProviderTweetsResult {
  const root = resolveXreadPayload(payload);
  const userResult = readNestedRecord(root, 'user_result_by_rest_id', 'result');
  const timeline =
    readNestedRecord(userResult, 'profile_timeline_v2', 'timeline') ||
    readNestedRecord(userResult, 'profile_with_replies_timeline_v2', 'timeline');
  const instructions = readArray(timeline, 'instructions');
  const candidates: unknown[] = [];
  let nextCursor: string | undefined;

  const visit = (node: unknown) => {
    const record = asRecord(node);
    if (!record) {
      return;
    }

    if (!nextCursor && readString(record, 'cursor_type') === 'Bottom') {
      nextCursor = readString(record, 'value') || nextCursor;
    }

    if (record.tweet_results) {
      candidates.push(record);
    }

    for (const value of Object.values(record)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item);
        }
      } else if (value && typeof value === 'object') {
        visit(value);
      }
    }
  };

  for (const instruction of instructions) {
    visit(instruction);
  }

  if (candidates.length === 0) {
    for (const item of readArray(root, 'tweets', 'data', 'items')) {
      candidates.push(item);
    }
  }

  const seenTweetIds = new Set<string>();
  const tweets = candidates
    .map((item) => parseXreadTweet(item, options.expectedHandle))
    .filter((item): item is StructuredTwitterTweet => {
      if (!item || seenTweetIds.has(item.tweetId)) {
        return false;
      }
      seenTweetIds.add(item.tweetId);
      return true;
    });
  const cursor = nextCursor || readCursor(root) || readCursor(timeline);

  return {
    provider: 'xread',
    userId:
      readString(readNestedRecord(root, 'user_result_by_rest_id'), 'rest_id') ||
      readString(root, 'userId', 'id'),
    handle:
      normalizeTwitterUsername(
        readString(
          readNestedRecord(root, 'user_result_by_rest_id', 'result', 'core'),
          'screen_name',
          'userName',
          'screenName'
        ) || options.expectedHandle || ''
      ) || undefined,
    tweets,
    nextCursor: cursor,
    hasMore: readHasMore(root, cursor) || Boolean(cursor),
    raw: payload,
  };
}

export function parseXreadTweetDetailResponse(payload: unknown): TwitterProviderTweetDetailResult {
  const root = resolveXreadPayload(payload);
  return {
    provider: 'xread',
    tweet: parseXreadTweet(readNestedRecord(root, 'tweet_result', 'result') || root),
    raw: payload,
  };
}

function buildXreadUrl(baseUrl: string, pathname: string, query: Record<string, string | undefined>) {
  const url = new URL(pathname, `${baseUrl.replace(/\/+$/, '')}/`);
  for (const [key, value] of Object.entries(query)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

async function getJson(fetchImpl: TwitterProviderFetch, url: string, apiKey: string) {
  const requestUrl = new URL(url);
  requestUrl.searchParams.set('api_key', apiKey);
  const response = await fetchImpl(requestUrl.toString(), {
    method: 'GET',
    headers: {
      accept: 'application/json',
    },
  });

  assertOkResponse(response, 'twitter_xread');
  return (await response.json()) as unknown;
}

export function createTwitterXreadClient(fetchImpl: TwitterProviderFetch = fetch) {
  const baseUrl = process.env.TWITTER_XREAD_BASE_URL || DEFAULT_XREAD_BASE_URL;
  const lookupUser = async (params: { apiKey: string; username: string }) => {
    const payload = await getJson(
      fetchImpl,
      buildXreadUrl(baseUrl, 'UserResultByScreenName', {
        username: normalizeTwitterUsername(params.username),
      }),
      params.apiKey
    );
    return parseXreadUserIdResponse(payload);
  };

  return {
    lookupUser,

    async fetchUserTweets(params: {
      apiKey: string;
      username: string;
      userId?: string;
      lane: TwitterLane;
      maxResults?: number;
      cursor?: string | null;
    }) {
      const userId =
        params.userId ||
        (
          await lookupUser({
            apiKey: params.apiKey,
            username: params.username,
          })
        ).user.id;
      const payload = await getJson(
        fetchImpl,
        buildXreadUrl(
          baseUrl,
          params.lane === 'replies' ? 'UserTweetsReplies' : 'UserTweets',
          {
            user_id: userId,
            count: String(params.maxResults || 40),
            cursor: params.cursor || undefined,
          }
        ),
        params.apiKey
      );
      return parseXreadUserTweetsResponse(payload, {
        expectedHandle: normalizeTwitterUsername(params.username),
      });
    },

    async fetchTweetById(params: { apiKey: string; tweetId: string }) {
      const payload = await getJson(
        fetchImpl,
        buildXreadUrl(baseUrl, 'TweetDetail', {
          tweet_id: params.tweetId,
        }),
        params.apiKey
      );
      return parseXreadTweetDetailResponse(payload);
    },
  };
}
