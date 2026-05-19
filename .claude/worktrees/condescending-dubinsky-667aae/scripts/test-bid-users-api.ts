import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';

import './server-only-shim.cjs';

function createTempDbDir() {
  return mkdtempSync(path.join(tmpdir(), 'pilipili-bid-users-api-'));
}

interface BidUserAddressRow {
  userId: string;
  userName: string;
  address: string;
  chain: string;
  addressName: string;
}

interface BidUserRow {
  userId: string;
  userName: string;
  addresses: BidUserAddressRow[];
}

interface BidUsersPayload {
  ok: boolean;
  users: BidUserRow[];
}

async function run() {
  const tempDir = createTempDbDir();
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  const previousAdminToken = process.env.ADMIN_API_TOKEN;

  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');
  process.env.ADMIN_API_TOKEN = 'bid-internal-token';

  try {
    const { createTrackedUser } = await import('@/lib/server/trackedUsersRepo');
    const route = await import('../app/api/internal/bid/users/route');

    createTrackedUser({
      name: 'Alpha',
      handle: 'alpha',
      avatar: 'alpha.png',
      tags: [],
      addresses: [
        {
          address: 'testuser_solana_placeholder_1111111111111111',
          name: '#1',
          chain: 'solana',
          totalAssetUsd: null,
          assetUpdatedAt: null,
        },
        {
          address: '0xAbCdEf0000000000000000000000000000000001',
          name: '#2',
          chain: 'base',
          totalAssetUsd: null,
          assetUpdatedAt: null,
        },
      ],
      totalAssetUsd: 0,
      historicalMaxAssetUsd: 0,
      assetUpdatedAt: null,
      twitter: undefined,
      telegram: undefined,
    });

    const beta = createTrackedUser({
      name: 'Beta',
      handle: 'beta',
      avatar: 'beta.png',
      tags: [],
      addresses: [
        {
          address: '0x9999999999999999999999999999999999999999',
          name: '#1',
          chain: 'bsc',
          totalAssetUsd: null,
          assetUpdatedAt: null,
        },
      ],
      totalAssetUsd: 0,
      historicalMaxAssetUsd: 0,
      assetUpdatedAt: null,
      twitter: undefined,
      telegram: undefined,
    });

    const unauthorized = await route.GET(new NextRequest('http://localhost:3005/api/internal/bid/users'));
    assert.equal(unauthorized.status, 401);

    const response = await route.GET(
      new NextRequest(`http://localhost:3005/api/internal/bid/users?userIds=${beta.id}`, {
        headers: {
          authorization: 'Bearer bid-internal-token',
        },
      })
    );
    assert.equal(response.status, 200);

    const payload = (await response.json()) as BidUsersPayload;
    assert.equal(payload.ok, true);
    assert.equal(payload.users.length, 1);
    assert.equal(payload.users[0].userId, beta.id);
    assert.equal(payload.users[0].userName, 'Beta');
    assert.deepEqual(payload.users[0].addresses, [
      {
        userId: beta.id,
        userName: 'Beta',
        address: '0x9999999999999999999999999999999999999999',
        chain: 'bsc',
        addressName: '#1',
      },
      {
        userId: beta.id,
        userName: 'Beta',
        address: '0x9999999999999999999999999999999999999999',
        chain: 'ethereum',
        addressName: '#1',
      },
      {
        userId: beta.id,
        userName: 'Beta',
        address: '0x9999999999999999999999999999999999999999',
        chain: 'base',
        addressName: '#1',
      },
    ]);

    const allResponse = await route.GET(
      new NextRequest('http://localhost:3005/api/internal/bid/users', {
        headers: {
          authorization: 'Bearer bid-internal-token',
        },
      })
    );
    const allPayload = (await allResponse.json()) as BidUsersPayload;
    const flatAddresses = allPayload.users.flatMap((user) => user.addresses);
    assert.equal(
      flatAddresses.some((row) => row.address === 'testuser_solana_placeholder_1111111111111111'),
      true
    );
    assert.equal(
      flatAddresses.some((row) => row.address === '0xAbCdEf0000000000000000000000000000000001'),
      true
    );

    console.log('bid users api tests: ok');
  } finally {
    if (previousDbPath === undefined) {
      delete process.env.PILIPILI_DB_PATH;
    } else {
      process.env.PILIPILI_DB_PATH = previousDbPath;
    }
    if (previousDataDir === undefined) {
      delete process.env.PILIPILI_DATA_DIR;
    } else {
      process.env.PILIPILI_DATA_DIR = previousDataDir;
    }
    if (previousAdminToken === undefined) {
      delete process.env.ADMIN_API_TOKEN;
    } else {
      process.env.ADMIN_API_TOKEN = previousAdminToken;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
