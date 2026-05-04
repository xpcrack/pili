import { NextResponse } from 'next/server';

import { listAddressManagementRows } from '@/lib/server/addressManagementRepo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({
      ok: true,
      rows: listAddressManagementRows(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '读取地址列表失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
