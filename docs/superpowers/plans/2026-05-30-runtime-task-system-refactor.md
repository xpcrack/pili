# Runtime Task System Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the existing runtime task system into small, well-bounded modules while preserving current task behavior, production defaults, and runtime API compatibility.

**Architecture:** Keep the current in-process runtime task registry and move responsibilities out of the single `server/runtime-tasks.ts` file into `server/runtime-tasks/` modules. Preserve `@/server/runtime-tasks` as the public import path by turning `server/runtime-tasks.ts` into a compatibility re-export. Strengthen focused tests before and after the split so the refactor stays behavioral, not product-facing.

**Tech Stack:** TypeScript 5, Node 24.11.1, Bun runtime entrypoint, Hono runtime API, existing `tsx` test runner via `npm test -- --filter=runtime-task-registry`, Vite production build via `npm run build`.

---

## Scope Check

This plan implements one focused refactor from the approved spec:

- Source spec: `docs/superpowers/specs/2026-05-30-runtime-task-system-refactor-design.md`
- In scope: module boundaries, compatibility exports, focused tests, import cleanup.
- Out of scope: business worker rewrites, SQLite task history, UI, new infrastructure, production refresh behavior changes, default worker restarts.

The current workspace has unrelated or pre-existing dirty files. Before executing this plan, the worker must run `git status --short` and avoid modifying unrelated files unless they are part of this plan.

Important commit safety rule: if any file listed in a task is already dirty before that task starts, do not blindly run `git add <file>`. First inspect `git diff -- <file>` and separate pre-existing edits from task edits. If they cannot be separated cleanly with a non-interactive patch, report `NEEDS_CONTEXT` to the controller instead of committing unrelated work.

---

## File Structure

### Create

- `server/runtime-tasks/index.ts` — public module barrel for runtime task system exports.
- `server/runtime-tasks/types.ts` — shared runtime task interfaces and option types.
- `server/runtime-tasks/loopTask.ts` — `createLoopTask()` implementation and private loop state helpers.
- `server/runtime-tasks/registry.ts` — `createTaskRegistry()` implementation.
- `server/runtime-tasks/taskOptions.ts` — default runtime task option resolution from mode/env.
- `server/runtime-tasks/defaults.ts` — default business task adapters.

### Modify

- `server/runtime-tasks.ts` — replace implementation with compatibility re-export from `./runtime-tasks`.
- `scripts/test-runtime-task-registry.ts` — add behavior tests for compatibility exports, task ordering, env normalization, unknown task errors, and multi-task stop order.
- `server/runtime-context.ts` — only if TypeScript/module resolution requires import path cleanup; otherwise leave as-is.

### Do Not Modify

- `lib/server/completenessMaintenanceWorkerRuntime.ts`
- `lib/server/holdingsRefreshRuntime.ts`
- `lib/server/telegramBridgeRuntime.ts`
- `lib/server/telegramChannelWorkerRuntime.ts`
- `server/runtime-api.ts`
- `scripts/runtime-mode.ts`
- `pm2/ecosystem.config.cjs`

These files are runtime-adjacent but outside this refactor unless a compile error proves a minimal import adjustment is required.

---

## Pre-flight

- [ ] **Step 1: Confirm runtime docs/spec context**

Read:

```bash
sed -n '1,220p' AGENTS.md
sed -n '1,380p' docs/superpowers/specs/2026-05-30-runtime-task-system-refactor-design.md
```

Expected: `AGENTS.md` states production-only daily runtime rules, and the spec states that production defaults do not embed Telegram tasks.

- [ ] **Step 2: Capture dirty workspace state**

Run:

```bash
git status --short
```

Expected: note existing modified/untracked files. Do not revert them. Do not include unrelated files in commits for this plan.

If any of these planned files are already dirty, record that fact before editing:

```bash
git diff -- scripts/test-runtime-task-registry.ts server/runtime-tasks.ts server/runtime-context.ts
```

Expected: understand whether the dirty hunks are related to this refactor before staging or committing them.

- [ ] **Step 3: Read current runtime task implementation and tests**

Run:

```bash
sed -n '1,430p' server/runtime-tasks.ts
sed -n '1,430p' scripts/test-runtime-task-registry.ts
```

Expected: current implementation and focused tests are visible before editing.

---

## Task 1: Strengthen Runtime Task Behavior Tests

**Files:**
- Modify: `scripts/test-runtime-task-registry.ts`
- Reference: `server/runtime-tasks.ts`

- [ ] **Step 1: Add tests that describe the desired post-refactor behavior**

In `scripts/test-runtime-task-registry.ts`, add these test functions after `testDefaultRuntimeTaskOptionsFollowModeAndEnv()` and before `testRuntimeSnapshotIncludesProcessMemory()`:

