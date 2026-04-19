import { NextRequest, NextResponse } from 'next/server';

import { enforceAdminRateLimit, requireAdmin } from '@/lib/server/apiGuard';
import { type TwitterFetcherSeedByHandle } from '@/lib/server/twitterFetcher';
import { getTwitterSyncStatus, runTwitterSyncAction } from '@/lib/server/twitterSyncService';
import { type TwitterSyncAction } from '@/lib/server/twitterRepo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseAction(value: unknown): TwitterSyncAction {
  if (value === 'replay' || value === 'reconcile') {
    return value;
  }
  return 'sync';
}

function parseWindowDays(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.min(30, Math.floor(value)));
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.min(30, parsed));
    }
  }
  return 7;
}

function parseSeedByHandle(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as TwitterFetcherSeedByHandle;
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    status: getTwitterSyncStatus(),
  });
}

export async function POST(request: NextRequest) {
  const unauthorizedResponse = requireAdmin(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  const rateLimitResponse = enforceAdminRateLimit(request, {
    endpoint: 'twitter-sync',
    max: 12,
    windowMs: 60_000,
  });
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const body = await request.json().catch(() => ({}));
    const result = await runTwitterSyncAction({
      action: parseAction(body?.action),
      userId: typeof body?.userId === 'string' && body.userId.trim() ? body.userId.trim() : null,
      windowDays: parseWindowDays(body?.windowDays),
      seedByHandle: parseSeedByHandle(body?.seedByHandle),
    });

    if (!result.ok) {
      return NextResponse.json(result, {
        status: result.errorCode === 'lease_not_acquired' ? 409 : 500,
      });
    }

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'twitter 同步失败',
      },
      { status: 500 }
    );
  }
}
