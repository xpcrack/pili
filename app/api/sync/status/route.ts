import { NextResponse } from '@/lib/server/httpCompat';

import { getSyncStatus } from '@/lib/server/syncService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ ok: true, status: getSyncStatus() });
}
