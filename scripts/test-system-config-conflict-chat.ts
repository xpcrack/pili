import assert from 'node:assert/strict';

import './server-only-shim.cjs';
import { readSystemConfig, saveSystemConfig } from '@/lib/server/systemConfigRepo';

function run() {
  const original = readSystemConfig();

  try {
    saveSystemConfig({ conflictNotificationTelegramChatId: '-100999888777' });

    const next = readSystemConfig();
    assert.equal(next.conflictNotificationTelegramChatId, '-100999888777');

    console.log('system config conflict chat tests: ok');
  } finally {
    saveSystemConfig({
      conflictNotificationTelegramChatId: original.conflictNotificationTelegramChatId,
    });
  }
}

run();
