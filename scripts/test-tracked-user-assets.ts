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
    mainstreamAssetUsd: 0,
    assetUpdatedAt: null,
    twitter: undefined,
    telegram: undefined,
  };
}

async function run() {
  const tempDir = createTempDbDir();
  const previousDbPath = process.env.PILIPILI_DB_PATH;

  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  // 静态导入不可行：sqlite/trackedUsersRepo 在模块加载时读取 PILIPILI_DB_PATH，
  // 必须先设 env 再 import（模块加载边界测试）。
  try {
    const { getDb } = await import('@/lib/server/sqlite');
    const { createTrackedUser, listTrackedUsers, updateAssetSnapshots, invalidateTrackedUsersCache } = await import(
      '@/lib/server/trackedUsersRepo'
    );
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

    // 10s TTL 缓存：写路径后必须主动失效，否则读到旧快照。
    invalidateTrackedUsersCache();
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
          userId: trackedUser.id,
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

    // liquidAssetWhereSql 的 RH 尘埃豁免：实测尘埃流动性（0<liq<5k，
    // 4FOUR 案例：$0.0003 池撑起 $3.59M 幻觉估值）不算流动资产；
    // NULL/0 = 无 DEX 池数据，照常计入（9-12 教训）；有真实池的 RH 行照常计入。
    const insertHolding = getDb().prepare(`
      INSERT INTO current_holdings
        (tracked_address, tracked_address_lower, user_id, chain, token_address, token_address_lower,
         symbol, name, balance, price_usd, value_usd, liquidity_usd, refreshed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const seedHolding = (
      chain: string,
      tokenAddress: string,
      symbol: string,
      valueUsd: number,
      liquidityUsd: number | null,
    ) => {
      insertHolding.run(
        trackedUser.id, trackedUser.id, trackedUser.id,
        chain, tokenAddress, tokenAddress.toLowerCase(),
        symbol, symbol, 1, valueUsd, valueUsd, liquidityUsd, 1_000,
      );
    };
    seedHolding('robinhood', '0x7db3e8b5d4ebf9519b4839511185d75775e74444', '4FOUR', 3_592_427, 0.0002677136000038245);
    seedHolding('robinhood', '0xnulliq00000000000000000000000000000001', 'NULLIQ', 1_600_000, null);
    seedHolding('robinhood', '0xzroliq00000000000000000000000000000002', 'ZROLIQ', 17_275, 0);
    seedHolding('robinhood', '0xrealpool0000000000000000000000000000003', 'REALPOOL', 124_000, 2_266_048);
    seedHolding('bsc', '0xdustcoin0000000000000000000000000000000004', 'DUSTCOIN', 50, 100);

    invalidateTrackedUsersCache();
    const liveRollupUser = listTrackedUsers().find((user) => user.id === trackedUser.id);
    assert.ok(liveRollupUser, 'seeding current_holdings 后人物仍应存在');
    assert.equal(
      liveRollupUser.totalAssetUsd,
      1_741_275,
      'live 汇总应超过地址缓存（1,499,999），只计入 RH 无池数据行（1.6M+17,275+124k），排除 RH 尘埃幻觉行 $3.59M 与 bsc 尘埃行',
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
