import { NextResponse } from 'next/server';

import {
  authorizeTelegramMonitorHeaders,
  ingestTelegramMonitorUpdate,
  type TelegramUpdateLike,
} from '@/lib/server/telegramMonitorIngest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = authorizeTelegramMonitorHeaders(request.headers);
  if (!auth.ok) {
    return NextResponse.json(auth.body, { status: auth.status });
  }

  const body = (await request.json().catch(() => null)) as TelegramUpdateLike | null;
  if (!body) {
    return NextResponse.json({ ok: false, error: '请求体必须是 JSON' }, { status: 400 });
  }

  const payload = await ingestTelegramMonitorUpdate(body);
  return NextResponse.json(payload);
}
