import 'server-only';

import {
  appendCompletenessRunSource,
  claimCompletenessPokes,
  createCompletenessRun,
  deleteClaimedCompletenessPokes,
  finishCompletenessRun,
  readCompletenessGlobalState,
  releaseClaimedCompletenessPokes,
  readCompletenessSourceStates,
  readPendingCompletenessPokes,
  saveCompletenessGlobalState,
  saveCompletenessSourceState,
} from '@/lib/server/completenessRepo';
import { createCompletenessMaintenanceService, computeCompletenessRetryDelayMs } from '@/lib/server/completenessMaintenanceService';
import { createBlockchainCompletenessAdapter } from '@/lib/server/completenessSourceAdapters/blockchain';
import { createTelegramBridgeCompletenessAdapter } from '@/lib/server/completenessSourceAdapters/telegramBridge';
import { createTelegramChannelCompletenessAdapter } from '@/lib/server/completenessSourceAdapters/telegramChannel';
import { createTwitterCompletenessAdapter } from '@/lib/server/completenessSourceAdapters/twitter';
import type {
  CompletenessMaintenanceRunInput,
  CompletenessMaintenanceSourceRunSummary,
} from '@/lib/server/completenessMaintenanceService';
import type { CompletenessSource, CompletenessSourceState, CompletenessTrigger } from '@/lib/server/completenessTypes';
import { appendSyncLog } from '@/lib/server/syncLogRepo';
import { getSyncStatus, triggerSync, waitForSyncCompletion } from '@/lib/server/syncService';
import { readSystemConfig } from '@/lib/server/systemConfigRepo';
import { backfillTelegramBridgeHistory } from '@/lib/server/telegramBridgeMtprotoBackfill';
import { backfillTelegramChannelSourceHistory } from '@/lib/server/telegramChannelSync';
import { listTelegramChannelSources } from '@/lib/server/telegramChannelSourceRepo';
import { createTelegramGramjsClient } from '@/lib/server/telegramGramjsClient';
import { readTelegramMtprotoPolicy, sleep } from '@/lib/server/telegramMtprotoPolicy';
import { listTrackedTwitterUsers, readTwitterCursor } from '@/lib/server/twitterRepo';
import { runTwitterSyncAction } from '@/lib/server/twitterSyncService';
import { acquireIngestionLease, releaseIngestionLease } from '@/lib/server/twitterRepo';
import { upsertWorkerStatus } from '@/lib/server/workerStateRepo';

const WORKER_KEY = 'completeness-maintenance';
const WORKER_TYPE = 'completeness-maintenance';
const WORKER_LEASE_TTL_MS = 90_000;
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const BUSY_RETRY_DELAY_MS = 30_000;

function normalizeOptionalString(value: string | null | undefined) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isTerminalCapabilityError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Missing TELEGRAM_API_ID|Missing TELEGRAM_API_HASH|Telegram user session required|not authorized/i.test(message);
}

function buildBlockedOrRetryingResult(input: {
  state: CompletenessSourceState;
  error: unknown;
}) {
  const message = normalizeOptionalString(input.error instanceof Error ? input.error.message : String(input.error)) || 'unknown completeness source error';
  const terminal = isTerminalCapabilityError(input.error);
  return {
    status: terminal ? ('blocked' as const) : ('retrying' as const),
    provenStartMs: input.state.provenStartMs,
    provenEndMs: input.state.provenEndMs,
    fetchedCount: 0,
    storedCount: 0,
    projectedCount: 0,
    blockedReason: message,
    checkpointJson: input.state.checkpointJson,
    madeProgress: false,
  };
}

function ensureGlobalStateConfiguredStartMs() {
  const config = readSystemConfig();
  const globalState = readCompletenessGlobalState();
  if (!globalState) {
    saveCompletenessGlobalState({
      configuredStartMs: config.completenessStartMs,
      globalProvenStartMs: null,
      status: config.completenessStartMs ? 'partial' : 'idle',
      activeRunId: null,
      lastSuccessAt: null,
      lastFailureAt: null,
    });
    return config.completenessStartMs;
  }

  if (globalState.configuredStartMs !== config.completenessStartMs) {
    saveCompletenessGlobalState({
      ...globalState,
      configuredStartMs: config.completenessStartMs,
      status: config.completenessStartMs ? globalState.status : 'idle',
    });
  }
  return config.completenessStartMs;
}

