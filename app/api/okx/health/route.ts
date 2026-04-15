import { NextResponse } from 'next/server';
import { getOkxConfigStatus } from '@/lib/okx';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { configured } = getOkxConfigStatus();

  return NextResponse.json({
    ok: configured,
    configured,
    message: configured ? 'OKX API 已配置' : '未配置 OKX API 凭证',
  });
}
