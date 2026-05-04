import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

import type { User } from '@/types';

const SOLANA_ADDRESS = '71CPXu3TvH3iUKaY1bNkAAow24k6tjH473SsKprQBABC';
const BSC_ADDRESS_ONE = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf03';
const BSC_ADDRESS_TWO = '0x52c9357020a67ba1e39a583c582988ca7b9f2cc4';

function createTempDbDir() {
  return mkdtempSync(path.join(tmpdir(), 'pilipili-tracked-user-assets-'));
}

function buildUser(): Omit<User, 'id'> {
  return {
    name: '王小二',
    handle: 'wangxiaoer',
    avatar: 'wangxiaoer.png',
    tags: [],
    addresses: [
      {
        address: SOLANA_ADDRESS,
        name: '#1',
        chain: 'solana',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
      {
        address: BSC_ADDRESS_ONE,
        name: '#2',
        chain: 'bsc',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
      {
        address: BSC_ADDRESS_TWO,
        name: '#3',
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
  };
}

async function run() {
  const tempDir = createTempDbDir();
  const previousDbPath = process.env.PILIPILI_DB_PATH;

  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { createTrackedUser, listTrackedUsers, updateAssetSnapshots } = await import('@/lib/server/trackedUsersRepo');
    const trackedUser = createTrackedUser(buildUser());

    updateAssetSnapshots(
      [
        {
          userId: trackedUser.id,
          address: SOLANA_ADDRESS,
          chain: 'solana',
          token: '',
          tokenAddress: '',
          balance: '',
          valueUsd: 100_000,
          totalAssetUsd: 100_000,
          updatedAt: 1_000,
        },
        {
          userId: trackedUser.id,
          address: BSC_ADDRESS_ONE,
          chain: 'bsc',
          token: '',
          tokenAddress: '',
          balance: '',
          valueUsd: 200_000,
          totalAssetUsd: 200_000,
          updatedAt: 1_000,
        },
        {
          userId: trackedUser.id,
          address: BSC_ADDRESS_TWO,
          chain: 'bsc',
          token: '',
          tokenAddress: '',
          balance: '',
          valueUsd: 300_000,
          totalAssetUsd: 300_000,
          updatedAt: 1_000,
        },
      ],
      [
        {
          userId: trackedUser.id,
          totalValueUsd: 600_000,
          totalAssetUsd: 600_000,
          updatedAt: 1_000,
        },
      ]
    );

    const initial = listTrackedUsers().find((user) => user.id === trackedUser.id);
    assert.ok(initial, '应能读回刚创建的人物');
    assert.equal(initial.totalAssetUsd, 600_000, '首次全量快照后人物总资产应为全地址之和');
    assert.equal(initial.historicalMaxAssetUsd, 600_000, '首次全量快照后历史最高资产应同步更新');

    updateAssetSnapshots(
      [
        {
          userId: trackedUser.id,
          address: SOLANA_ADDRESS,
          chain: 'solana',
          token: '',
          tokenAddress: '',
          balance: '',
          valueUsd: 50_000,
          totalAssetUsd: 50_000,
          updatedAt: 2_000,
        },
      ],
      [
        {
          userId: trackedUser.id,
          totalValueUsd: 50_000,
          totalAssetUsd: 50_000,
          updatedAt: 2_000,
        },
      ]
    );

    const partial = listTrackedUsers().find((user) => user.id === trackedUser.id);
    assert.ok(partial, '局部快照后人物仍应存在');

    const addressTotals = new Map(
      partial.addresses.map((address) => [`${address.chain}:${address.address}`, address.totalAssetUsd] as const)
    );
    assert.equal(addressTotals.get(`solana:${SOLANA_ADDRESS}`), 50_000, '成功同步的地址应写入最新资产');
    assert.equal(addressTotals.get(`bsc:${BSC_ADDRESS_ONE}`), 200_000, '未参与本轮同步的 BSC 地址应保留上次快照');
    assert.equal(addressTotals.get(`bsc:${BSC_ADDRESS_TWO}`), 300_000, '未参与本轮同步的 BSC 地址应保留上次快照');
    assert.equal(
      partial.totalAssetUsd,
      550_000,
      '局部同步后人物总资产应基于最新地址快照重算，而不是退化为本轮成功子集'
    );
    assert.equal(partial.historicalMaxAssetUsd, 600_000, '局部同步后历史最高资产应保留此前峰值');
    assert.equal(partial.assetUpdatedAt, 2_000, '局部同步后人物资产更新时间应推进到本轮更新时间');

    updateAssetSnapshots(
      [
        {
          address: SOLANA_ADDRESS,
          chain: 'solana',
          token: '',
          tokenAddress: '',
          balance: '',
          valueUsd: 999_999,
          totalAssetUsd: 999_999,
          updatedAt: 3_000,
        },
      ],
      []
    );

    const ignoredInvalidSnapshot = listTrackedUsers().find((user) => user.id === trackedUser.id);
    assert.ok(ignoredInvalidSnapshot, '忽略无效快照后人物仍应存在');
    assert.equal(
      ignoredInvalidSnapshot.totalAssetUsd,
      550_000,
      '缺少 userId 的地址资产快照应被忽略，不能污染人物总资产'
    );
    assert.equal(
      ignoredInvalidSnapshot.assetUpdatedAt,
      2_000,
      '缺少 userId 的地址资产快照应被忽略，不能推进人物资产更新时间'
    );

    console.log('tracked user asset snapshot tests: ok');
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
