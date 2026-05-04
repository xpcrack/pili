'use client';

import { type Activity, type User } from '@/types';
import {
  type ActivityFeedSummary,
  type AddressAssetSnapshot,
  type AddressDiagnostic,
} from '@/lib/activityFeed';

interface UserAssetSnapshot {
  userId: string;
  totalValueUsd: number;
  totalAssetUsd: number;
  updatedAt: number;
}

interface FeedPrewarmSnapshot {
  done: boolean;
  label: string;
  running: boolean;
  usersTotal: number;
  usersCovered: number;
}

export interface ActivityBreakdown {
  twitterCount: number;
  tradeCount: number;
}

export interface CompletenessWindow {
  scope: 'global' | 'user';
  startMs: number | null;
  endMs: number | null;
  label: string | null;
  complete: boolean;
}

export interface ActivityFeedResponse {
  ok: boolean;
  feed: { user: User; activity: Activity }[];
  users?: User[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  nextCursor?: string | null;
  historyComplete: boolean | null;
  localQualifiedCount: number;
  activityBreakdown: ActivityBreakdown | null;
  completenessWindow: CompletenessWindow | null;
  latestActivityAtByUser?: Record<string, number>;
  diagnostics: AddressDiagnostic[];
  summary: ActivityFeedSummary;
  addressAssets: AddressAssetSnapshot[];
  userAssets: UserAssetSnapshot[];
  prewarm?: FeedPrewarmSnapshot;
  sync?: {
    running?: boolean;
    latestRun?: {
      id?: number;
      status?: string;
      failedAddresses?: number;
      successfulAddresses?: number;
    } | null;
  };
  syncTrigger?: {
    started?: boolean;
    running?: boolean;
    runId?: number;
    startedAt?: number;
  };
}

interface FetchAllActivitiesOptions {
  page?: number;
  pageSize?: number;
  cursor?: string | null;
  userId?: string | null;
  search?: string | null;
  source?: Activity['source'] | null;
  syncStrategy?: 'refresh' | 'local' | 'backfill';
  backfillScope?: 'global' | 'user';
  backfillUserId?: string | null;
  reason?: string;
  signal?: AbortSignal;
}

const FEED_REQUEST_TIMEOUT_MS = 25000;
const FEED_BACKFILL_REQUEST_TIMEOUT_MS = 120000;
const FEED_429_RETRY_DELAYS_MS = [1000, 2000];

function buildFallbackSummary(users: User[], feedLength: number): ActivityFeedSummary {
  return {
    userCount: users.length,
    addressCount: users.reduce((sum, user) => sum + user.addresses.length, 0),
    transactionCount: feedLength,
    successfulAddressCount: 0,
    failedAddressCount: 0,
    emptyAddressCount: 0,
    completedAt: 0,
  };
}

function normalizeActivityBreakdown(value: unknown): ActivityBreakdown | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<ActivityBreakdown>;
  return {
    twitterCount:
      typeof candidate.twitterCount === 'number' && Number.isFinite(candidate.twitterCount)
        ? candidate.twitterCount
        : 0,
    tradeCount:
      typeof candidate.tradeCount === 'number' && Number.isFinite(candidate.tradeCount)
        ? candidate.tradeCount
        : 0,
  };
}

function normalizeCompletenessWindow(value: unknown): CompletenessWindow | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<CompletenessWindow>;
  const scope = candidate.scope === 'user' ? 'user' : candidate.scope === 'global' ? 'global' : null;
  if (!scope) {
    return null;
  }

  return {
    scope,
    startMs: typeof candidate.startMs === 'number' && Number.isFinite(candidate.startMs) ? candidate.startMs : null,
    endMs: typeof candidate.endMs === 'number' && Number.isFinite(candidate.endMs) ? candidate.endMs : null,
    label: typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label : null,
    complete: candidate.complete === true,
  };
}

function normalizePayloadUsers(payload: Partial<ActivityFeedResponse> | null | undefined) {
  return Array.isArray(payload?.users) ? payload.users : undefined;
}

function normalizeActivityFeedResponse(payload: Partial<ActivityFeedResponse> | null | undefined, users: User[]) {
  const feed = Array.isArray(payload?.feed) ? payload.feed : [];
  const total = typeof payload?.total === 'number' ? payload.total : feed.length;
  const pageSize = typeof payload?.pageSize === 'number' ? payload.pageSize : feed.length || 0;
  const page = typeof payload?.page === 'number' ? payload.page : 1;
  const responseUsers = normalizePayloadUsers(payload);

  return {
    ok: true,
    feed,
    users: responseUsers,
    total,
    page,
    pageSize,
    hasMore: payload?.hasMore === true,
    nextCursor: typeof payload?.nextCursor === 'string' && payload.nextCursor.trim() ? payload.nextCursor : null,
    historyComplete: typeof payload?.historyComplete === 'boolean' ? payload.historyComplete : null,
    localQualifiedCount: typeof payload?.localQualifiedCount === 'number' ? payload.localQualifiedCount : total,
    activityBreakdown: normalizeActivityBreakdown(payload?.activityBreakdown),
    completenessWindow: normalizeCompletenessWindow(payload?.completenessWindow),
    latestActivityAtByUser:
      payload?.latestActivityAtByUser && typeof payload.latestActivityAtByUser === 'object'
        ? payload.latestActivityAtByUser
        : {},
    diagnostics: Array.isArray(payload?.diagnostics) ? payload.diagnostics : [],
    summary: payload?.summary ?? buildFallbackSummary(users, feed.length),
    addressAssets: Array.isArray(payload?.addressAssets) ? payload.addressAssets : [],
    userAssets: Array.isArray(payload?.userAssets) ? payload.userAssets : [],
    prewarm:
      payload?.prewarm &&
      typeof payload.prewarm === 'object' &&
      typeof payload.prewarm.label === 'string' &&
      typeof payload.prewarm.done === 'boolean'
        ? {
            label: payload.prewarm.label,
            done: payload.prewarm.done,
            running: payload.prewarm.running === true,
            usersTotal:
              typeof payload.prewarm.usersTotal === 'number' && Number.isFinite(payload.prewarm.usersTotal)
                ? payload.prewarm.usersTotal
                : 0,
            usersCovered:
              typeof payload.prewarm.usersCovered === 'number' && Number.isFinite(payload.prewarm.usersCovered)
                ? payload.prewarm.usersCovered
                : 0,
          }
        : undefined,
    sync: payload?.sync,
    syncTrigger: payload?.syncTrigger,
  } satisfies ActivityFeedResponse;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) {
    return;
  }
  throw new DOMException('The operation was aborted.', 'AbortError');
}

