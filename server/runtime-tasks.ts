import { syncFeishuEnablementFromNewone } from '@/lib/server/feishuEnablementSync';
import { syncTwitterFromGmgnForUnfilledUsers } from '@/lib/server/gmgnTwitterSync';
import { runCompletenessMaintenanceWorkerCycle } from '@/lib/server/completenessMaintenanceWorkerRuntime';
import {
  runGmgnHoldingsRefreshQueueCycle,
  runNativeHoldingsRefreshQueueCycle,
} from '@/lib/server/holdingsRefreshQueue';
import { runHolderSnapshotCycle } from '@/lib/server/holderSnapshotRuntime';
import { runLiveMonitorCycle } from '@/lib/server/liveMonitorRuntime';
import { runPositionDeltaCycle } from '@/lib/server/positionDeltaService';
import { runTradeSignalCycle } from '@/lib/server/tradeSignalService';
import { runWalletPnlCycle } from '@/lib/server/walletPnlService';
import { runTwitterIdentityBackfillCycle } from '@/lib/server/twitterIdentityBackfillRuntime';
import { runTelegramBridgeCycle } from '@/lib/server/telegramBridgeRuntime';
import { runTelegramChannelWorkerCycle } from '@/lib/server/telegramChannelWorkerRuntime';

// --- types ---

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
  /**
   * Wallet PnL walks the full trade history synchronously. It must never run in
   * a process that also serves HTTP — position-delta already showed what a
   * multi-second synchronous scan does to the shared Bun event loop.
   * Defaults to true so the background worker picks it up; the web runtime
   * passes false explicitly.
   */
  includeWalletPnl?: boolean;
}

// --- options ---

export function resolveDefaultRuntimeTaskOptions(input: {
  mode: 'live' | 'prod';
  env?: Record<string, string | undefined>;
}): DefaultRuntimeTaskOptions {
  const env = input.env ?? process.env;
  const explicit = env.PILIPILI_EMBED_TELEGRAM_TASKS?.trim().toLowerCase();
  if (explicit === 'true') return { embedTelegramTasks: true };
  if (explicit === 'false') return { embedTelegramTasks: false };
  return { embedTelegramTasks: input.mode !== 'prod' };
}

// --- loop task ---

/** Backoff after a thrown cycle so one bad run does not kill the loop forever. */
const LOOP_TASK_ERROR_RETRY_MS = 60_000;

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
    if (stopped) return Promise.resolve();
    started = true;
    state.pendingRun = true;
    return new Promise<void>((resolve, reject) => {
      queuedRequests.push({ reason, signal, resolve, reject });
      void drain();
    });
  }

  let drainInFlight: Promise<void> | null = null;

  function drain(): Promise<void> {
    if (draining) return drainInFlight ?? Promise.resolve();
    draining = true;
    drainInFlight = (async () => {
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
          // Must reschedule: otherwise a single throw leaves nextRunAt=null forever
          // (holdings-refresh died after OKX empty JSON and froze quiet-wallet bags).
          if (options.autoStart !== false && !stopped && queuedRequests.length === 0) {
            scheduleNext(request.reason, LOOP_TASK_ERROR_RETRY_MS, request.signal);
          }
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
      drainInFlight = null;
    }
    })();
    return drainInFlight;
  }

  return {
    key: options.key,
    label: options.label,
    async start(context) {
      if (started && !stopped) return;
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
      if (options.onStop) await options.onStop(signal);
      if (activeRun) await activeRun.catch(() => undefined);
      // 等 drain 循环整体收尾（含 cycle 间窗口），stop 返回后不再有
      // 任务状态写入/重排发生，停机时序才确定。
      if (drainInFlight) await drainInFlight.catch(() => undefined);
    },
    async runNow(reason: string) {
      await enqueue(reason);
    },
    getStatus() {
      return { ...state };
    },
  };
}

// --- registry ---

