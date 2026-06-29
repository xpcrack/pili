import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

function createTempDir() {
  return mkdtempSync(path.join(tmpdir(), 'pilipili-sync-service-'));
}

async function run() {
  const tempDir = createTempDir();
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;

  try {
    process.env.PILIPILI_DATA_DIR = tempDir;
    process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

    const { getDb } = await import('../lib/server/sqlite');
    const {
      getSyncStatus,
      markOrphanedSyncRunsAsFailed,
      triggerSync,
    } = await import('../lib/server/syncService');
    const { acquireIngestionLease, releaseIngestionLease } = await import('../lib/server/twitterRepo');

    const db = getDb();
    const nowMs = Date.now();
    const insertRun = db.prepare(
      `INSERT INTO sync_runs (
        status,
        reason,
        started_at,
        created_at,
        updated_at
      ) VALUES ('running', ?, ?, ?, ?)`
    );

    const staleRun = insertRun.run('stale-running', nowMs - 60_000, nowMs - 60_000, nowMs - 60_000);
    const staleRunId = Number(staleRun.lastInsertRowid);

    const repaired = markOrphanedSyncRunsAsFailed(nowMs + 1_000);
    assert.equal(repaired, 1, 'orphaned running sync should be marked failed');

    const repairedRow = db
      .prepare('SELECT status, finished_at, duration_ms, error FROM sync_runs WHERE id = ?')
      .get(staleRunId) as { status: string; finished_at: number | null; duration_ms: number | null; error: string | null };
    assert.equal(repairedRow.status, 'failed');
    assert.equal(repairedRow.error, 'stale_or_orphaned_sync_run');
    assert.equal(typeof repairedRow.finished_at, 'number');
    assert.equal(typeof repairedRow.duration_ms, 'number');

    const statusAfterRepair = getSyncStatus();
    assert.equal(statusAfterRepair.running, false, 'stale repaired runs must not report running');

    const owner = 'test-owner';
    const leaseNow = Date.now();
    const leased = acquireIngestionLease('sync-service-global', owner, leaseNow, 5 * 60 * 1000);
    assert.equal(leased, true, 'test setup should acquire sync lease');

    const liveRun = insertRun.run('live-running', leaseNow, leaseNow, leaseNow);
    const liveRunId = Number(liveRun.lastInsertRowid);

    const blockedTrigger = triggerSync('blocked-by-live-lease');
    assert.equal(blockedTrigger.started, false, 'live lease should still block duplicate sync start');
    assert.equal(blockedTrigger.running, true, 'duplicate sync start should report running');

    const liveRow = db
      .prepare('SELECT status, error FROM sync_runs WHERE id = ?')
      .get(liveRunId) as { status: string; error: string | null };
    assert.equal(liveRow.status, 'running', 'live leased run must remain running');
    assert.equal(liveRow.error, null, 'live leased run must not be rewritten as stale');

    releaseIngestionLease('sync-service-global', owner);

    console.log('sync service tests: ok');
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

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
