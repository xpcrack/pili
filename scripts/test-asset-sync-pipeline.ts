import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import type { AddressAssetSnapshot, AddressDiagnostic, UserAssetSnapshot } from '@/lib/activityFeed';
import { runAssetSyncPipeline } from '@/lib/server/assetSyncPipeline';
import type { User } from '@/types';

function createUser(id: string, address: string): User {
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
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
  };
}

async function run() {
  const users = [createUser('user-ok', '0xok'), createUser('user-blocked', '0xblocked')];
  const addressAssets: AddressAssetSnapshot[] = [
    {
      userId: 'user-ok',
      address: '0xok',
      chain: 'bsc',
      totalAssetUsd: 120,
      updatedAt: 1_700_000_000_000,
    },
    {
      userId: 'user-blocked',
      address: '0xblocked',
      chain: 'bsc',
      totalAssetUsd: 999_999,
      updatedAt: 1_700_000_000_000,
    },
  ];
  const userAssets: UserAssetSnapshot[] = [
    {
      userId: 'user-ok',
      totalValueUsd: 120,
      totalAssetUsd: 120,
      updatedAt: 1_700_000_000_000,
    },
    {
      userId: 'user-blocked',
      totalValueUsd: 999_999,
      totalAssetUsd: 999_999,
      updatedAt: 1_700_000_000_000,
    },
  ];
  const diagnostics: AddressDiagnostic[] = [
    {
      userId: 'user-ok',
      userName: 'user-ok',
      address: '0xok',
      addressName: '#1',
      chain: 'bsc',
      ok: true,
      transactionCount: 3,
      error: null,
      fetchAttempts: 1,
    },
    {
      userId: 'user-blocked',
      userName: 'user-blocked',
      address: '0xblocked',
      addressName: '#1',
      chain: 'bsc',
      ok: false,
      transactionCount: 0,
      error: 'OKX API 500',
      fetchAttempts: 3,
      retryExhausted: true,
    },
  ];

  const blockedUsers = [
    {
      userId: 'user-blocked',
      userName: 'user-blocked',
      candidateTotalAssetUsd: 999_999,
      previousHistoricalMaxAssetUsd: 100,
      status: 'liquidity_ratio_exceeded' as const,
      reason: 'too large',
      topHoldings: [],
    },
  ];

  let validateCalls = 0;
  const markCalls: Array<Array<{ chain: string; address: string; syncedAt: number }>> = [];
  const syncedAt = 1_700_000_123_456;

  const result = await runAssetSyncPipeline({
    users,
    addressAssets,
    userAssets,
    diagnostics,
    syncedAt,
    validateAndPersistPeakAssetSnapshots: async (params) => {
      validateCalls += 1;
      assert.strictEqual(params.users, users, '应将 users 原样传给校验器');
      assert.strictEqual(params.addressAssets, addressAssets, '应将 addressAssets 原样传给校验器');
      assert.strictEqual(params.userAssets, userAssets, '应将 userAssets 原样传给校验器');
      return {
        addressAssets: [addressAssets[0]!],
        userAssets: [userAssets[0]!],
        blockedUsers,
      };
    },
    markAddressesSynced: (cursors) => {
      markCalls.push(cursors);
    },
  });

  assert.equal(validateCalls, 1, '应只执行一次峰值资产校验');
  assert.equal(result.blockedUsers.length, 1, '应返回 1 个被拦截用户');
  assert.equal(result.blockedUsers[0]?.userId, 'user-blocked');
  assert.deepEqual(
    result.persistedAddressAssets,
    [addressAssets[0]!],
    '应返回校验后允许持久化的地址资产快照'
  );
  assert.deepEqual(
    result.persistedUserAssets,
    [userAssets[0]!],
    'persistedUserAssets 只应保留通过校验的用户'
  );
  assert.deepEqual(
    result.syncedCursors,
    [
      {
        chain: 'bsc',
        address: '0xok',
        syncedAt,
      },
    ],
    '应只为 ok diagnostics 生成 synced cursors'
  );
  assert.deepEqual(
    markCalls,
    [
      [
        {
          chain: 'bsc',
          address: '0xok',
          syncedAt,
        },
      ],
    ],
    'markAddressesSynced 只应接收 ok diagnostics'
  );

  console.log('test-asset-sync-pipeline passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