function is429LikeError(status: number, message: string, payload: unknown) {
  if (status === 429) {
    return true;
  }

  const marker = /50011|Too Many Requests/i;
  if (marker.test(message)) {
    return true;
  }

  if (!payload) {
    return false;
  }

  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return marker.test(serialized);
}

export async function fetchAllActivities(
  users: User[],
  options?: FetchAllActivitiesOptions
): Promise<ActivityFeedResponse> {
  const maxRetryCount = FEED_429_RETRY_DELAYS_MS.length;
  const maxAttempts = maxRetryCount + 1;
  const page = typeof options?.page === 'number' ? Math.max(1, Math.floor(options.page)) : 1;
  const pageSize = typeof options?.pageSize === 'number' ? Math.max(1, Math.floor(options.pageSize)) : 200;
  const requestedSyncStrategy = options?.syncStrategy || 'refresh';
  const feedSourceMode = (process.env.NEXT_PUBLIC_FEED_SOURCE_MODE || '').trim().toLowerCase();
  const isTelegramMode = feedSourceMode === 'telegram';
  const syncStrategy = isTelegramMode ? 'local' : requestedSyncStrategy;
  const requestTimeoutMs =
    syncStrategy === 'backfill' ? FEED_BACKFILL_REQUEST_TIMEOUT_MS : FEED_REQUEST_TIMEOUT_MS;

  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (isTelegramMode) {
    query.set('mode', 'telegram');
  }
  if (typeof options?.cursor === 'string' && options.cursor.trim()) {
    query.set('cursor', options.cursor.trim());
  }
  if (typeof options?.userId === 'string' && options.userId.trim()) {
    query.set('userId', options.userId.trim());
  }
  if (typeof options?.search === 'string' && options.search.trim()) {
    query.set('search', options.search.trim());
  }
  if (typeof options?.source === 'string' && options.source.trim()) {
    query.set('source', options.source.trim());
  }

  const method = syncStrategy === 'local' ? 'GET' : 'POST';
  const bodyPayload =
    method === 'POST'
      ? {
          reason: options?.reason,
          mode: syncStrategy === 'backfill' ? 'backfill' : 'refresh',
          scope: options?.backfillScope === 'user' ? 'user' : 'global',
          syncUserId:
            typeof options?.backfillUserId === 'string' && options.backfillUserId.trim()
              ? options.backfillUserId.trim()
              : null,
        }
      : null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    throwIfAborted(options?.signal);

    const controller = new AbortController();
    let abortedByExternalSignal = false;
    let detachExternalAbortListener: (() => void) | null = null;
    if (options?.signal) {
      if (options.signal.aborted) {
        abortedByExternalSignal = true;
        controller.abort();
      } else {
        const handleExternalAbort = () => {
          abortedByExternalSignal = true;
          controller.abort();
        };
        options.signal.addEventListener('abort', handleExternalAbort, { once: true });
        detachExternalAbortListener = () => {
          options.signal?.removeEventListener('abort', handleExternalAbort);
        };
      }
    }

    const timer = setTimeout(() => {
      controller.abort();
    }, requestTimeoutMs);

    let response: Response;
    try {
      response = await fetch(`/api/feed?${query.toString()}`, {
        method,
        headers:
          method === 'POST'
            ? {
                'Content-Type': 'application/json',
              }
            : undefined,
        body: method === 'POST' ? JSON.stringify(bodyPayload) : undefined,
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      detachExternalAbortListener?.();

      if (error instanceof Error && error.name === 'AbortError' && abortedByExternalSignal) {
        throw error;
      }

      throw new Error(
        error instanceof Error && error.name === 'AbortError'
          ? `请求超时（>${requestTimeoutMs}ms）`
          : error instanceof Error
            ? `网络连接异常：${error.message}`
            : '网络连接异常，请稍后重试'
      );
    }
    clearTimeout(timer);
    detachExternalAbortListener?.();

    const data = await response.json().catch(() => null);
    if (response.ok && data?.ok) {
      return normalizeActivityFeedResponse(data as Partial<ActivityFeedResponse>, users);
    }

    const message = data?.error || `获取动态失败（HTTP ${response.status}）`;
    const retryable429 = is429LikeError(response.status, message, data);

    if (retryable429 && attempt < maxRetryCount) {
      const waitMs = FEED_429_RETRY_DELAYS_MS[attempt];
      console.warn(
        `[fetchAllActivities] 429 retry attempt ${attempt + 1}/${maxRetryCount}, wait ${waitMs}ms: ${message}`
      );
      throwIfAborted(options?.signal);
      await sleep(waitMs);
      throwIfAborted(options?.signal);
      continue;
    }

    if (retryable429) {
      console.error(`[fetchAllActivities] 429 failed after ${maxRetryCount} retries: ${message}`);
    }

    throw new Error(message);
  }

  throw new Error('获取动态失败');
}
