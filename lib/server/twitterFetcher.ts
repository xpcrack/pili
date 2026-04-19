import 'server-only';

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { type TwitterLane, type UpsertTwitterTweetInput } from '@/lib/server/twitterRepo';

export type TwitterFetcherTweet = Omit<UpsertTwitterTweetInput, 'lane'>;
export type TwitterFetcherProvider = 'opencli' | 'dokobot' | 'seed' | 'fixture' | 'noop';

export interface TwitterFetcherResult {
  provider: TwitterFetcherProvider;
  tweets: UpsertTwitterTweetInput[];
}

export interface TwitterFetcherSeedByHandle {
  [handle: string]: {
    timeline?: TwitterFetcherTweet[];
    replies?: TwitterFetcherTweet[];
    byId?: TwitterFetcherTweet[];
  };
}

type RealProviderMode = 'auto' | 'opencli' | 'dokobot' | 'fixture';

interface CliExecutionResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

const TWITTER_EPOCH_MS = 1288834974657;
const DEFAULT_FETCH_TIMEOUT_MS = 45_000;
const DEFAULT_OPENCLI_DETAIL_TIMEOUT_MS = 20_000;
const DEFAULT_OPENCLI_DETAIL_ENRICH_LIMIT = 0;
const DEFAULT_DOKOBOT_TIMEOUT_SEC = 45;

const STATUS_URL_PATTERN = /https?:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/gi;

function normalize(value: string | undefined | null) {
  return (value || '').trim().toLowerCase();
}

function normalizeRealProviderMode(value: string | undefined | null): RealProviderMode {
  const normalized = normalize(value);
  if (normalized === 'opencli' || normalized === 'dokobot' || normalized === 'fixture') {
    return normalized;
  }
  return 'auto';
}

function toSafeInt(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === 'string') {
    const cleaned = value.trim();
    if (!cleaned) return 0;
    const suffix = cleaned.slice(-1).toLowerCase();
    const multiplier =
      suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : suffix === 'b' ? 1_000_000_000 : 1;
    const base = multiplier === 1 ? cleaned : cleaned.slice(0, -1);
    const parsed = Number.parseFloat(base.replace(/,/g, ''));
    if (!Number.isFinite(parsed)) {
      const intParsed = Number.parseInt(cleaned.replace(/[^\d]/g, ''), 10);
      return Number.isFinite(intParsed) ? Math.max(0, intParsed) : 0;
    }
    return Math.max(0, Math.floor(parsed * multiplier));
  }
  return 0;
}

function toCreatedAtMs(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return 0;
    const asInt = Number.parseInt(raw, 10);
    if (Number.isFinite(asInt) && asInt > 0) {
      return asInt;
    }
    const asDate = Date.parse(raw);
    if (Number.isFinite(asDate) && asDate > 0) {
      return asDate;
    }
  }
  return 0;
}

function getTweetCreatedAtFromSnowflake(tweetId: string) {
  try {
    const id = BigInt(tweetId);
    if (id <= BigInt(0)) {
      return 0;
    }
    const timestamp = Number((id >> BigInt(22)) + BigInt(TWITTER_EPOCH_MS));
    return Number.isFinite(timestamp) ? timestamp : 0;
  } catch {
    return 0;
  }
}

function extractQuoteTweetId(text: string, selfTweetId: string) {
  let match: RegExpExecArray | null;
  STATUS_URL_PATTERN.lastIndex = 0;
  while ((match = STATUS_URL_PATTERN.exec(text))) {
    const targetId = (match[2] || '').trim();
    if (!targetId || targetId === selfTweetId) {
      continue;
    }
    return targetId;
  }
  return undefined;
}

