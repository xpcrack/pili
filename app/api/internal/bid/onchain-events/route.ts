import { NextRequest, NextResponse } from 'next/server';

import { requireInternalBidAuth } from '@/lib/server/internalBidAuth';
import { readBidOnchainEvents, type BidOnchainEventCursor } from '@/lib/server/telegramMonitorFeed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseUserIds(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get('userIds') || '';
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseNumberParam(value: string | null) {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCursor(raw: string | null): BidOnchainEventCursor | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { eventTimeMs?: unknown; eventId?: unknown };
    if (typeof parsed.eventTimeMs !== 'number' || !Number.isFinite(parsed.eventTimeMs)) {
      return null;
    }
    if (typeof parsed.eventId !== 'string' || !parsed.eventId.trim()) {
      return null;
    }
    return {
      eventTimeMs: Math.floor(parsed.eventTimeMs),
      eventId: parsed.eventId.trim(),
    };
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const unauthorizedResponse = requireInternalBidAuth(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  try {
    const limit = parseNumberParam(request.nextUrl.searchParams.get('limit'));
    const result = await readBidOnchainEvents({
      userIds: parseUserIds(request),
      fromMs: parseNumberParam(request.nextUrl.searchParams.get('fromMs')),
      toMs: parseNumberParam(request.nextUrl.searchParams.get('toMs')),
      cursor: parseCursor(request.nextUrl.searchParams.get('cursor')),
      limit: limit === null ? undefined : limit,
    });

    return NextResponse.json({
      ok: true,
      events: result.events,
      nextCursor: result.nextCursor,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : '读取 BID 事件失败',
      },
      { status: 500 }
    );
  }
}
