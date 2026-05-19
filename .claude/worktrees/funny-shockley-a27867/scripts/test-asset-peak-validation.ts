import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

import type { AddressAssetSnapshot, UserAssetSnapshot } from '@/lib/activityFeed';
import type { User } from '@/types';

function createTempDir() {
  return mkdtempSync(path.join(tmpdir(), 'pilipili-asset-peak-validation-'));
}

function createUser(id: string, totalAssetUsd: number, historicalMaxAssetUsd: number, address: string): User {
  return {
    id,
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
    totalAssetUsd,
    historicalMaxAssetUsd,
    assetUpdatedAt: null,
    tags: [],
  };
}

function createAddressAssetSnapshot(userId: string, address: string, totalAssetUsd: number): AddressAssetSnapshot {
  return {
    userId,
    address,
    chain: 'bsc',
    totalAssetUsd,
    updatedAt: 1_700_000_000_000,
  };
}

function createUserAssetSnapshot(userId: string, totalAssetUsd: number): UserAssetSnapshot {
  return {
    userId,
    totalValueUsd: totalAssetUsd,
    totalAssetUsd,
    updatedAt: 1_700_000_000_000,
  };
}

async function run() {
  const tempDir = createTempDir();
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousOkxApiKey = process.env.OKX_API_KEY;
  const previousOkxSecret = process.env.OKX_SECRET_KEY;
  const previousOkxPassphrase = process.env.OKX_API_PASSPHRASE;

  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');
  process.env.OKX_API_KEY = 'test-key';
  process.env.OKX_SECRET_KEY = 'test-secret';
  process.env.OKX_API_PASSPHRASE = 'test-passphrase';

  try {
    const { fetchOkxAddressAssetDetails } = await import('@/lib/okx');
    const {
      mergePersonLevelAssetHoldings,
      validatePeakAssetSnapshots,
      validateAndPersistPeakAssetSnapshots,
    } = await import('@/lib/server/assetPeakValidation');
    const { createTrackedUser } = await import('@/lib/server/trackedUsersRepo');
    const { getDb } = await import('@/lib/server/sqlite');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: '0',
          data: [
            {
              tokenAssets: [
                {
                  symbol: 'AAA',
                  tokenContractAddress: '0xAbC0000000000000000000000000000000000000',
                  balance: '2',
                  tokenPrice: '5',
                },
                {
                  symbol: 'BNB',
                  balance: '3',
                  tokenPrice: '100',
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )) as typeof fetch;

    const okxDetails = await fetchOkxAddressAssetDetails('0xWallet', 'bsc');
    assert.equal(okxDetails.ok, true, 'OKX 资产明细请求应成功');
    assert.equal(okxDetails.assets.length, 2, '应归一化两条资产明细');
    const okxToken = okxDetails.assets.find((asset) => asset.symbol === 'AAA');
    const okxNative = okxDetails.assets.find((asset) => asset.symbol === 'BNB');
    assert.equal(
      okxToken?.tokenAddress,
      '0xabc0000000000000000000000000000000000000',
      'EVM 合约地址应归一化为小写'
    );
    assert.equal(
      okxNative?.tokenAddress,
      '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
      '原生 BNB 应映射到 WBNB 地址，便于后续流动性查询'
    );
    globalThis.fetch = originalFetch;

    const mergedHoldings = mergePersonLevelAssetHoldings([
      {
        userId: 'merge-user',
        address: '0xaaa',
        chain: 'bsc',
        assetKey: 'bsc:0xabc',
        tokenAddress: '0xabc',
        symbol: 'AAA',
        name: 'AAA',
        balance: 2,
        priceUsd: 10,
        valueUsd: 20,
      },
      {
        userId: 'merge-user',
        address: '0xbbb',
        chain: 'bsc',
        assetKey: 'bsc:0xabc',
        tokenAddress: '0xabc',
        symbol: 'AAA',
        name: 'AAA',
        balance: 3,
        priceUsd: 10,
        valueUsd: 30,
      },
      {
        userId: 'merge-user',
        address: '0xccc',
        chain: 'ethereum',
        assetKey: 'ethereum:0xc02aa39b223fe8d0a0e5c4f27ead9083c756cc2',
        tokenAddress: '0xc02aa39b223fe8d0a0e5c4f27ead9083c756cc2',
        symbol: 'ETH',
        name: 'Ether',
        balance: 0.1,
        priceUsd: 2000,
        valueUsd: 200,
      },
      {
        userId: 'merge-user',
        address: '0xddd',
        chain: 'base',
        assetKey: 'base:0x4200000000000000000000000000000000000006',
        tokenAddress: '0x4200000000000000000000000000000000000006',
        symbol: 'ETH',
        name: 'Ether',
        balance: 0.08,
        priceUsd: 2500,
        valueUsd: 200,
      },
    ]);
    assert.equal(mergedHoldings.length, 3, '同一代币应按人物维度合并，跨链原生映射应保持分离');
    assert.equal(mergedHoldings[2]?.valueUsd, 50, '同一 token 的持仓价值应合并');
    assert.deepEqual(
      mergedHoldings.map((item) => item.assetKey),
      [
        'base:0x4200000000000000000000000000000000000006',
        'ethereum:0xc02aa39b223fe8d0a0e5c4f27ead9083c756cc2',
        'bsc:0xabc',
      ],
      '排序应按价值降序，价值并列时按资产键稳定排序'
    );

    let nonCandidateFetchCount = 0;
    const nonCandidateUser = createUser('non-candidate', 150, 200, '0xNonCandidate');
    const nonCandidateValidation = await validatePeakAssetSnapshots({
      users: [nonCandidateUser],
      addressAssets: [createAddressAssetSnapshot(nonCandidateUser.id, nonCandidateUser.addresses[0]!.address, 150)],
      userAssets: [createUserAssetSnapshot(nonCandidateUser.id, 150)],
      fetchAddressAssetDetails: async () => {
        nonCandidateFetchCount++;
        return {
          ok: true,
          configured: true,
          totalAssetUsd: 150,
          assets: [],
          error: null,
        };
      },
      fetchTokenLiquidity: async () => ({ liquidityUsd: 1_000 }),
    });
    assert.equal(nonCandidateFetchCount, 0, '非新高用户不应触发资产明细校验');
    assert.deepEqual(nonCandidateValidation.blockedUsers, [], '非新高用户不应被拦截');
    assert.equal(nonCandidateValidation.userAssets.length, 1, '非新高用户的快照应保留');

    const candidateUser = createUser('healthy-candidate', 100, 100, '0xHealthyCandidate');
    const healthyValidation = await validatePeakAssetSnapshots({
      users: [candidateUser],
      addressAssets: [createAddressAssetSnapshot(candidateUser.id, candidateUser.addresses[0]!.address, 220)],
      userAssets: [createUserAssetSnapshot(candidateUser.id, 220)],
      fetchAddressAssetDetails: async () => ({
        ok: true,
        configured: true,
        totalAssetUsd: 220,
        assets: [
          {
            userId: candidateUser.id,
            address: candidateUser.addresses[0]!.address,
            chain: 'bsc',
            assetKey: 'bsc:0xhealthy',
            tokenAddress: '0xhealthy',
            symbol: 'HLT',
            name: 'Healthy',
            balance: 100,
            priceUsd: 2.2,
            valueUsd: 220,
          },
        ],
        error: null,
      }),
      fetchTokenLiquidity: async () => ({ liquidityUsd: 1_000 }),
    });
    assert.deepEqual(healthyValidation.blockedUsers, [], '流动性健康的新高应放行');
    assert.equal(healthyValidation.userAssets.length, 1, '流动性健康的新高快照应保留');

    const multiAddressCandidateUser: User = {
      ...createUser('multi-address-candidate', 100, 100, '0xPrimaryAddress'),
      addresses: [
        {
          address: '0xPrimaryAddress',
          name: '#1',
          chain: 'bsc',
          totalAssetUsd: null,
          assetUpdatedAt: null,
        },
        {
          address: '0xShadowAddress',
          name: '#2',
          chain: 'bsc',
          totalAssetUsd: null,
          assetUpdatedAt: null,
        },
      ],
    };
    const inspectedAddresses: string[] = [];
    const multiAddressValidation = await validatePeakAssetSnapshots({
      users: [multiAddressCandidateUser],
      addressAssets: [createAddressAssetSnapshot(multiAddressCandidateUser.id, '0xPrimaryAddress', 220)],
      userAssets: [createUserAssetSnapshot(multiAddressCandidateUser.id, 220)],
      fetchAddressAssetDetails: async (address) => {
        inspectedAddresses.push(address);
        if (address === '0xShadowAddress') {
          return {
            ok: true,
            configured: true,
            totalAssetUsd: 200,
            assets: [
              {
                userId: multiAddressCandidateUser.id,
                address,
                chain: 'bsc',
                assetKey: 'bsc:0xshadow',
                tokenAddress: '0xshadow',
                symbol: 'SHD',
                name: 'Shadow',
                balance: 100,
                priceUsd: 2,
                valueUsd: 200,
              },
            ],
            error: null,
          };
        }

        return {
          ok: true,
          configured: true,
          totalAssetUsd: 20,
          assets: [
            {
              userId: multiAddressCandidateUser.id,
              address,
              chain: 'bsc',
              assetKey: 'bsc:0xprimary',
              tokenAddress: '0xprimary',
              symbol: 'PRI',
              name: 'Primary',
              balance: 10,
              priceUsd: 2,
              valueUsd: 20,
            },
          ],
          error: null,
        };
      },
      fetchTokenLiquidity: async (_chain, tokenAddress) => ({
        liquidityUsd: tokenAddress === '0xshadow' ? 300 : 1_000,
      }),
    });
    assert.deepEqual(
      inspectedAddresses.sort(),
      ['0xPrimaryAddress', '0xShadowAddress'].sort(),
      '新高用户应校验其全部 tracked addresses，而不是只校验本轮成功抓到快照的地址'
    );
    assert.equal(multiAddressValidation.blockedUsers.length, 1, '遗漏地址上的大额持仓也应阻止人物峰值更新');
    assert.equal(multiAddressValidation.blockedUsers[0]?.userId, multiAddressCandidateUser.id);

    const lowLiquidityUser = createUser('blocked-liquidity', 90, 90, '0xBlockedLiquidity');
    const lowLiquidityValidation = await validatePeakAssetSnapshots({
      users: [lowLiquidityUser],
      addressAssets: [createAddressAssetSnapshot(lowLiquidityUser.id, lowLiquidityUser.addresses[0]!.address, 180)],
      userAssets: [createUserAssetSnapshot(lowLiquidityUser.id, 180)],
      fetchAddressAssetDetails: async () => ({
        ok: true,
        configured: true,
        totalAssetUsd: 180,
        assets: [
          {
            userId: lowLiquidityUser.id,
            address: lowLiquidityUser.addresses[0]!.address,
            chain: 'bsc',
            assetKey: 'bsc:0xilliquid',
            tokenAddress: '0xilliquid',
            symbol: 'ILL',
            name: 'Illiquid',
            balance: 90,
            priceUsd: 2,
            valueUsd: 180,
          },
        ],
        error: null,
      }),
      fetchTokenLiquidity: async () => ({ liquidityUsd: 300 }),
    });
    assert.equal(lowLiquidityValidation.blockedUsers.length, 1, '超过 50% 流动性的持仓应触发拦截');
    assert.equal(lowLiquidityValidation.blockedUsers[0]?.status, 'liquidity_ratio_exceeded');
    assert.equal(lowLiquidityValidation.userAssets.length, 0, '被拦截用户的总资产快照应被过滤');
    assert.equal(lowLiquidityValidation.addressAssets.length, 0, '被拦截用户的地址资产快照应被过滤');

    const mismatchedDetailUser = createUser('blocked-detail-mismatch', 120_000, 120_000, '0xMismatchAddress');
    const mismatchedDetailValidation = await validatePeakAssetSnapshots({
      users: [mismatchedDetailUser],
      addressAssets: [
        createAddressAssetSnapshot(mismatchedDetailUser.id, mismatchedDetailUser.addresses[0]!.address, 5_250_000),
      ],
      userAssets: [createUserAssetSnapshot(mismatchedDetailUser.id, 5_250_000)],
      fetchAddressAssetDetails: async () => ({
        ok: true,
        configured: true,
        totalAssetUsd: 108_222.77,
        assets: [
          {
            userId: mismatchedDetailUser.id,
            address: mismatchedDetailUser.addresses[0]!.address,
            chain: 'bsc',
            assetKey: 'bsc:0xjoe',
            tokenAddress: '0xjoe',
            symbol: 'JOE',
            name: 'Joe',
            balance: 8_225_968,
            priceUsd: 0.01289,
            valueUsd: 106_057.52,
          },
          {
            userId: mismatchedDetailUser.id,
            address: mismatchedDetailUser.addresses[0]!.address,
            chain: 'bsc',
            assetKey: 'bsc:0xeth',
            tokenAddress: '0xeth',
            symbol: 'ETH',
            name: 'Ether',
            balance: 0.083,
            priceUsd: 2_379.47,
            valueUsd: 198.79,
          },
          {
            userId: mismatchedDetailUser.id,
            address: mismatchedDetailUser.addresses[0]!.address,
            chain: 'bsc',
            assetKey: 'bsc:0xusd1',
            tokenAddress: '0xusd1',
            symbol: 'USD1',
            name: 'USD1',
            balance: 47,
            priceUsd: 0.9998,
            valueUsd: 46.99,
          },
        ],
        error: null,
      }),
      fetchTokenLiquidity: async () => ({ liquidityUsd: 1_000_000 }),
    });
    assert.equal(
      mismatchedDetailValidation.blockedUsers.length,
      1,
      '候选总资产与明细合计明显不一致时，即使流动性健康也应拦截'
    );
    assert.equal(mismatchedDetailValidation.blockedUsers[0]?.status, 'detail_total_mismatch');
    assert.equal(
      mismatchedDetailValidation.userAssets.length,
      0,
      '明细口径冲突被拦截后，不应保留对应人物总资产快照'
    );

    const missingLiquidityUser = createUser('blocked-missing-liquidity', 95, 95, '0xMissingLiquidity');
    const missingLiquidityValidation = await validatePeakAssetSnapshots({
      users: [missingLiquidityUser],
      addressAssets: [createAddressAssetSnapshot(missingLiquidityUser.id, missingLiquidityUser.addresses[0]!.address, 180)],
      userAssets: [createUserAssetSnapshot(missingLiquidityUser.id, 180)],
      fetchAddressAssetDetails: async () => ({
        ok: true,
        configured: true,
        totalAssetUsd: 180,
        assets: [
          {
            userId: missingLiquidityUser.id,
            address: missingLiquidityUser.addresses[0]!.address,
            chain: 'bsc',
            assetKey: 'bsc:0xmissing',
            tokenAddress: '0xmissing',
            symbol: 'MISS',
            name: 'Missing',
            balance: 90,
            priceUsd: 2,
            valueUsd: 180,
          },
        ],
        error: null,
      }),
      fetchTokenLiquidity: async () => ({ liquidityUsd: null }),
    });
    assert.equal(missingLiquidityValidation.blockedUsers.length, 1, '前五持仓缺少流动性应直接拦截');
    assert.equal(missingLiquidityValidation.blockedUsers[0]?.status, 'missing_liquidity');

    const blockedPersistUser = createTrackedUser(
      createUser('persist-blocked', 100, 100, '0x2222222222222222222222222222222222222222')
    );
    const allowedPersistUser = createTrackedUser(
      createUser('persist-allowed', 50, 50, '0x3333333333333333333333333333333333333333')
    );

    const persistResult = await validateAndPersistPeakAssetSnapshots({
      users: [blockedPersistUser, allowedPersistUser],
      addressAssets: [
        createAddressAssetSnapshot(blockedPersistUser.id, blockedPersistUser.addresses[0]!.address, 200),
        createAddressAssetSnapshot(allowedPersistUser.id, allowedPersistUser.addresses[0]!.address, 75),
      ],
      userAssets: [
        createUserAssetSnapshot(blockedPersistUser.id, 200),
        createUserAssetSnapshot(allowedPersistUser.id, 75),
      ],
      fetchAddressAssetDetails: async (address) => {
        if (address === blockedPersistUser.addresses[0]!.address) {
          return {
            ok: true,
            configured: true,
            totalAssetUsd: 200,
            assets: [
              {
                userId: blockedPersistUser.id,
                address,
                chain: 'bsc',
                assetKey: 'bsc:0xblocked',
                tokenAddress: '0xblocked',
                symbol: 'BLK',
                name: 'Blocked',
                balance: 100,
                priceUsd: 2,
                valueUsd: 200,
              },
            ],
            error: null,
          };
        }

        return {
          ok: true,
          configured: true,
          totalAssetUsd: 75,
          assets: [
            {
              userId: allowedPersistUser.id,
              address,
              chain: 'bsc',
              assetKey: 'bsc:0xallowed',
              tokenAddress: '0xallowed',
              symbol: 'ALW',
              name: 'Allowed',
              balance: 25,
              priceUsd: 3,
              valueUsd: 75,
            },
          ],
          error: null,
        };
      },
      fetchTokenLiquidity: async (_chain, tokenAddress) => ({
        liquidityUsd: tokenAddress === '0xblocked' ? 300 : 1_000,
      }),
    });

    assert.equal(persistResult.blockedUsers.length, 1, '应返回被拦截的用户信息');
    assert.equal(persistResult.blockedUsers[0]?.userId, blockedPersistUser.id);
    assert.deepEqual(
      persistResult.userAssets.map((item) => item.userId),
      [allowedPersistUser.id],
      '持久化前应过滤掉被拦截用户的总资产快照'
    );

    const db = getDb();
    const blockedUserRow = db
      .prepare(
        `SELECT total_asset_usd, historical_max_asset_usd
         FROM tracked_users
         WHERE id = ?`
      )
      .get(blockedPersistUser.id) as {
      total_asset_usd: number;
      historical_max_asset_usd: number;
    };
    assert.equal(blockedUserRow.total_asset_usd, 100, '被拦截用户的当前总资产不应更新');
    assert.equal(blockedUserRow.historical_max_asset_usd, 100, '被拦截用户的历史最高不应更新');

    const allowedUserRow = db
      .prepare(
        `SELECT total_asset_usd, historical_max_asset_usd
         FROM tracked_users
         WHERE id = ?`
      )
      .get(allowedPersistUser.id) as {
      total_asset_usd: number;
      historical_max_asset_usd: number;
    };
    assert.equal(allowedUserRow.total_asset_usd, 75, '允许用户的当前总资产应更新');
    assert.equal(allowedUserRow.historical_max_asset_usd, 75, '允许用户的历史最高应更新');

    const auditRow = db
      .prepare(
        `SELECT block_status, top_holdings_json
         FROM asset_peak_validation_blocks
         WHERE user_id = ?`
      )
      .get(blockedPersistUser.id) as {
      block_status: string;
      top_holdings_json: string;
    };
    assert.equal(auditRow.block_status, 'liquidity_ratio_exceeded', '应记录被拦截原因');
    assert.equal(JSON.parse(auditRow.top_holdings_json)[0]?.tokenAddress, '0xblocked', '应记录前五持仓快照');

    console.log('asset peak validation tests: ok');
  } finally {
    if (previousDbPath === undefined) {
      delete process.env.PILIPILI_DB_PATH;
    } else {
      process.env.PILIPILI_DB_PATH = previousDbPath;
    }

    if (previousOkxApiKey === undefined) {
      delete process.env.OKX_API_KEY;
    } else {
      process.env.OKX_API_KEY = previousOkxApiKey;
    }

    if (previousOkxSecret === undefined) {
      delete process.env.OKX_SECRET_KEY;
    } else {
      process.env.OKX_SECRET_KEY = previousOkxSecret;
    }

    if (previousOkxPassphrase === undefined) {
      delete process.env.OKX_API_PASSPHRASE;
    } else {
      process.env.OKX_API_PASSPHRASE = previousOkxPassphrase;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
