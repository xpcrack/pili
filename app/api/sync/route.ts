import { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/server/apiGuard';
import { apiError, apiOk } from '@/lib/server/apiResponse';
import { getSyncStatus, triggerSync } from '@/lib/server/syncService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const unauthorizedResponse = requireAdmin(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  try {
    const body = await request.json().catch(() => null);
    const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'manual';
    const trigger = triggerSync(reason);
    return apiOk({ trigger, status: getSyncStatus() });
  } catch (error) {
    return apiError(error, { fallback: '触发同步失败' });
  }
}

export async function GET() {
  return apiOk({ status: getSyncStatus() });
}
