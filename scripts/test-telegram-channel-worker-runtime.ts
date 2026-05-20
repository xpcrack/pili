import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import './server-only-shim.cjs';

import { readTelegramMtprotoPolicy } from '../lib/server/telegramMtprotoPolicy';

function withEnv(env: Record<string, string>, run: () => void) {
  const prev = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    prev.set(key, process.env[key]);
    process.env[key] = env[key];
  }

  try {
    run();
  } finally {
    for (const [key, value] of prev.entries()) {
      if (typeof value === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function run() {
  withEnv(
    {
      TELEGRAM_CHANNEL_WORKER_MAX_CYCLES_BEFORE_RESTART: '240',
      TELEGRAM_CHANNEL_WORKER_MAX_IDLE_MS_BEFORE_RESTART: '1800000',
    },
    () => {
      const policy = readTelegramMtprotoPolicy();
      assert.equal(policy.channelWorkerMaxCyclesBeforeRestart, 240);
      assert.equal(policy.channelWorkerMaxIdleMsBeforeRestart, 1_800_000);
    }
  );

  withEnv(
    {
      TELEGRAM_CHANNEL_WORKER_MAX_CYCLES_BEFORE_RESTART: '0',
      TELEGRAM_CHANNEL_WORKER_MAX_IDLE_MS_BEFORE_RESTART: '-5',
    },
    () => {
      const policy = readTelegramMtprotoPolicy();
      assert.equal(policy.channelWorkerMaxCyclesBeforeRestart, 120);
      assert.equal(policy.channelWorkerMaxIdleMsBeforeRestart, 30 * 60_000);
    }
  );

  const workerScript = readFileSync(join(process.cwd(), 'scripts', 'telegram-channel-worker.ts'), 'utf8');
  assert.match(
    workerScript,
    /channelWorkerMaxCyclesBeforeRestart/,
    'worker should reference cycle guardrail policy field'
  );
  assert.match(
    workerScript,
    /channelWorkerMaxIdleMsBeforeRestart/,
    'worker should reference idle guardrail policy field'
  );
  assert.match(
    workerScript,
    /process\.exit\(0\)/,
    'worker should exit gracefully for pm2 self-rotation'
  );
  assert.match(
    workerScript,
    /restart reason=(cycle-limit|idle-limit)/,
    'worker should emit explicit restart reason in logs'
  );

  console.log('telegram channel worker runtime tests: ok');
}

run();
