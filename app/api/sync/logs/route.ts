import { NextRequest, NextResponse } from 'next/server';

import { readSyncLogs, type SyncRunKind } from '@/lib/server/syncLogRepo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseRunKind(value: string | null): SyncRunKind | null {
  if (value === 'sync' || value === 'twitter') {
    return value;
  }
  return null;
}

function parseIntQuery(value: string | null) {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function GET(request: NextRequest) {
  try {
    const runKind = parseRunKind(request.nextUrl.searchParams.get('runKind'));
    const runId = parseIntQuery(request.nextUrl.searchParams.get('runId'));
    const afterId = parseIntQuery(request.nextUrl.searchParams.get('afterId'));
    const limit = parseIntQuery(request.nextUrl.searchParams.get('limit'));

    const logs = readSyncLogs({
      runKind,
      runId,
      afterId,
      limit: limit ?? 200,
    });

    return NextResponse.json({
      ok: true,
      logs,
      lastId: logs.length > 0 ? logs[logs.length - 1].id : afterId || 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '读取同步日志失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
