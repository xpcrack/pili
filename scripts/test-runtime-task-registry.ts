import assert from 'node:assert/strict';

import {
  createDefaultRuntimeTasks,
  createLoopTask,
  createTaskRegistry,
  resolveDefaultRuntimeTaskOptions,
  type TaskDefinition,
} from '@/server/runtime-tasks';

function requireCallback(value: (() => void) | null) {
  assert.ok(value, 'expected callback to be assigned');
  return value;
}

async function testTaskRunNowAndStatusSnapshot() {
  let cycleCount = 0;

  const task = createLoopTask({
    key: 'test-loop',
    label: 'Test Loop',
    cycle: async () => {
      cycleCount += 1;
      return {
        sleepMs: 60_000,
        status: 'idle',
        detail: {
          cycleCount,
        },
      };
    },
    autoStart: false,
  });

  const beforeRun = task.getStatus();
  assert.equal(beforeRun.key, 'test-loop');
  assert.equal(beforeRun.running, false);
  assert.equal(beforeRun.runCount, 0);

  await task.runNow('manual-test');

  const afterRun = task.getStatus();
  assert.equal(cycleCount, 1);
  assert.equal(afterRun.running, false);
  assert.equal(afterRun.runCount, 1);
  assert.equal(afterRun.lastReason, 'manual-test');
  assert.equal(afterRun.lastError, null);
  assert.equal(afterRun.status, 'idle');
  assert.deepEqual(afterRun.detail, { cycleCount: 1 });
  assert.equal(typeof afterRun.lastStartedAt, 'number');
  assert.equal(typeof afterRun.lastFinishedAt, 'number');
}

async function testTaskSingleFlightQueuesOneExtraRun() {
  let resolveCycle: (() => void) | null = null;
  let cycleCount = 0;

  const task = createLoopTask({
    key: 'single-flight',
    label: 'Single Flight',
    cycle: async () => {
      cycleCount += 1;
      await new Promise<void>((resolve) => {
        resolveCycle = resolve;
      });
      return {
        sleepMs: 60_000,
        status: 'idle',
      };
    },
    autoStart: false,
  });

  const firstRun = task.runNow('first');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const secondRun = task.runNow('second');
  const whileRunning = task.getStatus();
  assert.equal(whileRunning.running, true);
  assert.equal(whileRunning.pendingRun, true);

  const releaseFirstCycle = requireCallback(resolveCycle);
  releaseFirstCycle();
  await firstRun;

  const releaseSecondCycle = requireCallback(resolveCycle);
  releaseSecondCycle();
  await secondRun;

  const afterRuns = task.getStatus();
  assert.equal(cycleCount, 2);
  assert.equal(afterRuns.running, false);
  assert.equal(afterRuns.runCount, 2);
  assert.equal(afterRuns.pendingRun, false);
  assert.equal(afterRuns.lastReason, 'second');
}

async function testRegistryControlsTasks() {
  const stops: string[] = [];
  const tasks: TaskDefinition[] = [
    createLoopTask({
      key: 'alpha',
      label: 'Alpha',
      cycle: async () => ({ sleepMs: 60_000, status: 'idle' }),
      autoStart: false,
      onStop: (signal) => {
        stops.push(signal || 'none');
      },
    }),
  ];

  const registry = createTaskRegistry(tasks);
  await registry.startAll();
  assert.equal(registry.listStatuses().length, 1);
  assert.equal(registry.getTask('alpha')?.getStatus().enabled, true);

  await registry.runTaskNow('alpha', 'registry-test');
  assert.equal(registry.getTask('alpha')?.getStatus().runCount, 1);

  await registry.stopAll('shutdown');
  assert.deepEqual(stops, ['shutdown']);
}

