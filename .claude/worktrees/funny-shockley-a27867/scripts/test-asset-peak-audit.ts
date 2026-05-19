import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

import type { User } from '@/types';

function createTempDir() {
  return mkdtempSync(path.join(tmpdir(), 'pilipili-asset-peak-audit-'));
}

function createUser(id: string, historicalMaxAssetUsd: number, address: string): Omit<User, 'id'> {
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
        chain: 'bsc',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
    ],
    totalAssetUsd: 0,
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
    const { runHistoricalPeakAssetAudit } = await import('@/scripts/audit-historical-asset-peaks');

    const user = createTrackedUser(
      createUser('audit-user', 300, '0x1111111111111111111111111111111111111111') as User
    );
    const db = getDb();

    const beforeRow = db
      .prepare(
        `SELECT total_asset_usd, historical_max_asset_usd
         FROM tracked_users
         WHERE id = ?`
      )
      .get(user.id) as {
      total_asset_usd: number;
      historical_max_asset_usd: number;
    };

    const logLines: string[] = [];
    const result = await runHistoricalPeakAssetAudit({
      log: (line) => {
        logLines.push(line);
      },
      collectAssetSnapshots: async () => ({
        addressAssets: [
          {
            userId: user.id,
            address: user.addresses[0]!.address,
            chain: 'bsc',
            totalAssetUsd: 120,
            updatedAt: 1_700_000_000_000,
          },
        ],
        userAssets: [
          {
            userId: user.id,
            totalValueUsd: 120,
            totalAssetUsd: 120,
            updatedAt: 1_700_000_000_000,
          },
        ],
      }),
      fetchAddressAssetDetails: async () => ({
        ok: true,
        configured: true,
        totalAssetUsd: 120,
        assets: [
          {
            userId: user.id,
            address: user.addresses[0]!.address,
            chain: 'bsc',
            assetKey: 'bsc:0xaudit',
            tokenAddress: '0xaudit',
            symbol: 'AUD',
            name: 'Audit Token',
            balance: 60,
            priceUsd: 2,
            valueUsd: 120,
          },
        ],
        error: null,
      }),
      fetchTokenLiquidity: async () => ({
        liquidityUsd: 200,
      }),
    });

    assert.equal(result.findings.length, 1, '应报告历史峰值高于当前资产且命中校验规则的用户');
    assert.equal(result.findings[0]?.userId, user.id);
    assert.match(logLines.join('\n'), /storedPeak=300/i, '输出应包含历史峰值');
    assert.match(logLines.join('\n'), /currentTotal=120/i, '输出应包含当前总资产');
    assert.match(logLines.join('\n'), /liquidity_ratio_exceeded/i, '输出应包含失败原因');

    const afterRow = db
      .prepare(
        `SELECT total_asset_usd, historical_max_asset_usd
         FROM tracked_users
         WHERE id = ?`
      )
      .get(user.id) as {
      total_asset_usd: number;
      historical_max_asset_usd: number;
    };

    assert.deepEqual(afterRow, beforeRow, 'dry-run 审计不应修改 tracked_users 资产字段');

    const auditCount = db
      .prepare(`SELECT COUNT(*) AS count FROM asset_peak_validation_blocks`)
      .get() as { count: number };
    assert.equal(auditCount.count, 0, 'dry-run 审计不应写入峰值拦截审计表');

    console.log('asset peak audit tests: ok');
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
