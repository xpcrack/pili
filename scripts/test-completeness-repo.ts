import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';
import { getDb } from '../lib/server/sqlite';
import { readSystemConfig, saveSystemConfig } from '../lib/server/systemConfigRepo';
import {
  appendCompletenessRunSource,
  claimCompletenessPokes,
  createCompletenessRun,
  deleteClaimedCompletenessPokes,
  finishCompletenessRun,
  queueCompletenessPoke,
  readCompletenessGlobalState,
  readCompletenessSourceStates,
  readPendingCompletenessPokes,
  saveCompletenessGlobalState,
  saveCompletenessSourceState,
} from '../lib/server/completenessRepo';

function readColumnNames(tableName: string) {
  const db = getDb();
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-completeness-repo-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const db = getDb();

    assert.deepEqual(readColumnNames('completeness_global_state'), [
      'singleton_key',
      'configured_start_ms',
      'global_proven_start_ms',
      'status',
      'active_run_id',
      'last_success_at',
      'last_failure_at',
      'updated_at',
    ]);
    assert.deepEqual(readColumnNames('completeness_source_state'), [
      'source',
      'requested_start_ms',
      'proven_start_ms',
      'proven_end_ms',
      'status',
      'failure_count',
      'last_success_at',
      'last_failure_at',
      'blocked_reason',
      'checkpoint_json',
      'updated_at',
    ]);
    assert.deepEqual(readColumnNames('completeness_runs'), [
      'id',
      'reason',
      'trigger',
      'configured_start_ms',
      'status',
      'started_at',
      'finished_at',
      'global_proven_start_ms',
      'summary_json',
      'created_at',
      'updated_at',
    ]);
    assert.deepEqual(readColumnNames('completeness_run_sources'), [
      'id',
      'run_id',
      'source',
      'requested_start_ms',
      'proven_start_ms',
      'proven_end_ms',
      'status',
      'fetched_count',
      'stored_count',
      'projected_count',
      'blocked_reason',
      'checkpoint_json',
      'created_at',
      'updated_at',
    ]);
    assert.deepEqual(readColumnNames('completeness_pokes'), [
      'id',
      'trigger',
      'source_hint',
      'reason',
      'claimed_at',
      'created_at',
    ]);

    db.prepare('DELETE FROM completeness_run_sources').run();
    db.prepare('DELETE FROM completeness_runs').run();
    db.prepare('DELETE FROM completeness_pokes').run();
    db.prepare('DELETE FROM completeness_source_state').run();
    db.prepare('DELETE FROM completeness_global_state').run();

    saveSystemConfig({ completenessStartMs: '1712345678901' });
    assert.equal(readSystemConfig().completenessStartMs, 1712345678901);

    const firstRun = createCompletenessRun({
      reason: 'first run seeds global state',
      trigger: 'interval',
      configuredStartMs: null,
    });
    assert.ok(firstRun.id > 0);
    assert.deepEqual(readCompletenessGlobalState(), {
      configuredStartMs: null,
      globalProvenStartMs: null,
      status: 'running',
      activeRunId: firstRun.id,
      lastSuccessAt: null,
      lastFailureAt: null,
    });

    finishCompletenessRun(firstRun.id, 'complete', {
      globalProvenStartMs: 1711000000000,
    });
    assert.deepEqual(readCompletenessGlobalState(), {
      configuredStartMs: null,
      globalProvenStartMs: 1711000000000,
      status: 'complete',
      activeRunId: null,
      lastSuccessAt: readCompletenessGlobalState()?.lastSuccessAt ?? null,
      lastFailureAt: null,
    });
    assert.ok((readCompletenessGlobalState()?.lastSuccessAt ?? 0) > 0);

    saveCompletenessGlobalState({
      configuredStartMs: 1712345600000,
      globalProvenStartMs: 1712000000000,
      status: 'running',
      activeRunId: null,
      lastSuccessAt: null,
      lastFailureAt: 1712345609999,
    });
    assert.deepEqual(readCompletenessGlobalState(), {
      configuredStartMs: 1712345600000,
      globalProvenStartMs: 1712000000000,
      status: 'running',
      activeRunId: null,
      lastSuccessAt: null,
      lastFailureAt: 1712345609999,
    });
    assert.throws(() => {
      finishCompletenessRun(999999, 'complete', {
        globalProvenStartMs: 1711999999999,
      });
    });
    assert.deepEqual(readCompletenessGlobalState(), {
      configuredStartMs: 1712345600000,
      globalProvenStartMs: 1712000000000,
      status: 'running',
      activeRunId: null,
      lastSuccessAt: null,
      lastFailureAt: 1712345609999,
    });

    saveCompletenessSourceState({
      source: 'blockchain',
      requestedStartMs: 1712000000000,
      provenStartMs: 1712100000000,
      provenEndMs: 1712400000000,
      status: 'complete',
      failureCount: 0,
      lastSuccessAt: 1712400000000,
      lastFailureAt: null,
      blockedReason: null,
      checkpointJson: '{"cursor":"block-123"}',
    });
    saveCompletenessSourceState({
      source: 'twitter',
      requestedStartMs: 1712200000000,
      provenStartMs: null,
      provenEndMs: null,
      status: 'blocked',
      failureCount: 2,
      lastSuccessAt: null,
      lastFailureAt: 1712300000000,
      blockedReason: 'rate limited',
      checkpointJson: '{"sinceId":"99"}',
    });
    assert.deepEqual(readCompletenessSourceStates(), [
      {
        source: 'blockchain',
        requestedStartMs: 1712000000000,
        provenStartMs: 1712100000000,
        provenEndMs: 1712400000000,
        status: 'complete',
        failureCount: 0,
        lastSuccessAt: 1712400000000,
        lastFailureAt: null,
        blockedReason: null,
        checkpointJson: '{"cursor":"block-123"}',
      },
      {
        source: 'twitter',
        requestedStartMs: 1712200000000,
        provenStartMs: null,
        provenEndMs: null,
        status: 'blocked',
        failureCount: 2,
        lastSuccessAt: null,
        lastFailureAt: 1712300000000,
        blockedReason: 'rate limited',
        checkpointJson: '{"sinceId":"99"}',
      },
    ]);

    const run = createCompletenessRun({
      reason: null,
      trigger: 'manual',
      configuredStartMs: null,
    });
    assert.ok(run.id > 0);
    assert.deepEqual(readCompletenessGlobalState(), {
      configuredStartMs: null,
      globalProvenStartMs: 1712000000000,
      status: 'running',
      activeRunId: run.id,
      lastSuccessAt: null,
      lastFailureAt: 1712345609999,
    });

    appendCompletenessRunSource({
      runId: run.id,
      source: 'blockchain',
      requestedStartMs: 1712000000000,
      provenStartMs: 1712100000000,
      provenEndMs: 1712400000000,
      status: 'complete',
      fetchedCount: 10,
      storedCount: 8,
      projectedCount: 7,
      blockedReason: null,
      checkpointJson: '{"cursor":"block-123"}',
    });

    finishCompletenessRun(run.id, 'partial', {
      globalProvenStartMs: 1712100000000,
      note: 'twitter blocked',
      sourceStatuses: {
        blockchain: 'complete',
        twitter: 'blocked',
      },
    });

    const runRow = db
      .prepare(
        `SELECT reason, trigger, configured_start_ms, status, global_proven_start_ms, summary_json
         FROM completeness_runs
         WHERE id = ?`
      )
      .get(run.id) as
      | {
          reason: string | null;
          trigger: string;
          configured_start_ms: number;
          status: string;
          global_proven_start_ms: number | null;
          summary_json: string | null;
        }
      | undefined;
    assert.deepEqual(runRow, {
      reason: null,
      trigger: 'manual',
      configured_start_ms: null,
      status: 'partial',
      global_proven_start_ms: 1712100000000,
      summary_json: JSON.stringify({
        globalProvenStartMs: 1712100000000,
        note: 'twitter blocked',
        sourceStatuses: {
          blockchain: 'complete',
          twitter: 'blocked',
        },
      }),
    });

    const runSourceRow = db
      .prepare(
        `SELECT run_id, source, requested_start_ms, proven_start_ms, proven_end_ms, status,
                fetched_count, stored_count, projected_count, blocked_reason, checkpoint_json
         FROM completeness_run_sources
         WHERE run_id = ? AND source = ?`
      )
      .get(run.id, 'blockchain') as
      | {
          run_id: number;
          source: string;
          requested_start_ms: number | null;
          proven_start_ms: number | null;
          proven_end_ms: number | null;
          status: string;
          fetched_count: number;
          stored_count: number;
          projected_count: number;
          blocked_reason: string | null;
          checkpoint_json: string | null;
        }
      | undefined;
    assert.deepEqual(runSourceRow, {
      run_id: run.id,
      source: 'blockchain',
      requested_start_ms: 1712000000000,
      proven_start_ms: 1712100000000,
      proven_end_ms: 1712400000000,
      status: 'complete',
      fetched_count: 10,
      stored_count: 8,
      projected_count: 7,
      blocked_reason: null,
      checkpoint_json: '{"cursor":"block-123"}',
    });

    const pokeId = queueCompletenessPoke({
      trigger: 'recovery',
      sourceHint: 'telegram-channel',
      reason: null,
    });

    const pending = readPendingCompletenessPokes(10);
    assert.deepEqual(
      pending.map((row) => ({
        id: row.id,
        trigger: row.trigger,
        sourceHint: row.sourceHint,
        reason: row.reason,
        claimedAt: row.claimedAt,
      })),
      [
        {
          id: pokeId,
          trigger: 'recovery',
          sourceHint: 'telegram-channel',
          reason: null,
          claimedAt: null,
        },
      ]
    );

    claimCompletenessPokes([pokeId], 1712345905000);
    const claimedRow = db
      .prepare('SELECT trigger, source_hint, reason, claimed_at FROM completeness_pokes WHERE id = ?')
      .get(pokeId) as
      | {
          trigger: string;
          source_hint: string | null;
          reason: string | null;
          claimed_at: number | null;
        }
      | undefined;
    assert.deepEqual(claimedRow, {
      trigger: 'recovery',
      source_hint: 'telegram-channel',
      reason: null,
      claimed_at: 1712345905000,
    });
    assert.equal(readPendingCompletenessPokes(10).length, 0);

    deleteClaimedCompletenessPokes([pokeId]);
    const remainingPokes = db.prepare('SELECT COUNT(*) as count FROM completeness_pokes').get() as { count: number };
    assert.equal(remainingPokes.count, 0);

    console.log('completeness repo tests: ok');
  } finally {
    if (typeof previousDbPath === 'string') {
      process.env.PILIPILI_DB_PATH = previousDbPath;
    } else {
      delete process.env.PILIPILI_DB_PATH;
    }
    if (typeof previousDataDir === 'string') {
      process.env.PILIPILI_DATA_DIR = previousDataDir;
    } else {
      delete process.env.PILIPILI_DATA_DIR;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
