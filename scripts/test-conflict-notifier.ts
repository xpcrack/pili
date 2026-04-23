import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-conflict-notifier-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const {
      markConflictNotificationRetry,
      markConflictNotificationSent,
      readPendingConflictNotifications,
      upsertConflictAndEnqueue,
    } = await import('@/lib/server/conflictRepo');
    const { getDb } = await import('@/lib/server/sqlite');
    const { readSystemConfig, saveSystemConfig } = await import('@/lib/server/systemConfigRepo');

    const db = getDb();
    const originalConfig = readSystemConfig();

    try {
      saveSystemConfig({
        conflictNotificationTelegramChatId: '-1001234567890',
      });

      upsertConflictAndEnqueue({
        conflictKey: 'notify:c1',
        domain: 'onchain',
        eventKey: 'notify:event-1',
        winner: 'api',
        diffJson: [{ field: 'token', left: 'AAA', right: 'BBB' }],
      });

      const pending = readPendingConflictNotifications(10);
      assert.equal(pending.length, 1);

      const first = pending[0];
      assert.ok(first);

      markConflictNotificationRetry(first.id, 'temporary failure', first.attemptCount + 1);

      const blockedByRetryWindow = readPendingConflictNotifications(10);
      assert.equal(blockedByRetryWindow.length, 0);

      db.prepare(
        `UPDATE feed_conflict_notifications
         SET status = 'pending',
             next_retry_at = 0,
             updated_at = ?
         WHERE id = ?`
      ).run(Date.now(), first.id);

      const pendingAfterUnlock = readPendingConflictNotifications(10);
      assert.equal(pendingAfterUnlock.length, 1);

      const second = pendingAfterUnlock[0];
      assert.ok(second);

      markConflictNotificationSent(second.id);

      const pendingAfterSent = readPendingConflictNotifications(10);
      assert.equal(pendingAfterSent.length, 0);

      console.log('conflict notifier tests: ok');
    } finally {
      saveSystemConfig({
        conflictNotificationTelegramChatId: originalConfig.conflictNotificationTelegramChatId,
      });
    }
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
