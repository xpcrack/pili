import assert from 'node:assert/strict';

import './server-only-shim.cjs';
import { readSystemConfig, saveSystemConfig } from '@/lib/server/systemConfigRepo';

function run() {
  const original = readSystemConfig();

  try {
    saveSystemConfig({ conflictNotificationTelegramChatId: '-100999888777' });

    const next = readSystemConfig();
    assert.equal(next.conflictNotificationTelegramChatId, '-100999888777');

    saveSystemConfig({
      twitterRelayCoveredPollingIntervalMinutes: 720,
      twitterUncoveredPollingIntervalMinutes: 15,
    });
    const twitterIntervals = readSystemConfig();
    assert.equal(twitterIntervals.twitterRelayCoveredPollingIntervalMinutes, 720);
    assert.equal(twitterIntervals.twitterUncoveredPollingIntervalMinutes, 15);

    saveSystemConfig({
      twitterRelayCoveredPollingIntervalMinutes: 0,
      twitterUncoveredPollingIntervalMinutes: 60 * 24 * 99,
    });
    const normalizedIntervals = readSystemConfig();
    assert.equal(normalizedIntervals.twitterRelayCoveredPollingIntervalMinutes, 1);
    assert.equal(normalizedIntervals.twitterUncoveredPollingIntervalMinutes, 60 * 24 * 7);

    console.log('system config conflict chat tests: ok');
  } finally {
    saveSystemConfig(original);
  }
}

run();
