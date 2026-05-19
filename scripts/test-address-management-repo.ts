import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

function createTempDbDir() {
  return mkdtempSync(path.join(tmpdir(), 'pilipili-address-management-repo-'));
}

async function run() {
  const tempDir = createTempDbDir();
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;

  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { createTrackedUser } = await import('@/lib/server/trackedUsersRepo');
    const { getDb } = await import('@/lib/server/sqlite');
    const { listAddressManagementRows } = await import('@/lib/server/addressManagementRepo');

    createTrackedUser({
      name: 'Perf',
      handle: 'perf',
      avatar: 'perf.png',
      tags: [],
      addresses: [
        {
          address: '0xAbCdEf0000000000000000000000000000000001',
          name: '#1',
          chain: 'bsc',
          totalAssetUsd: 10,
          assetUpdatedAt: 100,
        },
      ],
      totalAssetUsd: 10,
      historicalMaxAssetUsd: 10,
      assetUpdatedAt: 100,
      twitter: undefined,
      telegram: undefined,
    });

    const db = getDb();
    const queryPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT MAX(timestamp) AS latest_ts
         FROM events
         WHERE source = 'blockchain'
           AND chain = ?
           AND TRIM(COALESCE(address, '')) <> ''
           AND LOWER(address) = ?`
      )
      .all('bsc', '0xabcdef0000000000000000000000000000000001') as Array<Record<string, unknown>>;

    const planText = queryPlan.map((row) => Object.values(row).join(' | ')).join('\n');

    assert.match(
      planText,
      /idx_events_blockchain_chain_address_lower_timestamp/,
      `latest activity lookup should use the source+chain+lower\(address\) index, got:\n${planText}`
    );

    const rows = listAddressManagementRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.displayName, 'Perf#1');

    console.log('address management repo tests: ok');
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

    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
