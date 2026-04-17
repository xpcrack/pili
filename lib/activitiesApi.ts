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

export interface ActivityFeedResponse {
  ok: boolean;
  feed: { user: User; activity: Activity }[];
  total: number;
  latestActivityAtByUser?: Record<string, number>;
  diagnostics: AddressDiagnostic[];
  summary: ActivityFeedSummary;
  addressAssets: AddressAssetSnapshot[];
  userAssets: UserAssetSnapshot[];
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
  limit?: number;
  offset?: number;
  userId?: string | null;
  syncStrategy?: 'refresh' | 'local' | 'backfill';
  backfillScope?: 'global' | 'user';
  backfillUserId?: string | null;
  reason?: string;
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

function normalizeActivityFeedResponse(payload: Partial<ActivityFeedResponse> | null | undefined, users: User[]) {
  const feed = Array.isArray(payload?.feed) ? payload.feed : [];
  const total = typeof payload?.total === 'number' ? payload.total : feed.length;

  return {
    ok: true,
    feed,
    total,
    latestActivityAtByUser:
      payload?.latestActivityAtByUser && typeof payload.latestActivityAtByUser === 'object'
        ? payload.latestActivityAtByUser
        : {},
    diagnostics: Array.isArray(payload?.diagnostics) ? payload.diagnostics : [],
    summary: payload?.summary ?? buildFallbackSummary(users, feed.length),
    addressAssets: Array.isArray(payload?.addressAssets) ? payload.addressAssets : [],
    userAssets: Array.isArray(payload?.userAssets) ? payload.userAssets : [],
    sync: payload?.sync,
    syncTrigger: payload?.syncTrigger,
  } satisfies ActivityFeedResponse;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const limit = typeof options?.limit === 'number' ? Math.max(1, Math.floor(options.limit)) : 200;
  const offset = typeof options?.offset === 'number' ? Math.max(0, Math.floor(options.offset)) : 0;
  const syncStrategy = options?.syncStrategy || 'refresh';
  const requestTimeoutMs =
    syncStrategy === 'backfill' ? FEED_BACKFILL_REQUEST_TIMEOUT_MS : FEED_REQUEST_TIMEOUT_MS;

  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (typeof options?.userId === 'string' && options.userId.trim()) {
    query.set('userId', options.userId.trim());
  }

  const method = syncStrategy === 'local' ? 'GET' : 'POST';
  const bodyPayload =
    method === 'POST'
      ? {
          users,
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
    const controller = new AbortController();
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
      throw new Error(
        error instanceof Error && error.name === 'AbortError'
          ? `请求超时（>${requestTimeoutMs}ms）`
          : error instanceof Error
            ? `网络连接异常：${error.message}`
            : '网络连接异常，请稍后重试'
      );
    }
    clearTimeout(timer);

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
      await sleep(waitMs);
      continue;
    }

    if (retryable429) {
      console.error(`[fetchAllActivities] 429 failed after ${maxRetryCount} retries: ${message}`);
    }

    throw new Error(message);
  }

  throw new Error('获取动态失败');
}
