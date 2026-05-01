import { NextRequest, NextResponse } from 'next/server';

import {
  importTrackedUsers,
  listTrackedUsers,
  TrackedAddressOwnershipConflictError,
} from '@/lib/server/trackedUsersRepo';
import { InvalidTrackedAddressError } from '@/lib/trackedAddressValidation';
import { sanitizeUsersPayload } from '@/lib/server/userPayload';
import {
  mergeTwitterIdentityIntoUser,
  resolveTwitterIdentityForHandle,
} from '@/lib/server/twitterIdentityService';

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
    const hydratedUsers = await Promise.all(
      users.map(async (user) =>
        mergeTwitterIdentityIntoUser(user, await resolveTwitterIdentityForHandle(user.twitter))
      )
    );
    const result = importTrackedUsers(hydratedUsers, { replaceExisting });

    return NextResponse.json({
      ok: true,
      importedCount: result.importedCount,
      users: listTrackedUsers(),
    });
  } catch (error) {
    if (error instanceof TrackedAddressOwnershipConflictError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
    }
    if (error instanceof InvalidTrackedAddressError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : '批量导入失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
