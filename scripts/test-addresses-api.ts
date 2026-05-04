import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildGmgnAddressUrl } from '@/lib/addressBook';
import './server-only-shim.cjs';

function createTempDbDir() {
  return mkdtempSync(path.join(tmpdir(), 'pilipili-addresses-api-'));
}

interface AddressManagementRow {
  userId: string;
  userName: string;
  addressName: string;
  displayName: string;
  address: string;
  primaryChain: string;
  chains: string[];
  networkLabel: string;
  latestActivityAt: number | null;
  totalAssetUsd: number | null;
  assetUpdatedAt: number | null;
  gmgnUrl: string | null;
}

interface AddressesPayload {
  ok: boolean;
  rows: AddressManagementRow[];
}

function insertBlockchainEvent(
  eventId: string,
  timestamp: number,
  userName: string,
  chain: string,
  address: string,
  txHash: string,
  now: number
) {
  return {
    eventId,
    timestamp,
    userName,
    chain,
    address,
    txHash,
    dedupKey: eventId,
    now,
  };
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
    const route = await import('../app/api/addresses/route');

    createTrackedUser({
      name: 'Alpha',
      handle: 'alpha',
      avatar: 'alpha.png',
      tags: [],
      addresses: [
        {
          address: 'testuser_solana_placeholder_1111111111111111',
          name: '#1',
          chain: 'solana',
          totalAssetUsd: 88,
          assetUpdatedAt: 111,
        },
      ],
      totalAssetUsd: 88,
      historicalMaxAssetUsd: 88,
      assetUpdatedAt: 111,
      twitter: undefined,
      telegram: undefined,
    });

    createTrackedUser({
      name: 'Beta',
      handle: 'beta',
      avatar: 'beta.png',
      tags: [],
      addresses: [
        {
          address: '0xAbCdEf0000000000000000000000000000000001',
          name: '#1',
          chain: 'bsc',
          totalAssetUsd: 10,
          assetUpdatedAt: 200,
        },
      ],
      totalAssetUsd: 10,
      historicalMaxAssetUsd: 10,
      assetUpdatedAt: 200,
      twitter: undefined,
      telegram: undefined,
    });

    const now = Date.now();
    const db = getDb();
    const insertEvent = db.prepare(
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
      ) VALUES (?, 'blockchain', 'transfer', ?, NULL, ?, ?, ?, 'test event', NULL, 'swap', NULL, NULL, ?, 'test', ?, '{}', '{}', '{}', '{}', ?, ?, ?)`
    );

    for (const event of [
      insertBlockchainEvent(
        'addresses-alpha-solana',
        5000,
        'Alpha',
        'solana',
        'testuser_solana_placeholder_1111111111111111',
        'tx-alpha-sol',
        now
      ),
      insertBlockchainEvent(
        'addresses-beta-bsc',
        7000,
        'Beta',
        'bsc',
        '0xabcdef0000000000000000000000000000000001',
        'tx-beta-bsc',
        now
      ),
      insertBlockchainEvent(
        'addresses-beta-ethereum',
        9000,
        'Beta',
        'ethereum',
        '0xabcdef0000000000000000000000000000000001',
        'tx-beta-eth',
        now
      ),
    ]) {
      insertEvent.run(
        event.eventId,
        event.timestamp,
        event.userName,
        event.chain,
        event.address,
        event.txHash,
        event.dedupKey,
        event.now,
        event.now,
        event.now
      );
    }

    const response = await route.GET();
    assert.equal(response.status, 200);

    const payload = (await response.json()) as AddressesPayload;
    assert.equal(payload.ok, true);
    assert.equal(payload.rows.length, 2);

    const alphaRow = payload.rows.find((row) => row.userName === 'Alpha' && row.addressName === '#1');
    assert.ok(alphaRow);
    assert.equal(alphaRow.displayName, 'Alpha#1');
    assert.equal(alphaRow.address, 'testuser_solana_placeholder_1111111111111111');
    assert.equal(alphaRow.primaryChain, 'solana');
    assert.deepEqual(alphaRow.chains, ['solana']);
    assert.equal(alphaRow.networkLabel, 'SOL地址');
    assert.equal(alphaRow.latestActivityAt, 5000);
    assert.equal(alphaRow.totalAssetUsd, 88);
    assert.equal(alphaRow.assetUpdatedAt, 111);
    assert.equal(
      alphaRow.gmgnUrl,
      buildGmgnAddressUrl('solana', 'testuser_solana_placeholder_1111111111111111')
    );

    const betaRow = payload.rows.find((row) => row.userName === 'Beta' && row.addressName === '#1');
    assert.ok(betaRow);
    assert.equal(betaRow.displayName, 'Beta#1');
    assert.equal(betaRow.address, '0xAbCdEf0000000000000000000000000000000001');
    assert.equal(betaRow.primaryChain, 'bsc');
    assert.deepEqual(betaRow.chains, ['bsc']);
    assert.equal(betaRow.networkLabel, 'EVM地址');
    assert.equal(betaRow.latestActivityAt, 9000);
    assert.equal(betaRow.totalAssetUsd, 10);
    assert.equal(betaRow.assetUpdatedAt, 200);
    assert.equal(
      betaRow.gmgnUrl,
      buildGmgnAddressUrl('bsc', '0xAbCdEf0000000000000000000000000000000001')
    );

    console.log('addresses api tests: ok');
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