function normalizeTweet(raw: Record<string, unknown>, lane: TwitterLane): UpsertTwitterTweetInput | null {
  const tweetId =
    (typeof raw.tweetId === 'string' && raw.tweetId.trim()) ||
    (typeof raw.id === 'string' && raw.id.trim()) ||
    (typeof raw.tweet_id === 'string' && raw.tweet_id.trim()) ||
    '';
  const authorHandle =
    normalize(
      (typeof raw.authorHandle === 'string' && raw.authorHandle) ||
        (typeof raw.author === 'string' && raw.author) ||
        (typeof raw.author_handle === 'string' && raw.author_handle) ||
        ''
    ) || '';
  const fullText =
    (typeof raw.fullText === 'string' && raw.fullText.trim()) ||
    (typeof raw.text === 'string' && raw.text.trim()) ||
    '';
  const createdAtMs =
    toCreatedAtMs(raw.createdAtMs ?? raw.created_at_ms ?? raw.created_at) ||
    getTweetCreatedAtFromSnowflake(tweetId);

  if (!tweetId || !authorHandle || !fullText || !createdAtMs) {
    return null;
  }

  const quoteTweetId =
    (typeof raw.quoteTweetId === 'string' && raw.quoteTweetId.trim()) ||
    (typeof raw.quoted_tweet_id === 'string' && raw.quoted_tweet_id.trim()) ||
    extractQuoteTweetId(fullText, tweetId);

  return {
    tweetId,
    authorHandle,
    authorName:
      (typeof raw.authorName === 'string' && raw.authorName.trim()) ||
      (typeof raw.author_name === 'string' && raw.author_name.trim()) ||
      undefined,
    fullText,
    createdAtMs,
    lane,
    conversationId:
      (typeof raw.conversationId === 'string' && raw.conversationId.trim()) ||
      (typeof raw.conversation_id === 'string' && raw.conversation_id.trim()) ||
      undefined,
    replyToTweetId:
      (typeof raw.replyToTweetId === 'string' && raw.replyToTweetId.trim()) ||
      (typeof raw.in_reply_to === 'string' && raw.in_reply_to.trim()) ||
      (typeof raw.in_reply_to_status_id_str === 'string' && raw.in_reply_to_status_id_str.trim()) ||
      (typeof raw.in_reply_to_tweet_id === 'string' && raw.in_reply_to_tweet_id.trim()) ||
      undefined,
    quoteTweetId,
    replyCount: toSafeInt(raw.replyCount ?? raw.reply_count ?? raw.replies),
    retweetCount: toSafeInt(raw.retweetCount ?? raw.retweet_count ?? raw.retweets),
    likeCount: toSafeInt(raw.likeCount ?? raw.like_count ?? raw.likes),
    viewCount: toSafeInt(raw.viewCount ?? raw.view_count ?? raw.views),
    source: raw,
  } satisfies UpsertTwitterTweetInput;
}

function readTweetsFromFile(filepath: string, lane: TwitterLane) {
  if (!existsSync(filepath)) {
    return [] as UpsertTwitterTweetInput[];
  }
  try {
    const raw = JSON.parse(readFileSync(filepath, 'utf8')) as unknown;
    if (!Array.isArray(raw)) {
      return [] as UpsertTwitterTweetInput[];
    }
    return raw
      .map((item) => normalizeTweet((item || {}) as Record<string, unknown>, lane))
      .filter((item): item is UpsertTwitterTweetInput => Boolean(item));
  } catch {
    return [] as UpsertTwitterTweetInput[];
  }
}

function readFixtureById(filepath: string) {
  if (!existsSync(filepath)) {
    return new Map<string, UpsertTwitterTweetInput>();
  }
  try {
    const parsed = JSON.parse(readFileSync(filepath, 'utf8')) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { tweets?: unknown[] }).tweets)
        ? (parsed as { tweets: unknown[] }).tweets
        : [];
    const map = new Map<string, UpsertTwitterTweetInput>();
    for (const item of list) {
      const normalized = normalizeTweet((item || {}) as Record<string, unknown>, 'timeline');
      if (!normalized) {
        continue;
      }
      map.set(normalized.tweetId, normalized);
    }
    return map;
  } catch {
    return new Map<string, UpsertTwitterTweetInput>();
  }
}

function fromSeedTweet(tweet: TwitterFetcherTweet, lane: TwitterLane) {
  return normalizeTweet(tweet as unknown as Record<string, unknown>, lane);
}

