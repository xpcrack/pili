import { NextRequest, NextResponse } from '@/lib/server/httpCompat';

import {
  listTrackedUsers,
} from '@/lib/server/trackedUsersRepo';
import {
  readUserHoldingsDetails,
  UserHoldingsDetailsUnavailableError,
} from '@/lib/server/userHoldingsDetails';
import { USER_HOLDINGS_THRESHOLD_USD } from '@/lib/userDetails';
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
    mainstreamAssetUsd: user.mainstreamAssetUsd,
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