```typescript
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

  assert.deepEqual(
    tasksWithoutTelegram.map((task) => task.key),
    ['completeness-maintenance', 'holdings-refresh']
  );
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
```

Then update `run()` to call the new tests immediately after `testDefaultRuntimeTaskOptionsFollowModeAndEnv()`:

```typescript
  await testDefaultRuntimeTaskOptionsNormalizeEnvValues();
  await testDefaultTaskOrderIsStable();
  await testRegistryUnknownTaskErrorIsStable();
  await testRegistryStopsTasksInRegistrationOrder();
```

- [ ] **Step 2: Run the focused runtime task tests before refactoring**

Run:

```bash
npm test -- --filter=runtime-task-registry
```

Expected: PASS with `runtime task registry tests: ok`.

- [ ] **Step 3: Commit the strengthened tests**

Run:

```bash
git add scripts/test-runtime-task-registry.ts
git commit -m "test(runtime): strengthen task registry contract"
```

Expected: commit succeeds and includes only `scripts/test-runtime-task-registry.ts`.

---

## Task 2: Extract Shared Runtime Task Types

**Files:**
- Create: `server/runtime-tasks/types.ts`
- Modify: `server/runtime-tasks.ts`
- Test: `scripts/test-runtime-task-registry.ts`

- [ ] **Step 1: Create `types.ts` with public interfaces**

Create `server/runtime-tasks/types.ts` with this content:

```typescript
export interface TaskCycleResult {
  sleepMs: number;
  status: string;
  detail?: Record<string, unknown> | null;
}

export interface TaskStartContext {
  reason: string;
  signal?: AbortSignal;
}

export interface TaskStatusSnapshot {
  key: string;
  label: string;
  enabled: boolean;
  running: boolean;
  pendingRun: boolean;
  runCount: number;
  status: string;
  lastReason: string | null;
  lastError: string | null;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  nextRunAt: number | null;
  detail: Record<string, unknown> | null;
}

export interface TaskDefinition {
  key: string;
  label: string;
  start(context: TaskStartContext): Promise<void>;
  stop(signal?: string): Promise<void>;
  runNow(reason: string): Promise<void>;
  getStatus(): TaskStatusSnapshot;
}

export interface RuntimeTaskRegistry {
  startAll(): Promise<void>;
  stopAll(signal?: string): Promise<void>;
  runTaskNow(key: string, reason: string): Promise<void>;
  getTask(key: string): TaskDefinition | null;
  listStatuses(): TaskStatusSnapshot[];
}

export interface LoopTaskOptions {
  key: string;
  label: string;
  autoStart?: boolean;
  cycle: (context: { reason: string; signal?: AbortSignal }) => Promise<TaskCycleResult>;
  onStart?: (context: TaskStartContext) => Promise<void> | void;
  onStop?: (signal?: string) => Promise<void> | void;
}

export interface DefaultRuntimeTaskOptions {
  embedTelegramTasks?: boolean;
}
```

- [ ] **Step 2: Import types into `server/runtime-tasks.ts`**

At the top of `server/runtime-tasks.ts`, add:

```typescript
import type {
  DefaultRuntimeTaskOptions,
  LoopTaskOptions,
  RuntimeTaskRegistry,
  TaskDefinition,
  TaskStartContext,
  TaskStatusSnapshot,
} from './runtime-tasks/types';
```

Then remove the local interface declarations for `TaskCycleResult`, `TaskStartContext`, `TaskStatusSnapshot`, `TaskDefinition`, `LoopTaskOptions`, `RuntimeTaskRegistry`, and `DefaultRuntimeTaskOptions` from `server/runtime-tasks.ts`.

At the bottom or near the imports in `server/runtime-tasks.ts`, export the public type names:

```typescript
export type {
  DefaultRuntimeTaskOptions,
  LoopTaskOptions,
  RuntimeTaskRegistry,
  TaskCycleResult,
  TaskDefinition,
  TaskStartContext,
  TaskStatusSnapshot,
} from './runtime-tasks/types';
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
npm test -- --filter=runtime-task-registry
```

Expected: PASS with `runtime task registry tests: ok`.

- [ ] **Step 4: Commit type extraction**

Run:

```bash
git add server/runtime-tasks.ts server/runtime-tasks/types.ts
git commit -m "refactor(runtime): extract task system types"
```

Expected: commit succeeds and includes only `server/runtime-tasks.ts` and `server/runtime-tasks/types.ts`.

---

## Task 3: Extract Loop Task Implementation

**Files:**
- Create: `server/runtime-tasks/loopTask.ts`
- Modify: `server/runtime-tasks.ts`
- Test: `scripts/test-runtime-task-registry.ts`