function sortAndFilterTweets(tweets: UpsertTwitterTweetInput[], sinceMs: number, maxItems: number) {
  const normalizedSinceMs = Math.max(0, Math.floor(sinceMs));
  const normalizedMax = Math.max(1, Math.min(500, Math.floor(maxItems)));
  return tweets
    .filter((tweet) => tweet.createdAtMs >= normalizedSinceMs)
    .sort((a, b) => {
      if (b.createdAtMs !== a.createdAtMs) {
        return b.createdAtMs - a.createdAtMs;
      }
      return b.tweetId.localeCompare(a.tweetId);
    })
    .slice(0, normalizedMax);
}

function runCliBinary(command: string, args: string[], timeoutMs: number): CliExecutionResult {
  const spawned = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
  });

  const stdout = (spawned.stdout || '').trim();
  const stderr = (spawned.stderr || '').trim();
  if (spawned.error) {
    return {
      ok: false,
      stdout,
      stderr,
      error: spawned.error.message,
    };
  }

  if (spawned.status !== 0) {
    return {
      ok: false,
      stdout,
      stderr,
      error: `exit ${spawned.status}`,
    };
  }

  return {
    ok: true,
    stdout,
    stderr,
  };
}

function parseCliJsonOutput(stdout: string) {
  const text = stdout.trim();
  if (!text) return null;

  const candidates: string[] = [text];
  const firstArray = text.indexOf('[');
  const lastArray = text.lastIndexOf(']');
  if (firstArray >= 0 && lastArray > firstArray) {
    candidates.push(text.slice(firstArray, lastArray + 1));
  }
  const firstObject = text.indexOf('{');
  const lastObject = text.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) {
    candidates.push(text.slice(firstObject, lastObject + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }
  return null;
}

function unwrapJsonArray(value: unknown) {
  if (Array.isArray(value)) {
    return value as Array<Record<string, unknown>>;
  }
  if (value && typeof value === 'object') {
    const candidateArray =
      (value as { data?: unknown }).data ||
      (value as { results?: unknown }).results ||
      (value as { items?: unknown }).items;
    if (Array.isArray(candidateArray)) {
      return candidateArray as Array<Record<string, unknown>>;
    }
  }
  return [] as Array<Record<string, unknown>>;
}

function queryByLane(handle: string, lane: TwitterLane) {
  if (lane === 'replies') {
    return `from:${handle} filter:replies`;
  }
  return `from:${handle} -filter:replies`;
}

function fetchFromOpencliSearch(params: {
  handle: string;
  lane: TwitterLane;
  maxItems: number;
  timeoutMs: number;
}) {
  const query = queryByLane(params.handle, params.lane);
  const result = runCliBinary(
    'opencli',
    ['twitter', 'search', query, '--limit', String(params.maxItems), '-f', 'json'],
    params.timeoutMs
  );
  if (!result.ok) {
    return {
      ok: false as const,
      error: result.stderr || result.error || 'opencli search failed',
      tweets: [] as UpsertTwitterTweetInput[],
    };
  }

  const parsed = parseCliJsonOutput(result.stdout);
  const rows = unwrapJsonArray(parsed);
  const tweets = rows
    .map((row) => normalizeTweet(row, params.lane))
    .filter((tweet): tweet is UpsertTwitterTweetInput => Boolean(tweet))
    .filter((tweet) => normalize(tweet.authorHandle) === normalize(params.handle));

  return {
    ok: true as const,
    tweets,
  };
}

function fetchTweetDetailFromOpencli(tweetId: string, timeoutMs: number) {
  const result = runCliBinary(
    'opencli',
    ['twitter', 'thread', tweetId, '--limit', '1', '-f', 'json'],
    timeoutMs
  );
  if (!result.ok) {
    return null;
  }
  const parsed = parseCliJsonOutput(result.stdout);
  const rows = unwrapJsonArray(parsed);
  const detailRow = rows.find((row) => {
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    return id === tweetId;
  }) || rows[0];
  return detailRow ? (detailRow as Record<string, unknown>) : null;
}

function fetchFromOpencliUser(params: {
  handle: string;
  lane: TwitterLane;
  sinceMs: number;
  maxItems: number;
}) {
  const timeoutMs = Math.max(
    10_000,
    Number.parseInt(process.env.TWITTER_FETCH_TIMEOUT_MS || '', 10) || DEFAULT_FETCH_TIMEOUT_MS
  );
  const detailTimeoutMs = Math.max(
    8_000,
    Number.parseInt(process.env.TWITTER_OPENCLI_DETAIL_TIMEOUT_MS || '', 10) || DEFAULT_OPENCLI_DETAIL_TIMEOUT_MS
  );
  const enrichLimit = Math.max(
    0,
    Number.parseInt(process.env.TWITTER_OPENCLI_DETAIL_ENRICH_LIMIT || '', 10) ||
      DEFAULT_OPENCLI_DETAIL_ENRICH_LIMIT
  );

  const fetched = fetchFromOpencliSearch({
    handle: params.handle,
    lane: params.lane,
    maxItems: params.maxItems,
    timeoutMs,
  });
  if (!fetched.ok) {
    return {
      ok: false as const,
      error: fetched.error,
      tweets: [] as UpsertTwitterTweetInput[],
    };
  }

  const shouldEnrichDetails = params.lane === 'replies' && enrichLimit > 0;
  const scopedTweets = sortAndFilterTweets(fetched.tweets, params.sinceMs, params.maxItems);
  const detailCount = shouldEnrichDetails ? Math.min(enrichLimit, scopedTweets.length) : 0;
  const enriched = scopedTweets.map((tweet, index) => {
    if (index >= detailCount) {
      return tweet;
    }
    const detail = fetchTweetDetailFromOpencli(tweet.tweetId, detailTimeoutMs);
    if (!detail) {
      return tweet;
    }
    const normalizedDetail = normalizeTweet(detail, params.lane);
    if (!normalizedDetail) {
      return tweet;
    }
    return {
      ...tweet,
      fullText: normalizedDetail.fullText || tweet.fullText,
      createdAtMs: normalizedDetail.createdAtMs || tweet.createdAtMs,
      replyToTweetId: normalizedDetail.replyToTweetId || tweet.replyToTweetId,
      quoteTweetId: normalizedDetail.quoteTweetId || tweet.quoteTweetId,
      retweetCount: normalizedDetail.retweetCount || tweet.retweetCount,
      likeCount: normalizedDetail.likeCount || tweet.likeCount,
      source: {
        search: tweet.source,
        detail,
      },
    } satisfies UpsertTwitterTweetInput;
  });

  return {
    ok: true as const,
    tweets: enriched,
  };
}

function fetchFromOpencliByIds(ids: string[]) {
  const detailTimeoutMs = Math.max(
    8_000,
    Number.parseInt(process.env.TWITTER_OPENCLI_DETAIL_TIMEOUT_MS || '', 10) || DEFAULT_OPENCLI_DETAIL_TIMEOUT_MS
  );
  const tweets: UpsertTwitterTweetInput[] = [];
  for (const id of ids) {
    const detail = fetchTweetDetailFromOpencli(id, detailTimeoutMs);
    if (!detail) {
      continue;
    }
    const normalized = normalizeTweet(detail, 'timeline');
    if (!normalized) {
      continue;
    }
    tweets.push(normalized);
  }
  return tweets;
}

function extractTweetIdsFromText(text: string) {
  const ids: Array<{ handle: string; tweetId: string; line: string }> = [];
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    let match: RegExpExecArray | null;
    STATUS_URL_PATTERN.lastIndex = 0;
    while ((match = STATUS_URL_PATTERN.exec(line))) {
      ids.push({
        handle: normalize(match[1]),
        tweetId: (match[2] || '').trim(),
        line,
      });
    }
  }
  return ids;
}

