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
  totalAssetUsd?: number;
  historicalMaxAssetUsd?: number;
  assetUpdatedAt?: string;
  lastTxAt?: string;
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
  const previousHmacSecret = process.env.INTERNAL_BID_HMAC_SECRET;

  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');
  process.env.INTERNAL_BID_HMAC_SECRET = 'pili-bid-users-test-internal-bid-secret-1234567890abcdef';

  try {
    const { createTrackedUser, updateAssetSnapshots } = await import('@/lib/server/trackedUsersRepo');
    const { getDb } = await import('@/lib/server/sqlite');
    const { signInternalBidToken } = await import('@/lib/server/internalBidAuth');
    const route = await import('../app/api/internal/bid/users/route');

    const authHeader = () => `Bearer ${signInternalBidToken()}`;

    createTrackedUser({
      name: 'Alpha',
      handle: 'alpha',
      avatar: 'alpha.png',
      tags: [],
      addresses: [
        {
          address: 'So11111111111111111111111111111111111111112',
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

    // Seed asset snapshots and a raw transaction so the BID-facing fields are
    // populated end-to-end (totalAssetUsd / assetUpdatedAt / historicalMaxAssetUsd
    // / lastTxAt).
    const betaAssetUpdatedAtMs = Date.UTC(2026, 4, 1, 12, 0, 0);
    const betaTxTimeMs = Date.UTC(2026, 4, 2, 18, 30, 0);
    const betaPeakUsd = 4321;
    updateAssetSnapshots(
      [
        {
          userId: beta.id,
          chain: 'bsc',
          address: '0x9999999999999999999999999999999999999999',
          totalAssetUsd: 1234,
          updatedAt: betaAssetUpdatedAtMs,
        },
      ],
      []
    );

    // Override the user-level historical max to verify it flows through (the
    // assetSnapshots path only ratchets it upward; we want a distinct value).
    getDb()
      .prepare('UPDATE tracked_users SET historical_max_asset_usd = ? WHERE id = ?')
      .run(betaPeakUsd, beta.id);

    getDb()
      .prepare(
        `INSERT INTO raw_transactions (
          chain, tracked_address, tracked_address_lower,
          tx_hash, tx_hash_lower, tx_time, payload_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'bsc',
        '0x9999999999999999999999999999999999999999',
        '0x9999999999999999999999999999999999999999',
        '0xdeadbeef',
        '0xdeadbeef',
        betaTxTimeMs,
        '{}',
        Date.now(),
        Date.now()
      );

    const response = await route.GET(
      new NextRequest(`http://localhost:3005/api/internal/bid/users?userIds=${beta.id}`, {
        headers: {
          authorization: authHeader(),
        },
      })
    );
    assert.equal(response.status, 200);

    const payload = (await response.json()) as BidUsersPayload;
    assert.equal(payload.ok, true);
    assert.equal(payload.users.length, 1);
    assert.equal(payload.users[0].userId, beta.id);
    assert.equal(payload.users[0].userName, 'Beta');

    const bscRow = payload.users[0].addresses.find((row) => row.chain === 'bsc');
    assert.ok(bscRow, 'expected bsc address row for beta');
    assert.equal(bscRow.totalAssetUsd, 1234);
    assert.equal(bscRow.historicalMaxAssetUsd, betaPeakUsd);
    assert.equal(bscRow.assetUpdatedAt, new Date(betaAssetUpdatedAtMs).toISOString());
    assert.equal(bscRow.lastTxAt, new Date(betaTxTimeMs).toISOString());

    // EVM expansion rows that don't have their own asset snapshot or tx still
    // carry the user-level peak (duplicated per BID's consumer contract) but
    // have no per-address totalAssetUsd or lastTxAt.
    const ethRow = payload.users[0].addresses.find((row) => row.chain === 'ethereum');
    assert.ok(ethRow, 'expected ethereum address row for beta');
    assert.equal(ethRow.totalAssetUsd, undefined);
    assert.equal(ethRow.historicalMaxAssetUsd, betaPeakUsd);
    assert.equal(ethRow.assetUpdatedAt, undefined);
    assert.equal(ethRow.lastTxAt, undefined);

    const allResponse = await route.GET(
      new NextRequest('http://localhost:3005/api/internal/bid/users', {
        headers: {
          authorization: authHeader(),
        },
      })
    );
    const allPayload = (await allResponse.json()) as BidUsersPayload;
    const flatAddresses = allPayload.users.flatMap((user) => user.addresses);
    assert.equal(
      flatAddresses.some((row) => row.address === 'So11111111111111111111111111111111111111112'),
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
    if (previousHmacSecret === undefined) {
      delete process.env.INTERNAL_BID_HMAC_SECRET;
    } else {
      process.env.INTERNAL_BID_HMAC_SECRET = previousHmacSecret;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
