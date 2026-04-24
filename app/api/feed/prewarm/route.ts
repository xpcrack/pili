import { NextResponse } from 'next/server';

import {
  readPrewarmProgressSnapshot,
  triggerStartupPrewarmIfNeeded,
} from '@/lib/server/feedPrewarmService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ ok: true, prewarm: readPrewarmProgressSnapshot() });
}

export async function POST() {
  const trigger = triggerStartupPrewarmIfNeeded();
  return NextResponse.json({ ok: true, trigger, prewarm: readPrewarmProgressSnapshot() });
}
