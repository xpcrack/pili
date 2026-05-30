import { runCompletenessMaintenanceWorkerCycle } from '@/lib/server/completenessMaintenanceWorkerRuntime';
import { runHoldingsRefreshCycle } from '@/lib/server/holdingsRefreshRuntime';
import { runTelegramBridgeCycle } from '@/lib/server/telegramBridgeRuntime';
import { runTelegramChannelWorkerCycle } from '@/lib/server/telegramChannelWorkerRuntime';
import type {
  DefaultRuntimeTaskOptions,
  LoopTaskOptions,
  RuntimeTaskRegistry,
  TaskDefinition,
  TaskStartContext,
  TaskStatusSnapshot,
} from './runtime-tasks/types';

export type {
  DefaultRuntimeTaskOptions,
  LoopTaskOptions,
  RuntimeTaskRegistry,
  TaskCycleResult,
  TaskDefinition,
  TaskStartContext,
  TaskStatusSnapshot,
} from './runtime-tasks/types';

function truncateError(error: unknown) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  return message.slice(0, 2000);
}

function createInitialStatus(key: string, label: string): TaskStatusSnapshot {
  return {
    key,
    label,
    enabled: true,
    running: false,
    pendingRun: false,
    runCount: 0,
    status: 'idle',
    lastReason: null,
    lastError: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    nextRunAt: null,
    detail: null,
  };
}

