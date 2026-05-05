import assert from 'node:assert/strict';

import { USER_HOLDINGS_THRESHOLD_USD } from '@/lib/userDetails';
import { UserHoldingsDetailsUnavailableError } from '@/lib/server/userHoldingsDetails';
import type { User } from '@/types';

function makeUser(id: string): User {
  return {
    id,
    name: '详情用户',
    handle: `user-${id}`,
    avatar: '',
    twitter: undefined,
    telegram: undefined,
    addresses: [],
    totalAssetUsd: 123,
    historicalMaxAssetUsd: 456,
    assetUpdatedAt: 789,
    tags: [],
  };
}

async function run() {
  const { createGetUserDetailsHandler } = await import('../app/api/users/[id]/route');

  const user = makeUser('user-1');
  const holdings = [
    {
      chain: 'bsc' as const,
      tokenAddress: '0xusdt',
      symbol: 'USDT',
      name: 'Tether USD',
      balance: 8,
      priceUsd: 1,
      valueUsd: 8,
    },
  ];
  const holdingsUpdatedAt = 123_456;
  const holdingsSummary = {
    visibleCount: 1,
    partial: false,
    successfulAddressCount: 1,
    failedAddressCount: 0,
  };

  let lookedUpUserId: string | null = null;
  let readUser: User | null = null;

  const successHandler = createGetUserDetailsHandler({
    listUsers: () => [user],
    readHoldingsDetails: async (inputUser) => {
      readUser = inputUser;
      return {
        holdings,
        holdingsUpdatedAt,
        summary: holdingsSummary,
      };
    },
  });

  const successResponse = await successHandler(
    new Request(`http://localhost/api/users/${user.id}`) as never,
    {
      params: Promise.resolve({
        id: user.id,
      }),
    }
  );

  assert.equal(successResponse.status, 200);
  assert.equal(readUser, user);
  const successPayload = await successResponse.json();
  assert.deepEqual(successPayload, {
    ok: true,
    user: {
      id: user.id,
      name: user.name,
      handle: user.handle,
      avatar: user.avatar,
      addresses: user.addresses,
      totalAssetUsd: user.totalAssetUsd,
      historicalMaxAssetUsd: user.historicalMaxAssetUsd,
      assetUpdatedAt: user.assetUpdatedAt,
      tags: user.tags,
    },
    holdings,
    holdingsUpdatedAt,
    holdingsThresholdUsd: USER_HOLDINGS_THRESHOLD_USD,
    holdingsSummary,
  });

  const notFoundHandler = createGetUserDetailsHandler({
    listUsers: () => {
      lookedUpUserId = 'checked';
      return [];
    },
    readHoldingsDetails: async () => {
      throw new Error('should not be called when user is missing');
    },
  });

  const notFoundResponse = await notFoundHandler(
    new Request('http://localhost/api/users/missing') as never,
    {
      params: Promise.resolve({
        id: 'missing',
      }),
    }
  );

  assert.equal(lookedUpUserId, 'checked');
  assert.equal(notFoundResponse.status, 404);
  assert.deepEqual(await notFoundResponse.json(), {
    ok: false,
    error: '用户不存在',
  });

  const unavailableHandler = createGetUserDetailsHandler({
    listUsers: () => [user],
    readHoldingsDetails: async () => {
      throw new UserHoldingsDetailsUnavailableError('上游明细暂不可用');
    },
  });

  const unavailableResponse = await unavailableHandler(
    new Request(`http://localhost/api/users/${user.id}`) as never,
    {
      params: Promise.resolve({
        id: user.id,
      }),
    }
  );

  assert.equal(unavailableResponse.status, 502);
  assert.deepEqual(await unavailableResponse.json(), {
    ok: false,
    error: '上游明细暂不可用',
  });
}

run().then(() => {
  console.log('user details route tests: ok');
});
