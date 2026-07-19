import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function loadModules() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const sqlite = await import(`../lib/server/sqlite.ts?repo-test=${stamp}`);
  const repo = await import(`../lib/server/holderSnapshotRepo.ts?repo-test=${stamp}`);
  return {
    getDb: sqlite.getDb,
    repo,
  };
}

function readColumnNames(getDb: () => { prepare(sql: string): { all(...params: unknown[]): unknown[] } }, tableName: string) {
  const rows = getDb().prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-holder-snapshot-repo-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { getDb, repo } = await loadModules();
    const db = getDb();
    repo.ensureHolderSnapshotTables(db);

    assert.deepEqual(readColumnNames(getDb, 'holder_snapshot_runs'), [
      'id',
      'chain',
      'token_address',
      'token_address_lower',
      'token_symbol',
      'tracked_wallet_address',
      'tracked_wallet_address_lower',
      'user_id',
      'trigger_type',
      'trigger_source',
      'trade_action',
      'tx_hash',
      'tx_hash_lower',
      'trade_time_ms',
      'holdings_refreshed_at',
      'period_bucket_start_ms',
      'dedupe_key',
      'status',
      'attempt_count',
      'holder_count',
      'error',
      'meta_json',
      'requested_at',
      'started_at',
      'completed_at',
      'updated_at',
    ]);
    assert.deepEqual(readColumnNames(getDb, 'holder_snapshot_holders'), [
      'id',
      'snapshot_run_id',
      'holder_rank',
      'address',
      'account_address',
      'addr_type',
      'exchange',
      'wallet_tag_v2',
      'name',
      'twitter_username',
      'balance',
      'amount_percentage',
      'usd_value',
      'cost',
      'profit',
      'avg_cost',
      'realized_profit',
      'unrealized_profit',
      'buy_tx_count_cur',
      'sell_tx_count_cur',
      'is_new',
      'is_suspicious',
      'raw_json',
      'created_at',
    ]);

    db.prepare(
      `INSERT INTO tracked_users (id, name, handle, avatar, created_at, updated_at)
       VALUES ('user-1', 'User 1', 'user1', 'avatar', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO tracked_addresses (id, user_id, address, address_lower, name, chain, created_at, updated_at)
       VALUES ('addr-1', 'user-1', ?, ?, '#1', 'solana', 1, 1)`
    ).run('CJ5fHkNPf3yd7fKnjv5VtBJTNDAWFiRfLCutpuTAnpis', 'cj5fhknpf3yd7fknjv5vtbjtndawfirflcutputanpis');

    db.prepare(
      `INSERT INTO telegram_monitor_tx_states (
         user_id, chain, tracked_wallet_address, tracked_wallet_address_lower,
         tx_hash, tx_hash_lower, token_address, token_address_lower, token_symbol,
         provisional_action, event_time_ms, canonical_activity_json,
         reconciliation_status, first_seen_at, last_seen_at, updated_at
       ) VALUES (?, 'solana', ?, ?, ?, ?, ?, ?, 'AAA', 'buy', 111, '{}', 'reconciled', 1, 1, 1)`
    ).run(
      'user-1',
      'CJ5fHkNPf3yd7fKnjv5VtBJTNDAWFiRfLCutpuTAnpis',
      'cj5fhknpf3yd7fknjv5vtbjtndawfirflcutputanpis',
      'tx-1',
      'tx-1',
      'TokenAAA11111111111111111111111111111111111',
      'TokenAAA11111111111111111111111111111111111'
    );

    let queued = repo.queueTradeTriggeredHolderSnapshots({
      walletAddress: 'CJ5fHkNPf3yd7fKnjv5VtBJTNDAWFiRfLCutpuTAnpis',
      db,
    });
    assert.equal(queued.scannedCount, 1);
    assert.equal(queued.queuedCount, 1);
    assert.equal(repo.readHolderSnapshotTradeCursor(db), 1);

    queued = repo.queueTradeTriggeredHolderSnapshots({
      walletAddress: 'CJ5fHkNPf3yd7fKnjv5VtBJTNDAWFiRfLCutpuTAnpis',
      db,
    });
    assert.equal(queued.scannedCount, 0);
    assert.equal(repo.listHolderSnapshotRuns(db).length, 1);

    db.prepare(
      `INSERT INTO current_holdings (
         tracked_address, tracked_address_lower, user_id, chain,
         token_address, token_address_lower, symbol, refreshed_at
       ) VALUES (?, ?, 'user-1', 'solana', ?, ?, 'BBB', 222)`
    ).run(
      'CJ5fHkNPf3yd7fKnjv5VtBJTNDAWFiRfLCutpuTAnpis',
      'cj5fhknpf3yd7fknjv5vtbjtndawfirflcutputanpis',
      'TokenBBB11111111111111111111111111111111111',
      'TokenBBB11111111111111111111111111111111111'
    );

    const periodic = repo.queuePeriodicHolderSnapshots({
      walletAddress: 'CJ5fHkNPf3yd7fKnjv5VtBJTNDAWFiRfLCutpuTAnpis',
      bucketStartMs: 21600000,
      db,
    });
    assert.equal(periodic.tokenCount, 1);
    assert.equal(periodic.queuedCount, 1);
    assert.equal(repo.readHolderSnapshotPeriodicCursor(db), 21600000);

    const periodicAgain = repo.queuePeriodicHolderSnapshots({
      walletAddress: 'CJ5fHkNPf3yd7fKnjv5VtBJTNDAWFiRfLCutpuTAnpis',
      bucketStartMs: 21600000,
      db,
    });
    assert.equal(periodicAgain.queuedCount, 0);

    const claimed = repo.claimNextQueuedHolderSnapshotRun(db);
    assert.ok(claimed);
    assert.equal(claimed?.status, 'running');

    const completed = repo.completeHolderSnapshotRun({
      runId: claimed!.id,
      holders: [
        {
          holderRank: 1,
          address: 'holder-1',
          amountPercentage: 12.5,
          isNew: true,
          raw: { rank: 1, address: 'holder-1' },
        },
      ],
      meta: { payloadShape: 'list' },
      db,
    });
    assert.equal(completed?.status, 'completed');
    assert.equal(completed?.holderCount, 1);
    const holders = repo.listHolderSnapshotHolders(claimed!.id, db);
    assert.equal(holders.length, 1);
    assert.equal(holders[0]?.address, 'holder-1');
    assert.equal(holders[0]?.isNew, true);

    const secondClaim = repo.claimNextQueuedHolderSnapshotRun(db);
    assert.ok(secondClaim);
    const failed = repo.failHolderSnapshotRun({
      runId: secondClaim!.id,
      error: 'boom',
      meta: { exitCode: 1 },
      db,
    });
    assert.equal(failed?.status, 'failed');
    assert.match(failed?.error || '', /boom/);

    console.log('holder snapshot repo tests: ok');
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.PILIPILI_DATA_DIR;
    } else {
      process.env.PILIPILI_DATA_DIR = previousDataDir;
    }
    if (previousDbPath === undefined) {
      delete process.env.PILIPILI_DB_PATH;
    } else {
      process.env.PILIPILI_DB_PATH = previousDbPath;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
