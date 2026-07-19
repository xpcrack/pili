import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-sqlite-init-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { getDb } = await import(`../lib/server/sqlite.ts?init-guard=${stamp}`);
    const db = getDb();

    const triggerRows = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND name IN ('events_ai', 'events_ad', 'events_au')
         ORDER BY name`
      )
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      triggerRows.map((r) => r.name),
      ['events_ad', 'events_ai', 'events_au']
    );

    const flag = db
      .prepare(`SELECT value_json FROM app_state WHERE key = ?`)
      .get('events_fts_triggers_v3') as { value_json: string } | undefined;
    assert.ok(flag, 'events_fts_triggers_v3 flag should be set after init');
    const parsed = JSON.parse(flag!.value_json) as { done?: boolean };
    assert.equal(parsed.done, true);

    // Second getDb in same process is a no-op path (singleton)
    const again = getDb();
    assert.equal(again, db);

    // Simulating another process: open a second module instance against same file.
    // Triggers already present + flag set => ensureEventsFtsIndexing must not
    // require DROP TRIGGER. Just verify open succeeds and flag stays.
    const stamp2 = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Reset module-level singleton by importing with a new query; env still points
    // at the same file. This only works because each import gets its own module
    // graph in Node for unique query strings under tsx.
    const { getDb: getDb2 } = await import(`../lib/server/sqlite.ts?init-guard=${stamp2}`);
    const db2 = getDb2();
    const flag2 = db2
      .prepare(`SELECT value_json FROM app_state WHERE key = ?`)
      .get('events_fts_triggers_v3') as { value_json: string } | undefined;
    assert.ok(flag2);
    assert.equal(JSON.parse(flag2!.value_json).done, true);

    console.log('OK sqlite-init-guard');
  } finally {
    if (previousDbPath === undefined) delete process.env.PILIPILI_DB_PATH;
    else process.env.PILIPILI_DB_PATH = previousDbPath;
    if (previousDataDir === undefined) delete process.env.PILIPILI_DATA_DIR;
    else process.env.PILIPILI_DATA_DIR = previousDataDir;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
