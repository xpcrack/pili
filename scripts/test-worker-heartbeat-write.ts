import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'pili-heartbeat-'));
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  process.env.PILIPILI_DATA_DIR = dataDir;
  process.env.PILIPILI_DB_PATH = path.join(dataDir, 'test.sqlite');

  try {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { getDb } = await import(`../lib/server/sqlite.ts?heartbeat=${stamp}`);
    const { touchWorkerHeartbeat, upsertWorkerStatus } = await import(
      `../lib/server/workerStateRepo.ts?heartbeat=${stamp}`
    );
    const db = getDb();
    upsertWorkerStatus({ workerKey: 'heartbeat-test', workerType: 'test', status: 'running' });

    const blocker = db.transaction(() => {
      db.prepare('UPDATE worker_status SET last_error = ? WHERE worker_key = ?').run('lock', 'heartbeat-test');
    });
    // Hold a write transaction from a second connection so the fast-fail path
    // must return instead of synchronously sleeping through the retry budget.
    const Better = (await import('better-sqlite3')).default;
    const second = new Better(process.env.PILIPILI_DB_PATH!);
    second.exec('BEGIN IMMEDIATE');
    const started = Date.now();
    touchWorkerHeartbeat('heartbeat-test');
    assert.ok(Date.now() - started < 500, 'heartbeat lock contention must fail fast');
    second.exec('ROLLBACK');
    second.close();

    blocker();
    const row = db.prepare('SELECT last_heartbeat_at_ms FROM worker_status WHERE worker_key = ?').get('heartbeat-test') as { last_heartbeat_at_ms: number };
    assert.ok(row.last_heartbeat_at_ms > 0);
    console.log('worker heartbeat write tests: ok');
  } finally {
    if (previousDataDir === undefined) delete process.env.PILIPILI_DATA_DIR;
    else process.env.PILIPILI_DATA_DIR = previousDataDir;
    if (previousDbPath === undefined) delete process.env.PILIPILI_DB_PATH;
    else process.env.PILIPILI_DB_PATH = previousDbPath;
    rmSync(dataDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