- [ ] **Step 1: Create `loopTask.ts`**

Create `server/runtime-tasks/loopTask.ts` with this content:

```typescript
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
```

- [ ] **Step 2: Remove loop implementation from `server/runtime-tasks.ts`**

In `server/runtime-tasks.ts`, remove `truncateError()`, `createInitialStatus()`, and the local `createLoopTask()` implementation.

Add this export near the type exports:

```typescript
export { createLoopTask } from './runtime-tasks/loopTask';
```

Add this import for internal default task creation:

```typescript
import { createLoopTask } from './runtime-tasks/loopTask';
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
npm test -- --filter=runtime-task-registry
```

Expected: PASS with `runtime task registry tests: ok`.

- [ ] **Step 4: Commit loop extraction**

Run:

```bash
git add server/runtime-tasks.ts server/runtime-tasks/loopTask.ts
git commit -m "refactor(runtime): extract loop task implementation"
```

Expected: commit succeeds and includes only `server/runtime-tasks.ts` and `server/runtime-tasks/loopTask.ts`.

---

## Task 4: Extract Registry Implementation

**Files:**
- Create: `server/runtime-tasks/registry.ts`
- Modify: `server/runtime-tasks.ts`
- Test: `scripts/test-runtime-task-registry.ts`

- [ ] **Step 1: Create `registry.ts`**

Create `server/runtime-tasks/registry.ts` with this content:

```typescript
import type { RuntimeTaskRegistry, TaskDefinition } from './types';

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
```

- [ ] **Step 2: Remove registry implementation from `server/runtime-tasks.ts`**

In `server/runtime-tasks.ts`, remove the local `createTaskRegistry()` implementation.

Add this export:

```typescript
export { createTaskRegistry } from './runtime-tasks/registry';
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
npm test -- --filter=runtime-task-registry
```

Expected: PASS with `runtime task registry tests: ok`.

- [ ] **Step 4: Commit registry extraction**

Run:

```bash
git add server/runtime-tasks.ts server/runtime-tasks/registry.ts
git commit -m "refactor(runtime): extract task registry"
```

Expected: commit succeeds and includes only `server/runtime-tasks.ts` and `server/runtime-tasks/registry.ts`.

---

## Task 5: Extract Default Task Options and Business Task Adapters

**Files:**
- Create: `server/runtime-tasks/taskOptions.ts`
- Create: `server/runtime-tasks/defaults.ts`
- Modify: `server/runtime-tasks.ts`
- Test: `scripts/test-runtime-task-registry.ts`

- [ ] **Step 1: Create `taskOptions.ts`**

Create `server/runtime-tasks/taskOptions.ts` with this content:

```typescript
import type { DefaultRuntimeTaskOptions } from './types';

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
```

- [ ] **Step 2: Create `defaults.ts`**

Create `server/runtime-tasks/defaults.ts` with this content:

```typescript
import { runCompletenessMaintenanceWorkerCycle } from '@/lib/server/completenessMaintenanceWorkerRuntime';
import { runHoldingsRefreshCycle } from '@/lib/server/holdingsRefreshRuntime';
import { runTelegramBridgeCycle } from '@/lib/server/telegramBridgeRuntime';
import { runTelegramChannelWorkerCycle } from '@/lib/server/telegramChannelWorkerRuntime';

import { createLoopTask } from './loopTask';
import type { DefaultRuntimeTaskOptions, TaskDefinition } from './types';

interface DefaultRuntimeTaskDeps {
  runTelegramChannelWorkerCycle?: typeof runTelegramChannelWorkerCycle;
  runCompletenessMaintenanceWorkerCycle?: typeof runCompletenessMaintenanceWorkerCycle;
  runHoldingsRefreshCycle?: typeof runHoldingsRefreshCycle;
  runTelegramBridgeCycle?: typeof runTelegramBridgeCycle;
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

  tasks.push(
    createLoopTask({
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
    })
  );
  tasks.push(
    createLoopTask({
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
    })
  );

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
```

- [ ] **Step 3: Replace remaining implementation in `server/runtime-tasks.ts` with exports**

Replace the contents of `server/runtime-tasks.ts` with:

```typescript
export { createDefaultRuntimeTasks } from './runtime-tasks/defaults';
export { createLoopTask } from './runtime-tasks/loopTask';
export { createTaskRegistry } from './runtime-tasks/registry';
export { resolveDefaultRuntimeTaskOptions } from './runtime-tasks/taskOptions';
export type {
  DefaultRuntimeTaskOptions,
  LoopTaskOptions,
  RuntimeTaskRegistry,
  TaskCycleResult,
  TaskDefinition,
  TaskStartContext,
  TaskStatusSnapshot,
} from './runtime-tasks/types';
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm test -- --filter=runtime-task-registry
```

