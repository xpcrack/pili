import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-conflict-repo-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const {
      enqueueConflictNotification,
      readPendingConflictNotifications,
      upsertConflictRecord,
    } = await import('@/lib/server/conflictRepo');

    const firstId = upsertConflictRecord({
      conflictKey: 'test:c1',
      domain: 'onchain',
      eventKey: 'test:event-1',
      winner: 'api',
      diffJson: [{ field: 'value', left: '1', right: '2' }],
    });
    const secondId = upsertConflictRecord({
      conflictKey: 'test:c1',
      domain: 'onchain',
      eventKey: 'test:event-1',
      winner: 'opencli',
      diffJson: [{ field: 'value', left: '1', right: '3' }],
    });
    assert.equal(firstId, secondId);

    enqueueConflictNotification(firstId, 'test:c1');
    enqueueConflictNotification(firstId, 'test:c1');

    const pending = readPendingConflictNotifications(10);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.conflictKey, 'test:c1');

    const pendingAfterClaim = readPendingConflictNotifications(10);
    assert.equal(pendingAfterClaim.length, 0);

    assert.throws(() => {
      enqueueConflictNotification(firstId, 'test:wrong-key');
    });

    console.log('conflict repo tests: ok');
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