export function createLoopTask(options: LoopTaskOptions): TaskDefinition {
  const state = createInitialStatus(options.key, options.label);
  let started = false;
  let stopped = false;
  let draining = false;
  let activeController: AbortController | null = null;
  let activeRun: Promise<void> | null = null;
  let queuedRequests: Array<{
    reason: string;
    signal?: AbortSignal;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function abortActiveRun(signal?: string) {
    activeController?.abort(signal);
  }

  function swallowBackgroundFailure(context: string, error: unknown) {
    const message = truncateError(error);
    state.status = 'error';
    state.lastError = message;
    state.lastFinishedAt = Date.now();
    state.running = false;
    state.pendingRun = queuedRequests.length > 0;
    console.error(`[runtime-task:${options.key}] ${context}: ${message}`);
  }

  function scheduleNext(reason: string, sleepMs: number, signal?: AbortSignal) {
    clearTimer();
    state.nextRunAt = Date.now() + Math.max(0, Math.floor(sleepMs));
    timer = setTimeout(() => {
      timer = null;
      void enqueue(reason, signal).catch((error) => {
        swallowBackgroundFailure('scheduled run failed', error);
      });
    }, Math.max(0, Math.floor(sleepMs)));
    timer.unref?.();
  }

  function enqueue(reason: string, signal?: AbortSignal) {
    if (stopped) {
      return Promise.resolve();
    }

    started = true;
    state.pendingRun = true;

    return new Promise<void>((resolve, reject) => {
      queuedRequests.push({ reason, signal, resolve, reject });
      void drain();
    });
  }

  async function drain() {
    if (draining) {
      return;
    }

    draining = true;
    try {
      while (!stopped && queuedRequests.length > 0) {
        const request = queuedRequests.shift()!;
        state.running = true;
        state.pendingRun = queuedRequests.length > 0;
        state.lastReason = request.reason;
        state.lastStartedAt = Date.now();
        state.lastError = null;
        state.runCount += 1;
        activeController = new AbortController();
        activeRun = null;

        try {
          if (options.onStart) {
            await options.onStart({ reason: request.reason, signal: activeController.signal });
          }
          const resultPromise = options.cycle({ reason: request.reason, signal: activeController.signal });
          activeRun = resultPromise.then(
            () => undefined,
            () => undefined
          );
          const result = await resultPromise;
          state.status = result.status;
          state.detail = result.detail ?? null;
          state.lastFinishedAt = Date.now();
          if (options.autoStart !== false && !stopped && queuedRequests.length === 0) {
            scheduleNext(request.reason, result.sleepMs, request.signal);
          }
          request.resolve();
        } catch (error) {
          state.status = 'error';
          state.lastError = truncateError(error);
          state.lastFinishedAt = Date.now();
          request.reject(error);
        } finally {
          activeController = null;
          activeRun = null;
          state.running = false;
          state.pendingRun = queuedRequests.length > 0;
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    key: options.key,
    label: options.label,
    async start(context: TaskStartContext) {
      if (started && !stopped) {
        return;
      }
      stopped = false;
      state.enabled = true;
      if (options.autoStart !== false) {
        void enqueue(context.reason, context.signal).catch((error) => {
          swallowBackgroundFailure('startup run failed', error);
        });
      }
    },
    async stop(signal?: string) {
      stopped = true;
      state.enabled = false;
      state.pendingRun = false;
      clearTimer();
      abortActiveRun(signal);
      for (const request of queuedRequests) {
        request.reject(new Error(`task stopped: ${options.key}`));
      }
      queuedRequests = [];
      if (options.onStop) {
        await options.onStop(signal);
      }
      if (activeRun) {
        await activeRun.catch(() => undefined);
      }
    },
    async runNow(reason: string) {
      await enqueue(reason);
    },
    getStatus() {
      return {
        ...state,
      };
    },
  };
}

export function createTaskRegistry(tasks: TaskDefinition[]): RuntimeTaskRegistry {
  const taskMap = new Map(tasks.map((task) => [task.key, task] as const));

  return {
    async startAll() {
      for (const task of tasks) {
        await task.start({ reason: 'startup' });
      }
    },
    async stopAll(signal?: string) {
      for (const task of tasks) {
        await task.stop(signal);
      }
    },
    async runTaskNow(key: string, reason: string) {
      const task = taskMap.get(key);
      if (!task) {
        throw new Error(`unknown task: ${key}`);
      }
      await task.runNow(reason);
    },
    getTask(key: string) {
      return taskMap.get(key) || null;
    },
    listStatuses() {
      return tasks.map((task) => task.getStatus());
    },
  };
}

interface DefaultRuntimeTaskDeps {
  runTelegramChannelWorkerCycle?: typeof runTelegramChannelWorkerCycle;
  runCompletenessMaintenanceWorkerCycle?: typeof runCompletenessMaintenanceWorkerCycle;
  runHoldingsRefreshCycle?: typeof runHoldingsRefreshCycle;
  runTelegramBridgeCycle?: typeof runTelegramBridgeCycle;
}

export function resolveDefaultRuntimeTaskOptions(input: {
  mode: 'live' | 'prod';
  env?: Record<string, string | undefined>;
}): DefaultRuntimeTaskOptions {
  const env = input.env ?? process.env;
  const explicit = env.PILIPILI_EMBED_TELEGRAM_TASKS?.trim().toLowerCase();
  if (explicit === 'true') {
    return { embedTelegramTasks: true };
  }
  if (explicit === 'false') {
    return { embedTelegramTasks: false };
  }

  return {
    embedTelegramTasks: input.mode !== 'prod',
  };
}

export function createDefaultRuntimeTasks(
  deps: DefaultRuntimeTaskDeps = {},
  options: DefaultRuntimeTaskOptions = {}
) {
  const runTelegramChannelCycle = deps.runTelegramChannelWorkerCycle ?? runTelegramChannelWorkerCycle;
  const runCompletenessCycle =
    deps.runCompletenessMaintenanceWorkerCycle ?? runCompletenessMaintenanceWorkerCycle;
  const runHoldingsCycle = deps.runHoldingsRefreshCycle ?? runHoldingsRefreshCycle;
  const runTelegramBridgeCycleImpl = deps.runTelegramBridgeCycle ?? runTelegramBridgeCycle;

  const tasks: TaskDefinition[] = [];

  if (options.embedTelegramTasks !== false) {
    tasks.push(
      createLoopTask({
        key: 'telegram-channel-sync',
        label: 'Telegram Channel Sync',
        cycle: async () => {
          const result = await runTelegramChannelCycle();
          return {
            sleepMs: result.sleepMs,
            status: result.status,
            detail: {
              lastError: result.lastError,
            },
          };
        },
      })
    );
  }

  tasks.push(createLoopTask({
      key: 'completeness-maintenance',
      label: 'Completeness Maintenance',
      cycle: async () => {
        const result = await runCompletenessCycle();
        return {
          sleepMs: result.sleepMs,
          status: result.status,
          detail: {
            started: result.started,
            busy: result.busy,
            claimedPokeCount: result.claimedPokeCount,
            globalProvenStartMs: result.globalProvenStartMs,
          },
        };
      },
    }));
  tasks.push(createLoopTask({
      key: 'holdings-refresh',
      label: 'Holdings Refresh',
      cycle: async () => {
        const result = await runHoldingsCycle();
        return {
          sleepMs: result.sleepMs,
          status: result.status,
          detail: {
            lastError: result.lastError ?? null,
            ...result.summary,
          },
        };
      },
    }));

  if (options.embedTelegramTasks !== false) {
    tasks.push(
      createLoopTask({
        key: 'telegram-bridge',
        label: 'Telegram Bridge',
        cycle: async () => {
          const result = await runTelegramBridgeCycleImpl();
          return {
            sleepMs: result.sleepMs,
            status: result.status,
            detail: {
              lastError: result.lastError,
              ...result.detail,
            },
          };
        },
      })
    );
  }

  return tasks;
}