Expected: PASS with `runtime task registry tests: ok`.

- [ ] **Step 5: Commit default task extraction**

Run:

```bash
git add server/runtime-tasks.ts server/runtime-tasks/taskOptions.ts server/runtime-tasks/defaults.ts
git commit -m "refactor(runtime): extract default task adapters"
```

Expected: commit succeeds and includes only the three listed files.

---

## Task 6: Add Module Barrel and Verify Public Imports

**Files:**
- Create: `server/runtime-tasks/index.ts`
- Modify: `server/runtime-tasks.ts`
- Modify: `scripts/test-runtime-task-registry.ts`
- Test: `scripts/test-runtime-task-registry.ts`

- [ ] **Step 1: Create `index.ts`**

Create `server/runtime-tasks/index.ts` with this content:

```typescript
export { createDefaultRuntimeTasks } from './defaults';
export { createLoopTask } from './loopTask';
export { createTaskRegistry } from './registry';
export { resolveDefaultRuntimeTaskOptions } from './taskOptions';
export type {
  DefaultRuntimeTaskOptions,
  LoopTaskOptions,
  RuntimeTaskRegistry,
  TaskCycleResult,
  TaskDefinition,
  TaskStartContext,
  TaskStatusSnapshot,
} from './types';
```

- [ ] **Step 2: Point compatibility file at the barrel**

Replace the contents of `server/runtime-tasks.ts` with:

```typescript
export * from './runtime-tasks';
```

- [ ] **Step 3: Add compatibility import test**

At the top of `scripts/test-runtime-task-registry.ts`, keep the existing import from `@/server/runtime-tasks` unchanged.

Add this test function before `run()`:

```typescript
async function testCompatibilityImportPathExportsRuntimeTaskApi() {
  assert.equal(typeof createLoopTask, 'function');
  assert.equal(typeof createTaskRegistry, 'function');
  assert.equal(typeof createDefaultRuntimeTasks, 'function');
  assert.equal(typeof resolveDefaultRuntimeTaskOptions, 'function');
}
```

Update `run()` to call it first:

```typescript
  await testCompatibilityImportPathExportsRuntimeTaskApi();
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm test -- --filter=runtime-task-registry
```

Expected: PASS with `runtime task registry tests: ok`.

- [ ] **Step 5: Run TypeScript check for import compatibility**

Run:

```bash
npx tsc --noEmit
```

Expected: PASS with exit code 0.

- [ ] **Step 6: Commit barrel and compatibility re-export**

Run:

```bash
git add server/runtime-tasks.ts server/runtime-tasks/index.ts scripts/test-runtime-task-registry.ts
git commit -m "refactor(runtime): add task module barrel"
```

Expected: commit succeeds and includes only the listed files.

---

## Task 7: Final Runtime Verification

**Files:**
- Verify only unless failures require scoped fixes.

- [ ] **Step 1: Run focused runtime task tests**

Run:

```bash
npm test -- --filter=runtime-task-registry
```

Expected: PASS with `runtime task registry tests: ok`.

- [ ] **Step 2: Run runtime mode contract tests**

Run:

```bash
npm run test:runtime-mode
```

Expected: PASS with `runtime mode tests: ok`.

- [ ] **Step 3: Run production build**

Run:

```bash
npm run build
```

Expected: PASS with exit code 0.

- [ ] **Step 4: Inspect final diff and status**

Run:

```bash
git status --short
git log --oneline -8
```

Expected: only unrelated pre-existing dirty files remain outside this refactor; recent commits show this plan's focused test/refactor commits.

- [ ] **Step 5: Write final implementation notes**

Record in the final response:

```text
- Files created under server/runtime-tasks/.
- server/runtime-tasks.ts now remains the compatibility import path.
- Focused runtime task tests passed.
- runtime mode tests passed.
- build passed.
- Any unrelated dirty files were left untouched.
```

Do not claim full `npm test` passed unless it was run fresh and succeeded.

---

## Subagent Execution Notes

Recommended controller command shape for each task if using Codex CLI as the subagent runner:

```bash
codex exec \
  --model gpt-5.3-codex \
  --cd /Users/xp/vibecoding/pilipili \
  --sandbox danger-full-access \
  --ask-for-approval never \
  "Execute Task N from docs/superpowers/plans/2026-05-30-runtime-task-system-refactor.md exactly. Do not modify unrelated dirty files. Commit only the files listed for the task. Report DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, or BLOCKED."
```

If `gpt-5.3-codex` is unavailable, stop and report the model error before retrying with another model.

After each subagent task, the controller must run:

```bash
git show --stat --oneline --no-renames HEAD
npm test -- --filter=runtime-task-registry
```

Then perform spec compliance review before code quality review.
