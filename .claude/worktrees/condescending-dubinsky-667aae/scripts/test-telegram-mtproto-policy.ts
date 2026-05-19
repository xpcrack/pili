import assert from 'node:assert/strict';

import { classifyTelegramMtprotoError } from '../lib/server/telegramMtprotoPolicy';

function run() {
  const duplicatedAuthKey = classifyTelegramMtprotoError(
    new Error('406: AUTH_KEY_DUPLICATED (caused by InvokeWithLayer)')
  );
  assert.equal(duplicatedAuthKey.kind, 'auth_required');
  assert.equal(duplicatedAuthKey.waitMs, null);

  const floodWait = classifyTelegramMtprotoError(new Error('FLOOD_WAIT_12'));
  assert.equal(floodWait.kind, 'flood_wait');
  assert.equal(floodWait.waitMs, 12_000);

  console.log('telegram mtproto policy tests: ok');
}

run();
