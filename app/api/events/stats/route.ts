import { NextResponse } from '@/lib/server/httpCompat';

import { readEventStats } from '@/lib/server/eventsRepo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    stats: readEventStats(),
  });
}
