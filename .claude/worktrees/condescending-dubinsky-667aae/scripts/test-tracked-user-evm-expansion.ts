import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

import type { User } from '@/types';

const EVM_ADDRESS = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf03';

function createTempDbDir() {
  return mkdtempSync(path.join(tmpdir(), 'pilipili-tracked-user-evm-expansion-'));
}

function buildUser(): Omit<User, 'id'> {
  return {
    name: '王小二',
    handle: 'wangxiaoer',
    avatar: 'wangxiaoer.png',
    tags: [],
    addresses: [
      {
        address: EVM_ADDRESS,
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
  };
}

async function run() {
  const tempDir = createTempDbDir();
  const previousDbPath = process.env.PILIPILI_DB_PATH;

  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { createTrackedUser, listTrackedUsers } = await import('@/lib/server/trackedUsersRepo');
    const { getDb } = await import('@/lib/server/sqlite');
    const user = createTrackedUser(buildUser());

    assert.deepEqual(
      user.addresses.map((address) => address.chain).sort(),
      ['base', 'bsc', 'ethereum'],
      '服务端持久化时应自动将单个 EVM 地址展开为 BSC / Ethereum / Base 三链'
    );

    const db = getDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO tracked_users (
        id,
        name,
        handle,
        avatar,
        twitter,
        telegram,
        tags_json,
        total_asset_usd,
        historical_max_asset_usd,
        asset_updated_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, '[]', 0, 0, NULL, ?, ?)`
    ).run('legacy-user', 'Legacy', 'legacy', 'legacy.png', now, now);
    db.prepare(
      `INSERT INTO tracked_addresses (
        id,
        user_id,
        address,
        address_lower,
        name,
        chain,
        total_asset_usd,
        asset_updated_at,
        last_synced_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`
    ).run(
      `legacy-user:bsc:${EVM_ADDRESS.toLowerCase()}`,
      'legacy-user',
      EVM_ADDRESS,
      EVM_ADDRESS.toLowerCase(),
      '#1',
      'bsc',
      now,
      now
    );

    const stored = listTrackedUsers().find((candidate) => candidate.id === user.id);
    assert.ok(stored, '应能读回已创建人物');
    assert.deepEqual(stored.addresses.map((address) => address.chain).sort(), ['base', 'bsc', 'ethereum']);

    const legacy = listTrackedUsers().find((candidate) => candidate.id === 'legacy-user');
    assert.ok(legacy, '应能读回旧版单链 EVM 人物');
    assert.deepEqual(
      legacy.addresses.map((address) => address.chain).sort(),
      ['base', 'bsc', 'ethereum'],
      '读取旧版单链 EVM 数据时也应自动补齐三链地址'
    );

    console.log('tracked user evm expansion tests: ok');
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
