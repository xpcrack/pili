import 'server-only';

import { type TwitterLane } from '@/lib/server/twitterRepo';

export type StructuredTwitterProvider = '6551' | 'xread';
export type TwitterProviderIntent = 'resolve-id' | 'sync' | 'backfill' | 'detail';
export type StructuredTwitterLane = TwitterLane | 'none';
export type TwitterProviderFetch = typeof fetch;

export interface StructuredTwitterUser {
  id: string;
  handle: string;
  name?: string;
  description?: string;
  avatarUrl?: string;
  verified?: boolean;
  raw: unknown;
}

export interface StructuredTwitterTweet {
  tweetId: string;
  authorId?: string;
  authorHandle: string;
  authorName?: string;
  fullText: string;
  createdAtMs: number;
  conversationId?: string;
  replyToTweetId?: string;
  quoteTweetId?: string;
  replyCount: number;
  retweetCount: number;
  likeCount: number;
  viewCount: number;
  raw: unknown;
}

export interface TwitterProviderUserLookupResult {
  provider: StructuredTwitterProvider;
  user: StructuredTwitterUser;
  raw: unknown;
}

export interface TwitterProviderTweetsResult {
  provider: StructuredTwitterProvider;
  userId?: string;
  handle?: string;
  tweets: StructuredTwitterTweet[];
  nextCursor?: string;
  hasMore: boolean;
  raw: unknown;
}

export interface TwitterProviderTweetDetailResult {
  provider: StructuredTwitterProvider;
  tweet: StructuredTwitterTweet | null;
  raw: unknown;
}

export function normalizeTwitterUsername(value: string) {
  return value.trim().replace(/^@+/, '').toLowerCase();
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readNestedRecord(value: unknown, ...keys: string[]) {
  let current = asRecord(value);
  for (const key of keys) {
    if (!current) {
      return null;
    }
    current = asRecord(current[key]);
  }
  return current;
}

export function readString(value: unknown, ...keys: string[]) {
  for (const key of keys) {
    const record = asRecord(value);
    const candidate = record?.[key];
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed) {
        return trimmed;
      }
    }
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }
  return undefined;
}

export function readBoolean(value: unknown, ...keys: string[]) {
  const record = asRecord(value);
  for (const key of keys) {
    if (typeof record?.[key] === 'boolean') {
      return record[key] as boolean;
    }
  }
  return undefined;
}

export function readArray(value: unknown, ...keys: string[]) {
  const direct = Array.isArray(value) ? value : null;
  if (direct) {
    return direct;
  }
  const record = asRecord(value);
  for (const key of keys) {
    if (Array.isArray(record?.[key])) {
      return record[key] as unknown[];
    }
  }
  return [];
}

export function readNumber(value: unknown, ...keys: string[]) {
  const record = asRecord(value);
  for (const key of keys) {
    const candidate = record?.[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return Math.max(0, Math.floor(candidate));
    }
    if (typeof candidate === 'string') {
      const parsed = Number.parseInt(candidate.replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(parsed)) {
        return Math.max(0, parsed);
      }
    }
  }
  return 0;
}

export function readCursor(value: unknown) {
  return (
    readString(value, 'nextCursor', 'next_cursor', 'cursor', 'next') ||
    readString(readNestedRecord(value, 'data'), 'nextCursor', 'next_cursor', 'cursor', 'next') ||
    undefined
  );
}

export function readHasMore(value: unknown, fallbackFromCursor?: string) {
  const direct = readBoolean(value, 'hasMore', 'has_more');
  if (typeof direct === 'boolean') {
    return direct;
  }
  const nested = readBoolean(readNestedRecord(value, 'data'), 'hasMore', 'has_more');
  if (typeof nested === 'boolean') {
    return nested;
  }
  return Boolean(fallbackFromCursor);
}

export function toCreatedAtMs(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = Math.max(0, Math.floor(value));
    return normalized > 0 && normalized < 10_000_000_000 ? normalized * 1000 : normalized;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return 0;
    }
    const numeric = Number.parseInt(trimmed, 10);
    if (Number.isFinite(numeric) && numeric > 0 && /^[0-9]+$/.test(trimmed)) {
      return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 0;
}

export function assertOkResponse(response: Response, context: string) {
  if (!response.ok) {
    throw new Error(`${context}_http_${response.status}`);
  }
}