function buildSourceAdapters() {
  return {
    blockchain: createBlockchainCompletenessAdapter({
      triggerBackfillStep: async ({ reason, options }) => triggerSync(reason, options),
      waitForBackfillStep: async () => {
        await waitForSyncCompletion();
      },
      readWindowState: () => getSyncStatus().windowState,
      readSyncCompletedAtMs: () => getSyncStatus().lastSuccessAt,
    }),
    twitter: createTwitterCompletenessAdapter({
      listTrackedUsers: () => listTrackedTwitterUsers(),
      runSyncAction: async ({ action, userId, windowDays, force }) => {
        const result = await runTwitterSyncAction({
          action,
          userId,
          windowDays,
          force,
        });
        return {
          ok: result.ok,
          error: result.ok ? undefined : result.error,
          summary:
            'summary' in result && result.summary && typeof result.summary === 'object'
              ? {
                  budgetExhausted:
                    'budgetExhausted' in result.summary ? Boolean(result.summary.budgetExhausted) : undefined,
                  budgetReasons:
                    'budgetReasons' in result.summary && Array.isArray(result.summary.budgetReasons)
                      ? result.summary.budgetReasons.filter((value): value is string => typeof value === 'string')
                      : undefined,
                }
              : undefined,
        };
      },
      readCursor: (userId, lane) => readTwitterCursor(userId, lane),
    }),
    'telegram-bridge': createTelegramBridgeCompletenessAdapter({
      readBridgeTargets: () => {
        const config = readSystemConfig();
        return [
          config.telegramTradeMonitorSourceChatId
            ? { chatId: config.telegramTradeMonitorSourceChatId, mode: 'telegram-monitor' as const }
            : null,
          config.telegramTwitterMonitorSourceChatId
            ? { chatId: config.telegramTwitterMonitorSourceChatId, mode: 'twitter-relay' as const }
            : null,
        ].filter((item): item is { chatId: string; mode: 'telegram-monitor' | 'twitter-relay' } => Boolean(item));
      },
      backfillHistory: async ({ beforeByChatId, startMs, endMs }) => {
        const client = await createTelegramGramjsClient();
        try {
          return await backfillTelegramBridgeHistory({
            client,
            beforeByChatId,
            startMs,
            endMs,
            limitPerChat: readTelegramMtprotoPolicy().bridgeBackfillLimit,
          });
        } finally {
          await client.disconnect?.();
        }
      },
    }),
    'telegram-channel': createTelegramChannelCompletenessAdapter({
      listEnabledSources: () => listTelegramChannelSources({ enabledOnly: true }),
      backfillSourceHistory: async ({ source, beforeMessageId, startMs, endMs }) => {
        const client = await createTelegramGramjsClient();
        try {
          return await backfillTelegramChannelSourceHistory({
            sourceId: source.id,
            client,
            beforeMessageId,
            startMs,
            endMs,
          });
        } finally {
          await client.disconnect?.();
        }
      },
    }),
  } as const;
}

function buildOwnerId() {
  return `${process.pid}:${Date.now().toString(36)}:${Math.random().toString(16).slice(2, 8)}`;
}

function summarizeRun(input: {
  sourceResults: CompletenessMaintenanceSourceRunSummary[];
  status: string;
  globalProvenStartMs: number | null;
}) {
  const blockedSources = input.sourceResults.filter((result) => result.status === 'blocked').map((result) => result.source);
  const partialSources = input.sourceResults
    .filter((result) => result.status === 'partial' || result.status === 'retrying')
    .map((result) => result.source);

  return {
    status: input.status,
    globalProvenStartMs: input.globalProvenStartMs,
    blockedSources,
    partialSources,
    selectedSources: input.sourceResults.map((result) => result.source),
  };
}

