import { NextRequest, NextResponse } from 'next/server';

import { importTrackedUsers, listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import { sanitizeUsersPayload } from '@/lib/server/userPayload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const users = sanitizeUsersPayload(body?.users);
    if (users.length === 0) {
      return NextResponse.json({ ok: false, error: '导入数据为空或格式无效' }, { status: 400 });
    }

    const replaceExisting = body?.replaceExisting === true;
    const result = importTrackedUsers(users, { replaceExisting });

    return NextResponse.json({
      ok: true,
      importedCount: result.importedCount,
      users: listTrackedUsers(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '批量导入失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
