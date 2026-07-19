import { syncFeishuEnablementFromNewone } from '@/lib/server/feishuEnablementSync';
import { runCompletenessMaintenanceWorkerCycle } from '@/lib/server/completenessMaintenanceWorkerRuntime';
import { runHoldingsRefreshCycle } from '@/lib/server/holdingsRefreshRuntime';
import { runHolderSnapshotCycle } from '@/lib/server/holderSnapshotRuntime';
import { runLiveMonitorCycle } from '@/lib/server/liveMonitorRuntime';
import { runTelegramBridgeCycle } from '@/lib/server/telegramBridgeRuntime';
import { runTelegramChannelWorkerCycle } from '@/lib/server/telegramChannelWorkerRuntime';

import { createLoopTask } from './loopTask';
import type { DefaultRuntimeTaskOptions, TaskDefinition } from './types';

const DEFAULT_ENABLEMENT_SYNC_MS = 15 * 60_000;

interface DefaultRuntimeTaskDeps {
  runTelegramChannelWorkerCycle?: typeof runTelegramChannelWorkerCycle;
  runCompletenessMaintenanceWorkerCycle?: typeof runCompletenessMaintenanceWorkerCycle;
  runHoldingsRefreshCycle?: typeof runHoldingsRefreshCycle;
  runHolderSnapshotCycle?: typeof runHolderSnapshotCycle;
  runTelegramBridgeCycle?: typeof runTelegramBridgeCycle;
  runLiveMonitorCycle?: typeof runLiveMonitorCycle;
  syncFeishuEnablement?: typeof syncFeishuEnablementFromNewone;
}

export function createDefaultRuntimeTasks(
  deps: DefaultRuntimeTaskDeps = {},
  options: DefaultRuntimeTaskOptions = {}
) {
  const runTelegramChannelCycle = deps.runTelegramChannelWorkerCycle ?? runTelegramChannelWorkerCycle;
  const runCompletenessCycle =
    deps.runCompletenessMaintenanceWorkerCycle ?? runCompletenessMaintenanceWorkerCycle;
  const runHoldingsCycle = deps.runHoldingsRefreshCycle ?? runHoldingsRefreshCycle;
  const runHolderSnapshotCycleImpl = deps.runHolderSnapshotCycle ?? runHolderSnapshotCycle;
  const runTelegramBridgeCycleImpl = deps.runTelegramBridgeCycle ?? runTelegramBridgeCycle;
  const runLiveMonitorCycleImpl = deps.runLiveMonitorCycle ?? runLiveMonitorCycle;
  const syncEnablement = deps.syncFeishuEnablement ?? syncFeishuEnablementFromNewone;

  const tasks: TaskDefinition[] = [];

  tasks.push(
    createLoopTask({
      key: 'feishu-enablement-sync',
      label: 'Feishu Enablement Sync',
      cycle: async () => {
        const result = syncEnablement();
        const envMs = Number(process.env.PILI_ENABLEMENT_SYNC_MS || DEFAULT_ENABLEMENT_SYNC_MS);
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
            newonePath: result.newonePath,
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