function upsertCompletenessWorkerStatus(status: string, lastError?: string | null) {
  upsertWorkerStatus({
    workerKey: WORKER_KEY,
    workerType: WORKER_TYPE,
    status,
    lastError: lastError || null,
  });
}

export async function runCompletenessMaintenancePass(input: CompletenessMaintenanceRunInput) {
  const configuredStartMs = ensureGlobalStateConfiguredStartMs();
  const ownerId = buildOwnerId();
  const nowMs = Date.now();
  if (!acquireIngestionLease(WORKER_KEY, ownerId, nowMs, WORKER_LEASE_TTL_MS)) {
    return {
      started: false,
      status: readCompletenessGlobalState()?.status || 'idle',
      globalProvenStartMs: readCompletenessGlobalState()?.globalProvenStartMs ?? null,
      sourceResults: [] as CompletenessMaintenanceSourceRunSummary[],
      busy: true,
    };
  }

  const run = createCompletenessRun({
    reason: input.reason ?? null,
    trigger: input.trigger,
    configuredStartMs,
  });

  try {
    const adapters = buildSourceAdapters();
    const service = createCompletenessMaintenanceService({
      acquireLease: async () => true,
      releaseLease: async () => {},
      readGlobalState: async () => readCompletenessGlobalState(),
      readSourceStates: async () => readCompletenessSourceStates(),
      saveGlobalState: async (state) => {
        saveCompletenessGlobalState(state);
      },
      saveSourceState: async (state) => {
        saveCompletenessSourceState(state);
      },
      appendSyncLog: async (log) => {
        appendSyncLog(log);
      },
      runSource: async (sourceInput) => {
        const adapter = adapters[sourceInput.source];
        try {
          return await adapter.runStep({
            state: sourceInput.state,
            configuredStartMs: sourceInput.configuredStartMs,
            trigger: sourceInput.trigger,
            reason: sourceInput.reason,
          });
        } catch (error) {
          return buildBlockedOrRetryingResult({
            state: sourceInput.state,
            error,
          });
        }
      },
    });

    const result = await service.runOnce(input);
    for (const sourceResult of result.sourceResults) {
      appendCompletenessRunSource({
        runId: run.id,
        source: sourceResult.source,
        requestedStartMs: sourceResult.requestedStartMs,
        provenStartMs: sourceResult.provenStartMs,
        provenEndMs: sourceResult.provenEndMs,
        status: sourceResult.status,
        fetchedCount: sourceResult.fetchedCount,
        storedCount: sourceResult.storedCount,
        projectedCount: sourceResult.projectedCount,
        blockedReason: sourceResult.blockedReason,
        checkpointJson: sourceResult.checkpointJson,
      });
    }

    finishCompletenessRun(run.id, result.status, summarizeRun(result));
    upsertCompletenessWorkerStatus(result.status, result.status === 'blocked' ? 'one or more completeness sources blocked' : null);
    return {
      ...result,
      busy: false,
    };
  } finally {
    releaseIngestionLease(WORKER_KEY, ownerId);
  }
}

function mergePokesIntoRunInput(pokes: ReturnType<typeof readPendingCompletenessPokes>): CompletenessMaintenanceRunInput {
  const first = pokes[0];
  const uniqueSourceHints = Array.from(new Set(pokes.map((poke) => poke.sourceHint).filter((value): value is CompletenessSource => Boolean(value))));
  const reason = Array.from(new Set(pokes.map((poke) => normalizeOptionalString(poke.reason)).filter((value): value is string => Boolean(value)))).join(', ');
  return {
    trigger: first?.trigger || 'interval',
    source: uniqueSourceHints.length === 1 ? uniqueSourceHints[0] : null,
    reason: reason || (first?.reason ?? null),
  };
}

interface CompletenessMaintenanceWorkerCycleDeps {
  ensureGlobalStateConfiguredStartMs: typeof ensureGlobalStateConfiguredStartMs;
  readCompletenessGlobalState: typeof readCompletenessGlobalState;
  readPendingCompletenessPokes: typeof readPendingCompletenessPokes;
  claimCompletenessPokes: typeof claimCompletenessPokes;
  releaseClaimedCompletenessPokes: typeof releaseClaimedCompletenessPokes;
  deleteClaimedCompletenessPokes: typeof deleteClaimedCompletenessPokes;
  runCompletenessMaintenancePass: typeof runCompletenessMaintenancePass;
  readCompletenessSourceStates: typeof readCompletenessSourceStates;
  now?: () => number;
}

