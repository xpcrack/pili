import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/server/apiGuard';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseUserIds(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get('userIds') || '';
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function GET(request: NextRequest) {
  const unauthorizedResponse = requireAdmin(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  try {
    const requestedUserIds = new Set(parseUserIds(request));
    const users = listTrackedUsers()
      .filter((user) => requestedUserIds.size === 0 || requestedUserIds.has(user.id))
      .map((user) => ({
        userId: user.id,
        userName: user.name,
        addresses: user.addresses.map((address) => ({
          userId: user.id,
          userName: user.name,
          address: address.address,
          chain: address.chain,
          addressName: address.name,
        })),
      }));

    return NextResponse.json({
      ok: true,
      users,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : '读取 BID 用户失败',
      },
      { status: 500 }
    );
  }
}
