import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

const SOLANA_ADDRESS_ONE = '71CPXu3TvH3iUKaY1bNkAAow24k6tjH473SsKprQBABC';
const SOLANA_ADDRESS_TWO = '3qAKQ1c6gawUVNheSBmUVhMgKg7EqT1aHw72ZKmC8Jmk';
const SOLANA_ADDRESS_THREE = 'HUNUywaDxTV3a8KLwC5cooSeg1hXKcyPnYjvicN6v6ey';

function createTempDir() {
  return mkdtempSync(path.join(tmpdir(), 'pilipili-historical-peak-repair-'));
}

function createUser(
  id: string,
  totalAssetUsd: number,
  historicalMaxAssetUsd: number,
  address: string
) {
  return {
    name: id,
    handle: id,
    avatar: '',
    twitter: undefined,
    telegram: undefined,
    addresses: [
      {
        address,
        name: '#1',
        chain: 'solana',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
    ],
    totalAssetUsd,
    historicalMaxAssetUsd,
    assetUpdatedAt: null,
    tags: [],
  };
}

async function run() {
  const tempDir = createTempDir();
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { createTrackedUser } = await import('@/lib/server/trackedUsersRepo');
    const { getDb } = await import('@/lib/server/sqlite');
    const { repairSuspiciousHistoricalPeaks } = await import('@/lib/server/historicalPeakRepair');

    const suspiciousUser = createTrackedUser(
      createUser('suspicious-user', 5_250_000, 5_350_000, SOLANA_ADDRESS_ONE) as any
    );
    const healthyUser = createTrackedUser(
      createUser('healthy-user', 120_000, 180_000, SOLANA_ADDRESS_TWO) as any
    );
    const incompleteUser = createTrackedUser(
      createUser('incomplete-user', 800_000, 950_000, SOLANA_ADDRESS_THREE) as any
    );

    const result = await repairSuspiciousHistoricalPeaks({
      users: [suspiciousUser, healthyUser, incompleteUser],
      collectAssetSnapshots: async (users) => ({
        addressAssets: users.flatMap((user) => {
          if (user.id === incompleteUser.id) {
            return [];
          }

          const totalAssetUsd = user.id === suspiciousUser.id ? 195_000 : 120_000;
          return [
            {
              userId: user.id,
              address: user.addresses[0]!.address,
              chain: user.addresses[0]!.chain,
              totalAssetUsd,
              updatedAt: 1_700_000_000_000,
            },
          ];
        }),
        userAssets: [
          {
            userId: suspiciousUser.id,
            totalValueUsd: 195_000,
            totalAssetUsd: 195_000,
            updatedAt: 1_700_000_000_000,
          },
          {
            userId: healthyUser.id,
            totalValueUsd: 120_000,
            totalAssetUsd: 120_000,
            updatedAt: 1_700_000_000_000,
          },
        ],
      }),
    });

    assert.equal(result.repairedUsers.length, 1, '只应修复明显异常的历史峰值');
    assert.equal(result.repairedUsers[0]?.userId, suspiciousUser.id);
    assert.equal(result.repairedUsers[0]?.newHistoricalMaxAssetUsd, 195_000);
    assert.equal(result.skippedUsers.length, 2, '健康回撤和快照不完整的用户应跳过');

    const db = getDb();
    const suspiciousRow = db
      .prepare(
        `SELECT total_asset_usd, historical_max_asset_usd
         FROM tracked_users
         WHERE id = ?`
      )
      .get(suspiciousUser.id) as {
      total_asset_usd: number;
      historical_max_asset_usd: number;
    };
    assert.equal(suspiciousRow.total_asset_usd, 195_000, '修复前应先写入当前可信资产');
    assert.equal(suspiciousRow.historical_max_asset_usd, 195_000, '异常历史峰值应回落到当前可信资产');

    const healthyRow = db
      .prepare(
        `SELECT total_asset_usd, historical_max_asset_usd
         FROM tracked_users
         WHERE id = ?`
      )
      .get(healthyUser.id) as {
      total_asset_usd: number;
      historical_max_asset_usd: number;
    };
    assert.equal(healthyRow.total_asset_usd, 120_000, '健康用户也应刷新当前资产');
    assert.equal(healthyRow.historical_max_asset_usd, 180_000, '健康回撤不应被错误降级');

    const incompleteRow = db
      .prepare(
        `SELECT total_asset_usd, historical_max_asset_usd
         FROM tracked_users
         WHERE id = ?`
      )
      .get(incompleteUser.id) as {
      total_asset_usd: number;
      historical_max_asset_usd: number;
    };
    assert.equal(incompleteRow.total_asset_usd, 800_000, '快照不完整时不应写入部分当前资产');
    assert.equal(incompleteRow.historical_max_asset_usd, 950_000, '快照不完整时不应修改历史峰值');

    console.log('historical peak repair tests: ok');
  } finally {
    if (previousDbPath === undefined) {
      delete process.env.PILIPILI_DB_PATH;
    } else {
      process.env.PILIPILI_DB_PATH = previousDbPath;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