async function testTaskStopWaitsForActiveCycleShutdown() {
  let releaseCycle: (() => void) | null = null;
  let observedSignal: AbortSignal | undefined;

  const task = createLoopTask({
    key: 'stoppable',
    label: 'Stoppable',
    autoStart: false,
    cycle: async ({ signal }) => {
      observedSignal = signal;
      await new Promise<void>((resolve) => {
        releaseCycle = resolve;
      });
      return {
        sleepMs: 60_000,
        status: signal?.aborted ? 'stopped' : 'idle',
      };
    },
  });

  const runPromise = task.runNow('long-run');
  await new Promise((resolve) => setTimeout(resolve, 0));

  let stopResolved = false;
  const stopPromise = task.stop('shutdown').then(() => {
    stopResolved = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stopResolved, false, 'stop should wait for the active cycle to finish');
  assert.equal(observedSignal?.aborted, true, 'stop should abort the active cycle signal');

  const finishCycle = requireCallback(releaseCycle);
  finishCycle();

  await stopPromise;
  await runPromise;

  const afterStop = task.getStatus();
  assert.equal(afterStop.enabled, false);
  assert.equal(afterStop.running, false);
  assert.equal(afterStop.status, 'stopped');
}

async function testDefaultTasksIncludeHoldingsRefresh() {
  let holdingsCycleCount = 0;
  let bridgeCycleCount = 0;
  const tasks = createDefaultRuntimeTasks({
    runTelegramChannelWorkerCycle: async () => ({
      sleepMs: 60_000,
      status: 'idle',
      lastError: null,
    }),
    runCompletenessMaintenanceWorkerCycle: async () => ({
      sleepMs: 60_000,
      status: 'idle',
      started: true,
      busy: false,
      claimedPokeCount: 0,
      globalProvenStartMs: null,
      sourceResults: [],
    }),
    runHoldingsRefreshCycle: async () => {
      holdingsCycleCount += 1;
      return {
        sleepMs: 120_000,
        status: 'idle',
        lastError: null,
        summary: {
          trackedAddressCount: 4,
          uniqueTrackedAddressCount: 3,
          refreshedWalletCount: 3,
          failedWalletCount: 0,
          holdingsRowCount: 12,
          filteredOutHoldingCount: 1,
          refreshedAtMs: 123_456,
        },
      };
    },
    runTelegramBridgeCycle: async () => {
      bridgeCycleCount += 1;
      return {
        sleepMs: 15_000,
        status: 'idle',
        lastError: null,
        detail: {
          processedUpdateCount: 2,
          lastUpdateId: 456,
        },
      };
    },
  });

  const registry = createTaskRegistry(tasks);
  const holdingsTask = registry.getTask('holdings-refresh');
  const bridgeTask = registry.getTask('telegram-bridge');

  assert.ok(holdingsTask, 'default runtime tasks should include holdings-refresh');
  assert.ok(bridgeTask, 'default runtime tasks should include telegram-bridge');
  await holdingsTask.runNow('manual-holdings-test');
  await bridgeTask.runNow('manual-bridge-test');

  const afterRun = holdingsTask.getStatus();
  const afterBridgeRun = bridgeTask.getStatus();
  assert.equal(holdingsCycleCount, 1);
  assert.equal(bridgeCycleCount, 1);
  assert.equal(afterRun.status, 'idle');
  assert.equal(afterRun.lastReason, 'manual-holdings-test');
  assert.deepEqual(afterRun.detail, {
    lastError: null,
    trackedAddressCount: 4,
    uniqueTrackedAddressCount: 3,
    refreshedWalletCount: 3,
    failedWalletCount: 0,
    holdingsRowCount: 12,
    filteredOutHoldingCount: 1,
    refreshedAtMs: 123_456,
  });
  assert.equal(afterBridgeRun.status, 'idle');
  assert.equal(afterBridgeRun.lastReason, 'manual-bridge-test');
  assert.deepEqual(afterBridgeRun.detail, {
    lastError: null,
    processedUpdateCount: 2,
    lastUpdateId: 456,
  });
}

async function testDefaultTasksCanExcludeEmbeddedTelegramLoops() {
  const tasks = createDefaultRuntimeTasks(
    {
      runTelegramChannelWorkerCycle: async () => ({
        sleepMs: 60_000,
        status: 'idle',
        lastError: null,
      }),
      runCompletenessMaintenanceWorkerCycle: async () => ({
        sleepMs: 60_000,
        status: 'idle',
        started: true,
        busy: false,
        claimedPokeCount: 0,
        globalProvenStartMs: null,
        sourceResults: [],
      }),
      runHoldingsRefreshCycle: async () => ({
        sleepMs: 120_000,
        status: 'idle',
        lastError: null,
        summary: {
          trackedAddressCount: 1,
          uniqueTrackedAddressCount: 1,
          refreshedWalletCount: 1,
          failedWalletCount: 0,
          holdingsRowCount: 1,
          filteredOutHoldingCount: 0,
          refreshedAtMs: 123,
        },
      }),
      runTelegramBridgeCycle: async () => ({
        sleepMs: 15_000,
        status: 'idle',
        lastError: null,
        detail: {
          processedUpdateCount: 0,
          lastUpdateId: 0,
        },
      }),
    },
    {
      embedTelegramTasks: false,
    }
  );

  const registry = createTaskRegistry(tasks);
  assert.ok(registry.getTask('holdings-refresh'), 'holdings refresh should still be embedded');
  assert.ok(registry.getTask('completeness-maintenance'), 'completeness maintenance should still be embedded');
  assert.equal(registry.getTask('telegram-channel-sync'), null);
  assert.equal(registry.getTask('telegram-bridge'), null);
}

async function testDefaultRuntimeTaskOptionsFollowModeAndEnv() {
  assert.deepEqual(resolveDefaultRuntimeTaskOptions({ mode: 'prod', env: {} }), {
    embedTelegramTasks: false,
  });
  assert.deepEqual(resolveDefaultRuntimeTaskOptions({ mode: 'live', env: {} }), {
    embedTelegramTasks: true,
  });
  assert.deepEqual(
    resolveDefaultRuntimeTaskOptions({
      mode: 'prod',
      env: { PILIPILI_EMBED_TELEGRAM_TASKS: 'true' },
    }),
    {
      embedTelegramTasks: true,
    }
  );
  assert.deepEqual(
    resolveDefaultRuntimeTaskOptions({
      mode: 'live',
      env: { PILIPILI_EMBED_TELEGRAM_TASKS: 'false' },
    }),
    {
      embedTelegramTasks: false,
    }
  );
}

async function testDefaultRuntimeTaskOptionsNormalizeEnvValues() {
  assert.deepEqual(
    resolveDefaultRuntimeTaskOptions({
      mode: 'prod',
      env: { PILIPILI_EMBED_TELEGRAM_TASKS: ' TRUE ' },
    }),
    {
      embedTelegramTasks: true,
    }
  );
  assert.deepEqual(
    resolveDefaultRuntimeTaskOptions({
      mode: 'live',
      env: { PILIPILI_EMBED_TELEGRAM_TASKS: ' False ' },
    }),
    {
      embedTelegramTasks: false,
    }
  );
  assert.deepEqual(
    resolveDefaultRuntimeTaskOptions({
      mode: 'prod',
      env: { PILIPILI_EMBED_TELEGRAM_TASKS: ' yes ' },
    }),
    {
      embedTelegramTasks: false,
    }
  );
}

async function testDefaultTaskOrderIsStable() {
  const tasksWithTelegram = createDefaultRuntimeTasks({
    runTelegramChannelWorkerCycle: async () => ({
      sleepMs: 60_000,
      status: 'idle',
      lastError: null,
    }),
    runCompletenessMaintenanceWorkerCycle: async () => ({
      sleepMs: 60_000,
      status: 'idle',
      started: true,
      busy: false,
      claimedPokeCount: 0,
      globalProvenStartMs: null,
      sourceResults: [],
    }),
    runHoldingsRefreshCycle: async () => ({
      sleepMs: 120_000,
      status: 'idle',
      lastError: null,
      summary: {
        trackedAddressCount: 1,
        uniqueTrackedAddressCount: 1,
        refreshedWalletCount: 1,
        failedWalletCount: 0,
        holdingsRowCount: 1,
        filteredOutHoldingCount: 0,
        refreshedAtMs: 123,
      },
    }),
    runTelegramBridgeCycle: async () => ({
      sleepMs: 15_000,
      status: 'idle',
      lastError: null,
      detail: {
        processedUpdateCount: 0,
        lastUpdateId: 0,
      },
    }),
  });

  assert.deepEqual(
    tasksWithTelegram.map((task) => task.key),
    ['telegram-channel-sync', 'completeness-maintenance', 'holdings-refresh', 'telegram-bridge']
  );

  const tasksWithoutTelegram = createDefaultRuntimeTasks(
    {
      runTelegramChannelWorkerCycle: async () => ({
        sleepMs: 60_000,
        status: 'idle',
        lastError: null,
      }),
      runCompletenessMaintenanceWorkerCycle: async () => ({
        sleepMs: 60_000,
        status: 'idle',
        started: true,
        busy: false,
        claimedPokeCount: 0,
        globalProvenStartMs: null,
        sourceResults: [],
      }),
      runHoldingsRefreshCycle: async () => ({
        sleepMs: 120_000,
        status: 'idle',
        lastError: null,
        summary: {
          trackedAddressCount: 1,
          uniqueTrackedAddressCount: 1,
          refreshedWalletCount: 1,
          failedWalletCount: 0,
          holdingsRowCount: 1,
          filteredOutHoldingCount: 0,
          refreshedAtMs: 123,
        },
      }),
      runTelegramBridgeCycle: async () => ({
        sleepMs: 15_000,
        status: 'idle',
        lastError: null,
        detail: {
          processedUpdateCount: 0,
          lastUpdateId: 0,
        },
      }),
    },
    {
      embedTelegramTasks: false,
    }
  );

  assert.deepEqual(tasksWithoutTelegram.map((task) => task.key), ['completeness-maintenance', 'holdings-refresh']);
}

async function testRegistryUnknownTaskErrorIsStable() {
  const registry = createTaskRegistry([]);
  await assert.rejects(() => registry.runTaskNow('missing-task', 'manual-test'), /unknown task: missing-task/);
  assert.equal(registry.getTask('missing-task'), null);
}

async function testRegistryStopsTasksInRegistrationOrder() {
  const stops: string[] = [];
  const registry = createTaskRegistry([
    createLoopTask({
      key: 'first',
      label: 'First',
      autoStart: false,
      cycle: async () => ({ sleepMs: 60_000, status: 'idle' }),
      onStop: (signal) => {
        stops.push(`first:${signal || 'none'}`);
      },
    }),
    createLoopTask({
      key: 'second',
      label: 'Second',
      autoStart: false,
      cycle: async () => ({ sleepMs: 60_000, status: 'idle' }),
      onStop: (signal) => {
        stops.push(`second:${signal || 'none'}`);
      },
    }),
  ]);

  await registry.stopAll('shutdown');
  assert.deepEqual(stops, ['first:shutdown', 'second:shutdown']);
}

async function testAutoStartFailureDoesNotLeakUnhandledRejection() {
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (error: unknown) => {
    unhandled.push(error);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const task = createLoopTask({
      key: 'failing-auto-start',
      label: 'Failing Auto Start',
      cycle: async () => {
        throw new Error('boom');
      },
    });

    await task.start({ reason: 'startup' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const status = task.getStatus();
    assert.equal(status.status, 'error');
    assert.equal(status.lastReason, 'startup');
    assert.match(status.lastError || '', /boom/);
    assert.deepEqual(unhandled, []);

    await task.stop('shutdown');
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
}

async function testCompatibilityImportPathExportsRuntimeTaskApi() {
  assert.equal(typeof createLoopTask, 'function');
  assert.equal(typeof createTaskRegistry, 'function');
  assert.equal(typeof createDefaultRuntimeTasks, 'function');
  assert.equal(typeof resolveDefaultRuntimeTaskOptions, 'function');
}

async function run() {
  await testCompatibilityImportPathExportsRuntimeTaskApi();
  await testTaskRunNowAndStatusSnapshot();
  await testTaskSingleFlightQueuesOneExtraRun();
  await testRegistryControlsTasks();
  await testTaskStopWaitsForActiveCycleShutdown();
  await testDefaultTasksIncludeHoldingsRefresh();
  await testDefaultTasksCanExcludeEmbeddedTelegramLoops();
  await testDefaultRuntimeTaskOptionsFollowModeAndEnv();
  await testDefaultRuntimeTaskOptionsNormalizeEnvValues();
  await testDefaultTaskOrderIsStable();
  await testRegistryUnknownTaskErrorIsStable();
  await testRegistryStopsTasksInRegistrationOrder();
  await testAutoStartFailureDoesNotLeakUnhandledRejection();
  console.log('runtime task registry tests: ok');
}

const keepAlive = setInterval(() => {}, 1_000);

run()
  .then(() => {
    clearInterval(keepAlive);
  })
  .catch((error) => {
    clearInterval(keepAlive);
    console.error(error);
    process.exitCode = 1;
  });