function fetchFromDokobotUser(params: {
  handle: string;
  lane: TwitterLane;
  sinceMs: number;
  maxItems: number;
}) {
  const timeoutSec = Math.max(
    10,
    Number.parseInt(process.env.TWITTER_DOKOBOT_TIMEOUT_SEC || '', 10) || DEFAULT_DOKOBOT_TIMEOUT_SEC
  );
  const query = queryByLane(params.handle, params.lane);
  const url =
    params.lane === 'timeline'
      ? `https://x.com/${encodeURIComponent(params.handle)}`
      : `https://x.com/search?q=${encodeURIComponent(query)}&f=live`;
  const readResult = runCliBinary(
    'dokobot',
    ['read', '--local', '--timeout', String(timeoutSec), '--format', 'text', url],
    timeoutSec * 1000 + 5_000
  );
  if (!readResult.ok) {
    return {
      ok: false as const,
      error: readResult.stderr || readResult.error || 'dokobot read failed',
      tweets: [] as UpsertTwitterTweetInput[],
    };
  }

  const candidates = extractTweetIdsFromText(readResult.stdout)
    .filter((item) => item.tweetId)
    .filter((item) => {
      if (params.lane === 'timeline') {
        return !item.handle || item.handle === normalize(params.handle);
      }
      return true;
    });
  const deduped = new Map<string, UpsertTwitterTweetInput>();
  for (const item of candidates) {
    const cleanedText = item.line.replace(STATUS_URL_PATTERN, '').trim() || `tweet ${item.tweetId}`;
    const normalized = normalizeTweet(
      {
        id: item.tweetId,
        author: params.handle,
        text: cleanedText,
      },
      params.lane
    );
    if (!normalized) {
      continue;
    }
    deduped.set(normalized.tweetId, normalized);
  }

  return {
    ok: true as const,
    tweets: sortAndFilterTweets(Array.from(deduped.values()), params.sinceMs, params.maxItems),
  };
}

