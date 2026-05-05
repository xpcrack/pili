import { NextRequest, NextResponse } from 'next/server';

import { readBidTradeExport } from '@/lib/server/bidTradeExport';
import { requireAdmin } from '@/lib/server/apiGuard';

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

export async function GET(request: NextRequest) {
  const unauthorizedResponse = requireAdmin(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  try {
    const limit = parseNumberParam(request.nextUrl.searchParams.get('limit'));
    const result = readBidTradeExport({
      userIds: parseUserIds(request),
      fromMs: parseNumberParam(request.nextUrl.searchParams.get('fromMs')),
      toMs: parseNumberParam(request.nextUrl.searchParams.get('toMs')),
      cursor: request.nextUrl.searchParams.get('cursor'),
      limit: limit === null ? undefined : limit,
    });

    return NextResponse.json({
      ok: true,
      trades: result.trades,
      nextCursor: result.nextCursor,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : '读取 BID 交易失败',
      },
      { status: 500 }
    );
  }
}
