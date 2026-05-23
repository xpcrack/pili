import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

import type { User } from '@/types';

const TARGET_ADDRESS = 'testuser_solana_placeholder_1111111111111111';
const TARGET_CHAIN = 'solana' as const;

function createTempDbDir() {
  return mkdtempSync(path.join(tmpdir(), 'pilipili-tracked-address-ownership-'));
}

function buildUser(name: string, handle: string, address = TARGET_ADDRESS): Omit<User, 'id'> {
  return {
    name,
    handle,
    avatar: `${handle}.png`,
    tags: [],
    addresses: [
      {
        address,
        name: '#1',
        chain: TARGET_CHAIN,
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
    const {
      createTrackedUser,
      importTrackedUsers,
      repairTrackedAddressOwnership,
    } = await import('@/lib/server/trackedUsersRepo');
    const { getDb } = await import('@/lib/server/sqlite');
    const db = getDb();

    const finn = createTrackedUser(buildUser('Finn', 'finn'));

    assert.throws(
      () => createTrackedUser(buildUser('Alpha', 'alpha')),
      /already belongs to another tracked user|已归属|归属于/
    );

    // importTrackedUsers now skips conflicting users instead of throwing
    const importResult = importTrackedUsers([{ id: 'alpha-import', ...buildUser('Alpha', 'alpha') } as User], { replaceExisting: false });
    assert.equal(importResult.importedCount, 0);
    assert.equal(importResult.skippedUsers.length, 1);
    assert.equal(importResult.skippedUsers[0].userId, 'alpha-import');
    assert.match(importResult.skippedUsers[0].reason, /已归属|归属于/);

    const now = Date.now();
    const alphaId = 'alpha-conflict-user';
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
    ).run(alphaId, 'Alpha', 'alpha', 'alpha.png', now, now);
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
      `${alphaId}:${TARGET_CHAIN}:${TARGET_ADDRESS.toLowerCase()}`,
      alphaId,
      TARGET_ADDRESS,
      TARGET_ADDRESS.toLowerCase(),
      '#1',
      TARGET_CHAIN,
      now,
      now
    );

    const alphaUserJson = JSON.stringify({ id: alphaId, name: 'Alpha' });
    const finnUserJson = JSON.stringify({ id: finn.id, name: 'Finn' });
    const alphaActivityJson = JSON.stringify({
      id: 'alpha-activity',
      userId: alphaId,
      source: 'blockchain',
      type: 'transfer',
      content: '加仓0.5SOL',
      timestamp: 1777261157000,
      metadata: {
        chain: TARGET_CHAIN,
        trackedAddress: TARGET_ADDRESS,
        txHash: '4vtpHCsyixRwfZaCgrpkZK1C78Q4H385izKhXc2HzJMaUo5eML4kVFjKamYGJZb6Ddg39uJMzmMeuJDcfE9AZKHC',
      },
    });

    db.prepare(
      `INSERT INTO events (
        event_id,
        source,
        kind,
        timestamp,
        user_id,
        user_name,
        chain,
        address,
        content,
        url,
        action,
        token,
        tweet_id,
        tx_hash,
        ingest_source,
        dedup_key,
        metadata_json,
        payload_json,
        user_json,
        activity_json,
        indexed_at,
        created_at,
        updated_at
      ) VALUES (?, 'blockchain', 'transfer', ?, ?, 'Alpha', ?, ?, '加仓0.5SOL', NULL, 'buy', 'HENRY', NULL, ?, 'telegram-monitor-ingest', ?, '{}', '{}', ?, ?, ?, ?, ?)`
    ).run(
      'repair-test-event',
      1777261157000,
      alphaId,
      TARGET_CHAIN,
      TARGET_ADDRESS.toLowerCase(),
      'repair-test-tx',
      'repair-test-event',
      alphaUserJson,
      alphaActivityJson,
      now,
      now,
      now
    );

    db.prepare(
      `INSERT INTO activity_feed (
        user_id,
        activity_key,
        timestamp,
        tx_hash_lower,
        chain,
        tracked_address_lower,
        source,
        type,
        user_json,
        activity_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'blockchain', 'transfer', ?, ?, ?)`
    ).run(
      alphaId,
      'repair-test-feed',
      1777261157000,
      'repair-test-tx',
      TARGET_CHAIN,
      TARGET_ADDRESS.toLowerCase(),
      alphaUserJson,
      alphaActivityJson,
      now
    );

    const repairResult = repairTrackedAddressOwnership({
      chain: TARGET_CHAIN,
      address: TARGET_ADDRESS,
      ownerUserId: finn.id,
    });

    assert.equal(repairResult.removedOwnerCount, 1);

    const addressOwners = db
      .prepare(
        `SELECT user_id
         FROM tracked_addresses
         WHERE chain = ? AND address_lower = ?
         ORDER BY user_id ASC`
      )
      .all(TARGET_CHAIN, TARGET_ADDRESS.toLowerCase()) as Array<{ user_id: string }>;
    assert.deepEqual(addressOwners, [{ user_id: finn.id }]);

    const repairedEvent = db
      .prepare(
        `SELECT user_id, user_name, user_json, activity_json
         FROM events
         WHERE event_id = 'repair-test-event'`
      )
      .get() as {
      user_id: string;
      user_name: string;
      user_json: string;
      activity_json: string;
    };
    assert.equal(repairedEvent.user_id, finn.id);
    assert.equal(repairedEvent.user_name, 'Finn');
    assert.equal(JSON.parse(repairedEvent.user_json).id, finn.id);
    assert.equal(JSON.parse(repairedEvent.activity_json).userId, finn.id);

    const repairedFeed = db
      .prepare(
        `SELECT user_id, user_json, activity_json
         FROM activity_feed
         WHERE activity_key = 'repair-test-feed'`
      )
      .get() as {
      user_id: string;
      user_json: string;
      activity_json: string;
    };
    assert.equal(repairedFeed.user_id, finn.id);
    assert.equal(JSON.parse(repairedFeed.user_json).id, finn.id);
    assert.equal(JSON.parse(repairedFeed.activity_json).userId, finn.id);

    assert.equal(finnUserJson.includes('Finn'), true);

    console.log('tracked address ownership tests: ok');
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
