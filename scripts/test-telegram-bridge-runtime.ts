import assert from 'node:assert/strict';

import {
  resetTelegramBridgeRuntimeStateForTests,
  runTelegramBridgeCycle,
} from '@/lib/server/telegramBridgeRuntime';

async function run() {
  const previousToken = process.env.tgbot_in_token;
  const previousAltToken = process.env.TELEGRAM_BRIDGE_BOT_TOKEN;

  try {
    delete process.env.tgbot_in_token;
    delete process.env.TELEGRAM_BRIDGE_BOT_TOKEN;
    resetTelegramBridgeRuntimeStateForTests();

    const result = await runTelegramBridgeCycle();

    assert.equal(result.status, 'missing-credentials');
    assert.match(result.lastError || '', /TELEGRAM_BRIDGE_BOT_TOKEN/i);
    assert.equal(result.detail.processedUpdateCount, 0);

    process.env.tgbot_in_token = 'test-bridge-token';
    resetTelegramBridgeRuntimeStateForTests();

    const conflictResult = await runTelegramBridgeCycle({
      bootstrap: async () => {},
      fetchUpdates: async () => {
        throw new Error(
          'Telegram getUpdates failed: 409 Conflict: terminated by other getUpdates request; make sure that only one bot instance is running'
        );
      },
    });

    assert.equal(conflictResult.status, 'idle');
    assert.match(conflictResult.lastError || '', /409 Conflict/i);
    assert.equal(conflictResult.detail.processedUpdateCount, 0);
  } finally {
    if (previousToken === undefined) {
      delete process.env.tgbot_in_token;
    } else {
      process.env.tgbot_in_token = previousToken;
    }

    if (previousAltToken === undefined) {
      delete process.env.TELEGRAM_BRIDGE_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BRIDGE_BOT_TOKEN = previousAltToken;
    }
  }

  console.log('telegram bridge runtime tests: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