export function createTaskRegistry(tasks: TaskDefinition[]): RuntimeTaskRegistry {
  const taskMap = new Map(tasks.map((task) => [task.key, task] as const));
  return {
    async startAll() {
      for (const task of tasks) await task.start({ reason: 'startup' });
    },
    async stopAll(signal?: string) {
      for (const task of tasks) await task.stop(signal);
    },
    async runTaskNow(key: string, reason: string) {
      const task = taskMap.get(key);
      if (!task) throw new Error(`unknown task: ${key}`);
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

// --- defaults ---

const DEFAULT_ENABLEMENT_SYNC_MS = 15 * 60_000;

type HoldingsRuntimeCycle = () => Promise<{
  sleepMs: number;
  status: string;
  summary: Record<string, unknown>;
  lastError: string | null;
}>;

interface DefaultRuntimeTaskDeps {
  runTelegramChannelWorkerCycle?: typeof runTelegramChannelWorkerCycle;
  runCompletenessMaintenanceWorkerCycle?: typeof runCompletenessMaintenanceWorkerCycle;
  runHoldingsRefreshCycle?: HoldingsRuntimeCycle;
  runGmgnHoldingsRefreshCycle?: HoldingsRuntimeCycle;
  runHolderSnapshotCycle?: typeof runHolderSnapshotCycle;
  runTelegramBridgeCycle?: typeof runTelegramBridgeCycle;
  runLiveMonitorCycle?: typeof runLiveMonitorCycle;
  runPositionDeltaCycle?: typeof runPositionDeltaCycle;
  runWalletPnlCycle?: typeof runWalletPnlCycle;
  runTradeSignalCycle?: typeof runTradeSignalCycle;
  runTwitterIdentityBackfillCycle?: typeof runTwitterIdentityBackfillCycle;
  syncFeishuEnablement?: typeof syncFeishuEnablementFromNewone;
}

export function createDefaultRuntimeTasks(
  deps: DefaultRuntimeTaskDeps = {},
  options: DefaultRuntimeTaskOptions = {}
) {
  const runTelegramChannelCycle = deps.runTelegramChannelWorkerCycle ?? runTelegramChannelWorkerCycle;
  const runCompletenessCycle =
    deps.runCompletenessMaintenanceWorkerCycle ?? runCompletenessMaintenanceWorkerCycle;
  const runHoldingsCycle = deps.runHoldingsRefreshCycle ?? runNativeHoldingsRefreshQueueCycle;
  const runGmgnHoldingsCycle = deps.runGmgnHoldingsRefreshCycle ?? runGmgnHoldingsRefreshQueueCycle;
  const runHolderSnapshotCycleImpl = deps.runHolderSnapshotCycle ?? runHolderSnapshotCycle;
  const runTelegramBridgeCycleImpl = deps.runTelegramBridgeCycle ?? runTelegramBridgeCycle;
  const runLiveMonitorCycleImpl = deps.runLiveMonitorCycle ?? runLiveMonitorCycle;
  const runPositionDeltaCycleImpl = deps.runPositionDeltaCycle ?? runPositionDeltaCycle;
  const runWalletPnlCycleImpl = deps.runWalletPnlCycle ?? runWalletPnlCycle;
  const runTradeSignalCycleImpl = deps.runTradeSignalCycle ?? runTradeSignalCycle;
  const runTwitterIdentityBackfillCycleImpl =
    deps.runTwitterIdentityBackfillCycle ?? runTwitterIdentityBackfillCycle;
  const syncEnablement = deps.syncFeishuEnablement ?? syncFeishuEnablementFromNewone;

  const tasks: TaskDefinition[] = [];

  tasks.push(
    createLoopTask({
      key: 'feishu-enablement-sync',
      label: 'Feishu Enablement Sync',
      cycle: async () => {
        const result = syncEnablement();
        const envMs = Number(process.env.PILI_ENABLEMENT_SYNC_MS || DEFAULT_ENABLEMENT_SYNC_MS);
        // 飞书同步跑完,顺手对"没推特的监控用户"查 gmgn 回填推特。
        // 永不抛、失败静默 —— 不拖垮/不阻塞飞书同步本身。
        let gmgnTwitter: Awaited<
          ReturnType<typeof syncTwitterFromGmgnForUnfilledUsers>
        > | null = null;
        if (result.ok) {
          try {
            gmgnTwitter = await syncTwitterFromGmgnForUnfilledUsers({
              addresses: result.gmgnTwitterCandidates ?? [],
            });
            if (gmgnTwitter.filled > 0) {
              console.log(
                `[feishu-sync] gmgn twitter filled=${gmgnTwitter.filled} queried=${gmgnTwitter.queried} notBound=${gmgnTwitter.notBound} failed=${gmgnTwitter.failed}`
              );
            }
          } catch (error) {
            console.warn(
              `[feishu-sync] gmgn twitter sync failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
        return {
          sleepMs: Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_ENABLEMENT_SYNC_MS,
          status: result.ok ? ('idle' as const) : ('error' as const),
          detail: {
            lastError: result.error ?? null,
            enabledAddressCount: result.enabledAddressCount,
            addressesEnabled: result.addressesEnabled,
            addressesDisabled: result.addressesDisabled,
            usersEnabled: result.usersEnabled,
            usersDisabled: result.usersDisabled,
            usersCreated: result.usersCreated,
            addressesAdded: result.addressesAdded,
            ownershipSkipped: result.ownershipSkipped,
            skippedNoPerson: result.skippedNoPerson,
            newonePath: result.newonePath,
            gmgnTwitter,
          },
        };
      },
    })
  );

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
            detail: { lastError: result.lastError },
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

  for (const [key, label, cycle] of [
    ['holdings-refresh', 'Holdings Refresh (OKX/RPC)', runHoldingsCycle],
    ['holdings-refresh-gmgn', 'Holdings Refresh (GMGN)', runGmgnHoldingsCycle],
  ] as const) {
    tasks.push(
      createLoopTask({
        key,
        label,
        cycle: async () => {
          const result = await cycle();
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
  }

  tasks.push(
    createLoopTask({
      key: 'holder-snapshot',
      label: 'Holder Snapshot',
      cycle: async ({ signal }) => {
        const result = await runHolderSnapshotCycleImpl({ signal });
        return {
          sleepMs: result.sleepMs,
          status: result.status,
          detail: result.detail,
        };
      },
    })
  );

  tasks.push(
    createLoopTask({
      key: 'live-monitor',
      label: 'Live Monitor (Alchemy+GMGN)',
      cycle: async () => {
        const result = await runLiveMonitorCycleImpl();
        return {
          sleepMs: result.sleepMs,
          status: result.status,
          detail: {
            lastError: result.lastError,
            ...result.summary,
          },
        };
      },
    })
  );

  // 仓位幅度服务端真源：每 10 分钟回填近 3 天交易的 positionDeltaRatio。
  // 客户端只能看到已加载窗口，推算值会随滚动变化；这里基于完整历史写权威值。
  tasks.push(
    createLoopTask({
      key: 'position-delta-fill',
      label: 'Position Delta Fill',
      cycle: async () => {
        const result = await runPositionDeltaCycleImpl();
        return {
          sleepMs: result.sleepMs,
          status: result.status,
          detail: result.detail,
        };
      },
    })
  );

  // 人物盈亏 / 胜率：只在后台进程跑，Web 进程一律不注册（见 includeWalletPnl 注释）。
  if (options.includeWalletPnl !== false) {
    tasks.push(
      createLoopTask({
        key: 'wallet-pnl',
        label: 'Wallet PnL & Win Rate',
        cycle: async () => {
          const result = await runWalletPnlCycleImpl();
          return {
            sleepMs: result.sleepMs,
            status: result.status,
            detail: result.detail,
          };
        },
      })
    );

    // 交易信号推送：依赖 wallet-pnl 产出的胜率，所以跟它同进程、同开关。
    tasks.push(
      createLoopTask({
        key: 'trade-signal',
        label: 'Trade Signal Push',
        cycle: async () => {
          const result = await runTradeSignalCycleImpl();
          return {
            sleepMs: result.sleepMs,
            status: result.status,
            detail: result.detail,
          };
        },
      })
    );
  }

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

  // 推特身份补全：保存推特时若网络反查超时，handle 会先入库、user_id/avatar 留空。
  // 此任务定期扫这类用户，后台补上 user_id/avatar，保证推特流匹配（依赖 twitter_user_id）生效。
  tasks.push(
    createLoopTask({
      key: 'twitter-identity-backfill',
      label: 'Twitter Identity Backfill',
      cycle: async () => {
        const result = await runTwitterIdentityBackfillCycleImpl();
        return {
          sleepMs: result.sleepMs,
          status: result.status,
          detail: result.detail,
        };
      },
    })
  );

  return tasks;
}