export function createCompletenessMaintenanceWorkerCycle(
  overrides: Partial<CompletenessMaintenanceWorkerCycleDeps> = {}
) {
  const deps: CompletenessMaintenanceWorkerCycleDeps = {
    ensureGlobalStateConfiguredStartMs,
    readCompletenessGlobalState,
    readPendingCompletenessPokes,
    claimCompletenessPokes,
    releaseClaimedCompletenessPokes,
    deleteClaimedCompletenessPokes,
    runCompletenessMaintenancePass,
    readCompletenessSourceStates,
    ...overrides,
  };

  return async function runCompletenessMaintenanceWorkerCycle() {
    deps.ensureGlobalStateConfiguredStartMs();
    const pokes = deps.readPendingCompletenessPokes(20);
    const pendingIds = pokes.map((poke) => poke.id);
    const claimedAt = deps.now ? deps.now() : Date.now();
    const claimedIds =
      pendingIds.length > 0 ? deps.claimCompletenessPokes(pendingIds, claimedAt) : [];
    const claimedIdSet = new Set(claimedIds);
    const claimedPokes = pokes.filter((poke) => claimedIdSet.has(poke.id));
    if (claimedIds.length > 0) {
      // no-op: claiming already happened above so we can know exactly which ids we own
    }

    if (pendingIds.length > 0 && claimedIds.length === 0) {
      const globalState = deps.readCompletenessGlobalState();
      return {
        started: false,
        status: globalState?.status || 'idle',
        globalProvenStartMs: globalState?.globalProvenStartMs ?? null,
        sourceResults: [],
        busy: true,
        sleepMs: BUSY_RETRY_DELAY_MS,
        claimedPokeCount: 0,
      };
    }

    try {
      const input =
        claimedPokes.length > 0
          ? mergePokesIntoRunInput(claimedPokes)
          : { trigger: 'interval' as CompletenessTrigger, reason: 'periodic sweep' };
      const result = await deps.runCompletenessMaintenancePass(input);
      const sourceStates = deps.readCompletenessSourceStates();
      const retryDelayMs = sourceStates
        .filter((state) => state.status === 'retrying')
        .map((state) => computeCompletenessRetryDelayMs(state.failureCount))
        .reduce((best, current) => (best === null ? current : Math.min(best, current)), null as number | null);

      if (claimedIds.length > 0) {
        if (result.busy) {
          deps.releaseClaimedCompletenessPokes(claimedIds, claimedAt);
        } else {
          deps.deleteClaimedCompletenessPokes(claimedIds, claimedAt);
        }
      }

      return {
        ...result,
        sleepMs: result.busy ? BUSY_RETRY_DELAY_MS : retryDelayMs ?? DEFAULT_INTERVAL_MS,
        claimedPokeCount: claimedIds.length,
      };
    } catch (error) {
      if (claimedIds.length > 0) {
        deps.releaseClaimedCompletenessPokes(claimedIds, claimedAt);
      }
      throw error;
    }
  };
}

export async function runCompletenessMaintenanceWorkerCycleWithDeps(
  overrides: Partial<CompletenessMaintenanceWorkerCycleDeps> = {}
) {
  return createCompletenessMaintenanceWorkerCycle(overrides)();
}

export const runCompletenessMaintenanceWorkerCycle = createCompletenessMaintenanceWorkerCycle();

export async function runCompletenessMaintenanceWorkerLoop() {
  upsertCompletenessWorkerStatus('running');
  while (true) {
    try {
      const cycle = await runCompletenessMaintenanceWorkerCycle();
      await sleep(cycle.sleepMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      upsertCompletenessWorkerStatus('error', message);
      await sleep(BUSY_RETRY_DELAY_MS);
    }
  }
}