function fetchFromDokobotByIds(ids: string[]) {
  const timeoutSec = Math.max(
    10,
    Number.parseInt(process.env.TWITTER_DOKOBOT_TIMEOUT_SEC || '', 10) || DEFAULT_DOKOBOT_TIMEOUT_SEC
  );
  const tweets: UpsertTwitterTweetInput[] = [];
  for (const id of ids.slice(0, 20)) {
    const url = `https://x.com/i/status/${id}`;
    const result = runCliBinary(
      'dokobot',
      ['read', '--local', '--timeout', String(timeoutSec), '--format', 'text', url],
      timeoutSec * 1000 + 5_000
    );
    if (!result.ok) {
      continue;
    }
    const firstTextLine =
      result.stdout
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith('http')) || `tweet ${id}`;
    const normalized = normalizeTweet(
      {
        id,
        author: 'unknown',
        text: firstTextLine,
      },
      'timeline'
    );
    if (!normalized) {
      continue;
    }
    tweets.push(normalized);
  }
  return tweets;
}

function fetchSeedUserTweets(
  seedByHandle: TwitterFetcherSeedByHandle | undefined,
  handle: string,
  lane: TwitterLane,
  sinceMs: number,
  maxItems: number
) {
  const seed = seedByHandle?.[handle]?.[lane] || [];
  const seedTweets = Array.isArray(seed)
    ? seed
        .map((item) => fromSeedTweet(item, lane))
        .filter((item): item is UpsertTwitterTweetInput => Boolean(item))
    : [];
  return sortAndFilterTweets(seedTweets, sinceMs, maxItems);
}

function fetchSeedByIds(seedByHandle: TwitterFetcherSeedByHandle | undefined, ids: string[]) {
  const target = new Set(ids.map((id) => id.trim()).filter(Boolean));
  if (target.size === 0) {
    return [] as UpsertTwitterTweetInput[];
  }

  const matches = new Map<string, UpsertTwitterTweetInput>();
  if (!seedByHandle) {
    return [] as UpsertTwitterTweetInput[];
  }

  for (const handleSeed of Object.values(seedByHandle)) {
    for (const item of handleSeed.byId || []) {
      const normalizedSeed = fromSeedTweet(item, 'timeline');
      if (!normalizedSeed) {
        continue;
      }
      if (!target.has(normalizedSeed.tweetId)) {
        continue;
      }
      matches.set(normalizedSeed.tweetId, normalizedSeed);
    }
  }

  return Array.from(matches.values());
}

function logProviderFailure(provider: 'opencli' | 'dokobot', context: string, error: string) {
  console.warn(`[twitterFetcher] ${provider} ${context} failed: ${error}`);
}

