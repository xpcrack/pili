import type { LoopTaskOptions, TaskDefinition, TaskStatusSnapshot } from './types';

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
    async start(context) {
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
