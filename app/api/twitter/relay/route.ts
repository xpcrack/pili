import { NextResponse } from 'next/server';

import {
  authorizeTwitterRelayHeaders,
  ingestTwitterRelayPayload,
  type TwitterRelayPayload,
} from '@/lib/server/twitterRelayIngest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = authorizeTwitterRelayHeaders(request.headers);
  if (!auth.ok) {
    return NextResponse.json(auth.body, { status: auth.status });
  }

  const payload = (await request.json().catch(() => null)) as TwitterRelayPayload | null;
  if (!payload) {
    return NextResponse.json({ ok: false, error: 'invalid json body' }, { status: 400 });
  }

  const result = await ingestTwitterRelayPayload(payload);
  return NextResponse.json(result);
}