export function createTwitterFetcher(seedByHandle?: TwitterFetcherSeedByHandle) {
  const fixtureRoot = path.join(process.cwd(), '.data', 'twitter-fixtures');
  const byIdFixtureFile = path.join(fixtureRoot, 'by-id.json');
  const providerMode = normalizeRealProviderMode(process.env.TWITTER_FETCH_PROVIDER);

  return {
    fetchUserTweets(params: {
      handle: string;
      lane: TwitterLane;
      sinceMs: number;
      maxItems: number;
    }): TwitterFetcherResult {
      const handle = normalize(params.handle);
      if (!handle) {
        return { provider: 'noop', tweets: [] };
      }

      const seedTweets = fetchSeedUserTweets(seedByHandle, handle, params.lane, params.sinceMs, params.maxItems);
      if (seedTweets.length > 0) {
        return {
          provider: 'seed',
          tweets: seedTweets,
        };
      }

      const tryOpencli = providerMode === 'auto' || providerMode === 'opencli';
      if (tryOpencli) {
        const opencli = fetchFromOpencliUser({
          handle,
          lane: params.lane,
          sinceMs: params.sinceMs,
          maxItems: params.maxItems,
        });
        if (opencli.ok) {
          return {
            provider: 'opencli',
            tweets: opencli.tweets,
          };
        }
        if (!opencli.ok) {
          logProviderFailure('opencli', 'fetchUserTweets', opencli.error);
        }
      }

      const tryDokobot = providerMode === 'auto' || providerMode === 'dokobot';
      if (tryDokobot) {
        const dokobot = fetchFromDokobotUser({
          handle,
          lane: params.lane,
          sinceMs: params.sinceMs,
          maxItems: params.maxItems,
        });
        if (dokobot.ok) {
          return {
            provider: 'dokobot',
            tweets: dokobot.tweets,
          };
        }
        if (!dokobot.ok) {
          logProviderFailure('dokobot', 'fetchUserTweets', dokobot.error);
        }
      }

      if (providerMode === 'auto' || providerMode === 'fixture') {
        const fixtureFile = path.join(fixtureRoot, `${handle}-${params.lane}.json`);
        const fixtureTweets = readTweetsFromFile(fixtureFile, params.lane);
        if (fixtureTweets.length > 0) {
          return {
            provider: 'fixture',
            tweets: sortAndFilterTweets(fixtureTweets, params.sinceMs, params.maxItems),
          };
        }
      }

      return {
        provider: 'noop',
        tweets: [],
      };
    },

    fetchTweetsByIds(params: { ids: string[] }): TwitterFetcherResult {
      const ids = Array.from(new Set(params.ids.map((item) => item.trim()).filter(Boolean)));
      if (ids.length === 0) {
        return { provider: 'noop', tweets: [] };
      }

      const seedMatches = fetchSeedByIds(seedByHandle, ids);
      if (seedMatches.length > 0) {
        return {
          provider: 'seed',
          tweets: seedMatches,
        };
      }

      const tryOpencli = providerMode === 'auto' || providerMode === 'opencli';
      if (tryOpencli) {
        const opencliMatches = fetchFromOpencliByIds(ids);
        if (opencliMatches.length > 0) {
          return {
            provider: 'opencli',
            tweets: opencliMatches,
          };
        }
      }

      const tryDokobot = providerMode === 'auto' || providerMode === 'dokobot';
      if (tryDokobot) {
        const dokobotMatches = fetchFromDokobotByIds(ids);
        if (dokobotMatches.length > 0) {
          return {
            provider: 'dokobot',
            tweets: dokobotMatches,
          };
        }
      }

      if (providerMode === 'auto' || providerMode === 'fixture') {
        const fixtureMap = readFixtureById(byIdFixtureFile);
        const fixtureMatches = ids
          .map((id) => fixtureMap.get(id))
          .filter((item): item is UpsertTwitterTweetInput => Boolean(item));
        if (fixtureMatches.length > 0) {
          return {
            provider: 'fixture',
            tweets: fixtureMatches,
          };
        }
      }

      return {
        provider: 'noop',
        tweets: [],
      };
    },
  };
}
