import { NextRequest, NextResponse } from 'next/server';

import {
  deleteTrackedUser,
  listTrackedUsers,
  TrackedAddressOwnershipConflictError,
  updateTrackedUser,
} from '@/lib/server/trackedUsersRepo';
import {
  readUserHoldingsDetails,
  UserHoldingsDetailsUnavailableError,
} from '@/lib/server/userHoldingsDetails';
import { USER_HOLDINGS_THRESHOLD_USD } from '@/lib/userDetails';
import { InvalidTrackedAddressError } from '@/lib/trackedAddressValidation';
import { sanitizeUsersPayload } from '@/lib/server/userPayload';
import {
  mergeTwitterIdentityIntoUser,
  resolveTwitterIdentityForHandle,
} from '@/lib/server/twitterIdentityService';
import { notifyBid2MirrorSync } from '@/lib/server/bidSyncNotifier';
import { normalizeTwitterHandle } from '@/lib/userProfile';
import { type User } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface UserRouteContext {
  params: Promise<{ id: string }>;
}

interface GetUserDetailsHandlerDependencies {
  listUsers?: typeof listTrackedUsers;
  readHoldingsDetails?: typeof readUserHoldingsDetails;
}

function normalizeOptionalString(value: unknown) {
  if (value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function sanitizeUpdatePayload(id: string, body: unknown): Partial<User> {
  if (!body || typeof body !== 'object') {
    return {};
  }

  const candidate = body as Partial<User>;
  const updates: Partial<User> = {};

  if (typeof candidate.name === 'string') {
    updates.name = candidate.name;
  }
  if (typeof candidate.handle === 'string') {
    updates.handle = candidate.handle;
  }
  if (typeof candidate.avatar === 'string') {
    updates.avatar = candidate.avatar;
  }
  if ('twitter' in candidate) {
    updates.twitter = normalizeOptionalString(candidate.twitter);
  }
  if ('twitterUserId' in candidate) {
    updates.twitterUserId = normalizeOptionalString(candidate.twitterUserId);
  }
  if ('twitterAvatarUrl' in candidate) {
    updates.twitterAvatarUrl = normalizeOptionalString(candidate.twitterAvatarUrl);
  }
  if ('telegram' in candidate) {
    updates.telegram = normalizeOptionalString(candidate.telegram);
  }
  if (Array.isArray(candidate.tags)) {
    updates.tags = candidate.tags.filter((tag): tag is string => typeof tag === 'string');
  }

  if (Array.isArray(candidate.addresses)) {
    const [sanitized] = sanitizeUsersPayload([
      {
        id,
        name: candidate.name || 'tmp',
        handle: candidate.handle || 'tmp',
        avatar: candidate.avatar || 'tmp',
        tags: Array.isArray(candidate.tags) ? candidate.tags : [],
        addresses: candidate.addresses,
      },
    ]);

    if (sanitized) {
      updates.addresses = sanitized.addresses;
    }
  }

  return updates;
}

function serializeUser(user: User): User {
  return {
    id: user.id,
    name: user.name,
    handle: user.handle,
    avatar: user.avatar,
    currentChainAssetTotal: user.currentChainAssetTotal,
    historicalMaxChainAssetTotal: user.historicalMaxChainAssetTotal,
    twitter: user.twitter,
    twitterUserId: user.twitterUserId,
    twitterAvatarUrl: user.twitterAvatarUrl,
    telegram: user.telegram,
    addresses: user.addresses,
    totalAssetUsd: user.totalAssetUsd,
    historicalMaxAssetUsd: user.historicalMaxAssetUsd,
    assetUpdatedAt: user.assetUpdatedAt,
    tags: user.tags,
    relayCoverage: user.relayCoverage,
  };
}

export function createGetUserDetailsHandler(deps: GetUserDetailsHandlerDependencies = {}) {
  const listUsers = deps.listUsers ?? listTrackedUsers;
  const readHoldingsDetails = deps.readHoldingsDetails ?? readUserHoldingsDetails;

  return async function GET(_request: NextRequest, context: UserRouteContext) {
    try {
      const { id } = await context.params;
      const user = listUsers().find((candidate) => candidate.id === id);

      if (!user) {
        return NextResponse.json({ ok: false, error: '用户不存在' }, { status: 404 });
      }

      const { holdings, holdingsUpdatedAt, summary } = await readHoldingsDetails(user);

      return NextResponse.json({
        ok: true,
        user: serializeUser(user),
        holdings,
        holdingsUpdatedAt,
        holdingsThresholdUsd: USER_HOLDINGS_THRESHOLD_USD,
        holdingsSummary: summary,
      });
    } catch (error) {
      if (error instanceof UserHoldingsDetailsUnavailableError) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
      }

      const message = error instanceof Error ? error.message : '读取用户详情失败';
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
  };
}

export const GET = createGetUserDetailsHandler();

export async function PATCH(request: NextRequest, context: UserRouteContext) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    const updates = sanitizeUpdatePayload(id, body);
    const hasTwitterUpdate = Object.prototype.hasOwnProperty.call(updates, 'twitter');
    const currentUser = hasTwitterUpdate ? listTrackedUsers().find((user) => user.id === id) || null : null;
    const normalizedIncomingTwitter = normalizeTwitterHandle(updates.twitter || '').toLowerCase();
    const normalizedCurrentTwitter = normalizeTwitterHandle(currentUser?.twitter || '').toLowerCase();
    const twitterChanged = hasTwitterUpdate && normalizedIncomingTwitter !== normalizedCurrentTwitter;
    const identity = hasTwitterUpdate && updates.twitter ? await resolveTwitterIdentityForHandle(updates.twitter) : null;
    const resolvedUpdates =
      hasTwitterUpdate && updates.twitter
        ? identity
          ? mergeTwitterIdentityIntoUser(updates, identity)
          : twitterChanged
            ? { ...updates, twitterUserId: undefined, twitterAvatarUrl: undefined }
            : {
                ...updates,
                twitterUserId: currentUser?.twitterUserId,
                twitterAvatarUrl: currentUser?.twitterAvatarUrl,
              }
        : hasTwitterUpdate
          ? { ...updates, twitterUserId: undefined, twitterAvatarUrl: undefined }
          : updates;
    const updated = updateTrackedUser(id, resolvedUpdates);

    if (!updated) {
      return NextResponse.json({ ok: false, error: '用户不存在' }, { status: 404 });
    }
    await notifyBid2MirrorSync({
      entity: 'user',
      action: 'updated',
      userId: updated.id,
    });

    return NextResponse.json({ ok: true, user: updated });
  } catch (error) {
    if (error instanceof TrackedAddressOwnershipConflictError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
    }
    if (error instanceof InvalidTrackedAddressError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : '更新用户失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: UserRouteContext) {
  try {
    const { id } = await context.params;
    const deleted = deleteTrackedUser(id);
    if (!deleted) {
      return NextResponse.json({ ok: false, error: '用户不存在' }, { status: 404 });
    }
    await notifyBid2MirrorSync({
      entity: 'user',
      action: 'deleted',
      userId: id,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : '删除用户失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
