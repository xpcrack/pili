import { NextRequest } from 'next/server';

import { apiError, apiOk } from '@/lib/server/apiResponse';
import { readSyncLogs, type SyncRunKind } from '@/lib/server/syncLogRepo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseRunKind(value: string | null): SyncRunKind | null {
  if (value === 'sync' || value === 'twitter' || value === 'completeness') {
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

    const logs = readSyncLogs({ runKind, runId, afterId, limit: limit ?? 200 });

    return apiOk({
      logs,
      lastId: logs.length > 0 ? logs[logs.length - 1].id : afterId || 0,
    });
  } catch (error) {
    return apiError(error, { fallback: '读取同步日志失败' });
  }
}
