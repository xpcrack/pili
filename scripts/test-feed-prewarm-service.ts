import assert from 'node:assert/strict';

import './server-only-shim.cjs';
import { computePrewarmProgress, triggerStartupPrewarmIfNeeded } from '@/lib/server/feedPrewarmService';

function run() {
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const eightDaysMs = 8 * 24 * 60 * 60 * 1000;

  const running = computePrewarmProgress({
    now,
    targetBeginMs: now - sevenDaysMs,
    globalEarliestMs: now - 2 * 24 * 60 * 60 * 1000,
    usersTotal: 10,
    usersCovered: 3,
    running: true,
  });
  assert.equal(running.label, '补齐中 3/10 地址（近7天）');
  assert.equal(running.done, false);

  const done = computePrewarmProgress({
    now,
    targetBeginMs: now - sevenDaysMs,
    globalEarliestMs: now - eightDaysMs,
    usersTotal: 10,
    usersCovered: 10,
    running: false,
  });
  assert.equal(done.label, '近7天已补齐');
  assert.equal(done.done, true);

  const uncovered = computePrewarmProgress({
    now,
    targetBeginMs: now - sevenDaysMs,
    globalEarliestMs: now - eightDaysMs,
    usersTotal: 3,
    usersCovered: 2,
    running: false,
  });
  assert.equal(uncovered.done, false);
  assert.equal(uncovered.label, '补齐中 2/3 地址（近7天）');

  let called = 0;
  const alreadyRunning = triggerStartupPrewarmIfNeeded({
    now,
    getStatus: () => ({
      running: true,
      latestRun: { status: 'running' },
      windowState: { globalEarliestMs: null, perUserEarliestMs: {} },
    }),
    trigger: () => {
      called += 1;
      return { started: true, running: true, runId: 1, startedAt: now };
    },
  });
  assert.equal(alreadyRunning.started, false);
  assert.equal(alreadyRunning.reason, 'already-running');
  assert.equal(called, 0);

  const latestRunRunning = triggerStartupPrewarmIfNeeded({
    now,
    getStatus: () => ({
      running: false,
      latestRun: { status: 'running' },
      windowState: { globalEarliestMs: null, perUserEarliestMs: {} },
    }),
    trigger: () => {
      called += 1;
      return { started: true, running: true, runId: 2, startedAt: now };
    },
  });
  assert.equal(latestRunRunning.started, false);
  assert.equal(latestRunRunning.reason, 'already-running');
  assert.equal(called, 0);

  console.log('feed prewarm service tests: ok');
}

run();
