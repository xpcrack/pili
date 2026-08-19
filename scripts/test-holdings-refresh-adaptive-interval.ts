import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function main() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-holdings-adaptive-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');
  // Small deterministic windows so assertions stay readable.
  process.env.HOLDINGS_QUIET_INTERVAL_MS = '240000'; // native fallback = 4min

  try {
    const { getDb } = await import('@/lib/server/sqlite');
    const { runHoldingsRefreshQueueCycle } = await import('@/lib/server/holdingsRefreshQueue');
    const db = getDb();
    db.prepare(
      `INSERT INTO tracked_users (id, name, handle, avatar, total_asset_usd, historical_max_asset_usd, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?)`
    ).run('u1', 'Adaptive User', 'adaptive', '', 1, 1);

    const insertAddress = db.prepare(
      `INSERT INTO tracked_addresses (id, user_id, address, address_lower, name, chain, created_at, updated_at, monitoring_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
    );
    insertAddress.run('a_active', 'u1', 'WalletActive', 'walletactive', 'active', 'base', 1, 1);
    insertAddress.run('a_quiet', 'u1', 'WalletQuiet', 'walletquiet', 'quiet', 'base', 1, 1);

    // Both wallets "just refreshed" at now (1_000_000) so their seeded due_at
    // lands in the future and the claim loop never fires — lets us inspect the
    // seed interval directly without the claim mutating either row.
    const insertStatus = db.prepare(
      `INSERT INTO current_holdings_wallet_status (tracked_address, tracked_address_lower, user_id, chain, status, refreshed_at)
       VALUES (?, ?, ?, ?, 'success', ?)`
    );
    insertStatus.run('WalletActive', 'walletactive', 'u1', 'base', 1_000_000);
    insertStatus.run('WalletQuiet', 'walletquiet', 'u1', 'base', 1_000_000);

    // The active wallet has a recent on-chain trade (within the 60s window).
    db.prepare(
      `INSERT INTO events (
         event_id, source, kind, timestamp, user_id, user_name,
         chain, address, content, url, action, token, tweet_id, tx_hash,
         ingest_source, dedup_key, metadata_json, payload_json,
         user_json, activity_json, indexed_at, created_at, updated_at
       ) VALUES (
         ?, 'blockchain', 'transfer', ?, ?, ?,
         ?, ?, ?, NULL, ?, ?, NULL, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?, ?
       )`
    ).run(
      'test:base:walletactive:tx1',
      990_000,
      'u1',
      'Adaptive User',
      'base',
      'WalletActive',
      'buy token',
      'buy',
      'TOKEN',
      'txhash1',
      'live-monitor-alchemy-gmgn',
      'test:base:walletactive:tx1',
      '{}',
      '{}',
      '{}',
      '{}',
      990_000,
      990_000,
      990_000,
    );

    const refreshWallet = async () => {
      throw new Error('no wallet should be claimable in this test');
    };

    await runHoldingsRefreshQueueCycle({ db, now: () => 1_000_000, refreshWallet });

    const active = db.prepare(
      `SELECT due_at_ms FROM holdings_refresh_jobs WHERE wallet_chain = 'evm:walletactive'`
    ).get() as { due_at_ms: number } | undefined;
    const quiet = db.prepare(
      `SELECT due_at_ms FROM holdings_refresh_jobs WHERE wallet_chain = 'evm:walletquiet'`
    ).get() as { due_at_ms: number } | undefined;

    assert.equal(active?.due_at_ms, 1_000_000 + 240_000, 'recent trades no longer create a 30-minute polling loop');
    assert.equal(quiet?.due_at_ms, 1_000_000 + 240_000, 'native wallets share the low-frequency fallback');

    console.log('holdings adaptive interval tests: ok');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
