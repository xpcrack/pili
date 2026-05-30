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
