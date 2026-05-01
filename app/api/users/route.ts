import { NextRequest, NextResponse } from 'next/server';

import {
  createTrackedUser,
  listTrackedUsers,
  TrackedAddressOwnershipConflictError,
} from '@/lib/server/trackedUsersRepo';
import { InvalidTrackedAddressError } from '@/lib/trackedAddressValidation';
import { sanitizeUsersPayload } from '@/lib/server/userPayload';
import {
  mergeTwitterIdentityIntoUser,
  resolveTwitterIdentityForHandle,
} from '@/lib/server/twitterIdentityService';
import { listTwitterRelayCoverageByHandles } from '@/lib/server/twitterRepo';
import { normalizeTwitterHandle } from '@/lib/userProfile';
import { type User } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function addTwitterRelayCoverage(users: User[]) {
  const coverageByHandle = listTwitterRelayCoverageByHandles(
    users.map((user) => normalizeTwitterHandle(user.twitter || '')).filter((handle): handle is string => Boolean(handle))
  );

  return users.map((user) => {
    const handle = normalizeTwitterHandle(user.twitter || '').toLowerCase();
    const coverage = handle ? coverageByHandle.get(handle) || null : null;
    if (!coverage) {
      return {
        ...user,
        relayCoverage: null,
      };
    }

    return {
      ...user,
      relayCoverage: {
        latestTweetId: coverage.latestTweetId,
        latestLastSeenAtMs: coverage.latestLastSeenAtMs,
        tweetCount: coverage.tweetCount,
      },
    };
  });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    users: addTwitterRelayCoverage(listTrackedUsers()),
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

    const source = mergeTwitterIdentityIntoUser(
      users[0],
      await resolveTwitterIdentityForHandle(users[0].twitter)
    );
    const created = createTrackedUser({
      name: source.name,
      handle: source.handle,
      avatar: source.avatar,
      twitter: source.twitter,
      twitterUserId: source.twitterUserId,
      twitterAvatarUrl: source.twitterAvatarUrl,
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
    if (error instanceof TrackedAddressOwnershipConflictError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
    }
    if (error instanceof InvalidTrackedAddressError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : '创建用户失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
