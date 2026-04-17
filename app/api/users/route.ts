import { NextRequest, NextResponse } from 'next/server';

import { createTrackedUser, listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import { sanitizeUsersPayload } from '@/lib/server/userPayload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    users: listTrackedUsers(),
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const candidate = body?.user ?? body;
    const users = sanitizeUsersPayload([candidate]);

    if (users.length === 0) {
      return NextResponse.json({ ok: false, error: '用户参数无效' }, { status: 400 });
    }

    const source = users[0];
    const created = createTrackedUser({
      name: source.name,
      handle: source.handle,
      avatar: source.avatar,
      twitter: source.twitter,
      telegram: source.telegram,
      addresses: source.addresses,
      totalAssetUsd: source.totalAssetUsd,
      historicalMaxAssetUsd: source.historicalMaxAssetUsd,
      assetUpdatedAt: source.assetUpdatedAt,
      tags: source.tags,
    });

    return NextResponse.json({
      ok: true,
      user: created,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '创建用户失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
