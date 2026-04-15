'use client';

import { type Activity, type User } from '@/types';
import { type ActivityFeedSummary, type AddressDiagnostic } from '@/lib/activityFeed';

export interface ActivityFeedResponse {
  ok: boolean;
  feed: { user: User; activity: Activity }[];
  diagnostics: AddressDiagnostic[];
  summary: ActivityFeedSummary;
}

export async function fetchAllActivities(
  users: User[]
): Promise<ActivityFeedResponse> {
  let response: Response;
  try {
    response = await fetch('/api/feed', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ users }),
      cache: 'no-store',
    });
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `网络连接异常：${error.message}`
        : '网络连接异常，请稍后重试'
    );
  }

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `获取动态失败（HTTP ${response.status}）`);
  }

  return data as ActivityFeedResponse;
}
