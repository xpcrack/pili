import { NextRequest, NextResponse } from 'next/server';

import { getSyncStatus, triggerSync } from '@/lib/server/syncService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'manual';
    const trigger = triggerSync(reason);
    return NextResponse.json({
      ok: true,
      trigger,
      status: getSyncStatus(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '触发同步失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, status: getSyncStatus() });
}
