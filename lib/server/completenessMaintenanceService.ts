import 'server-only';

import { computeCompletenessGlobalStatus, computeGlobalProvenStartMs } from '@/lib/server/completenessStatus';
import type {
  CompletenessRunSourceInput,
  CompletenessRunSourceResult,
  CompletenessSourceAdapter,
} from '@/lib/server/completenessSourceAdapters/types';
import { COMPLETENESS_SOURCES, type CompletenessGlobalState, type CompletenessSource, type CompletenessSourceState, type CompletenessStatus, type CompletenessTrigger } from '@/lib/server/completenessTypes';
import type { SyncLogInput } from '@/lib/server/syncLogRepo';

type Awaitable<T> = T | Promise<T>;

export const MAX_FAILURES_WITHOUT_PROGRESS = 10;
const INITIAL_RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;

export interface CompletenessMaintenanceRunInput {
  trigger: CompletenessTrigger;
  reason?: string | null;
  source?: CompletenessSource | null;
}

export interface CompletenessMaintenanceSourceRunSummary {
  source: CompletenessSource;
  requestedStartMs: number | null;
  provenStartMs: number | null;
  provenEndMs: number | null;
  status: CompletenessStatus;
  fetchedCount: number;
  storedCount: number;
  projectedCount: number;
  blockedReason: string | null;
  checkpointJson: string | null;
  madeProgress: boolean;
}

export interface CompletenessMaintenanceServiceDeps {
  acquireLease: () => Awaitable<boolean>;
  releaseLease: () => Awaitable<void>;
  readGlobalState: () => Awaitable<CompletenessGlobalState | null>;
  readSourceStates: () => Awaitable<CompletenessSourceState[]>;
  saveGlobalState: (state: CompletenessGlobalState) => Awaitable<void>;
  saveSourceState: (state: CompletenessSourceState) => Awaitable<void>;
  runSource?: (input: CompletenessRunSourceInput) => Awaitable<CompletenessRunSourceResult>;
  sourceAdapters?: Partial<Record<CompletenessSource, CompletenessSourceAdapter>>;
  appendSyncLog: (input: SyncLogInput) => Awaitable<void>;
  now?: () => number;
}

function createDefaultGlobalState(): CompletenessGlobalState {
  return {
    configuredStartMs: null,
    globalProvenStartMs: null,
    status: 'idle',
    activeRunId: null,
    lastSuccessAt: null,
    lastFailureAt: null,
  };
}

function createDefaultSourceState(source: CompletenessSource): CompletenessSourceState {
  return {
    source,
    requestedStartMs: null,
    provenStartMs: null,
    provenEndMs: null,
    status: 'idle',
    failureCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    blockedReason: null,
    checkpointJson: null,
  };
}

function normalizeTimestamp(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.floor(value);
}

function normalizeOptionalString(value: string | null | undefined) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function mergeSourceStates(sourceStates: CompletenessSourceState[]) {
  const sourceStateBySource = new Map<CompletenessSource, CompletenessSourceState>();
  for (const state of sourceStates) {
    sourceStateBySource.set(state.source, state);
  }

  return COMPLETENESS_SOURCES.map((source) => sourceStateBySource.get(source) ?? createDefaultSourceState(source));
}

function isSourceProvenToConfiguredStartMs(state: Pick<CompletenessSourceState, 'provenStartMs'>, configuredStartMs: number | null) {
  return (
    typeof configuredStartMs === 'number' &&
    Number.isFinite(configuredStartMs) &&
    typeof state.provenStartMs === 'number' &&
    Number.isFinite(state.provenStartMs) &&
    state.provenStartMs <= configuredStartMs
  );
}

function didSourceMakeProgress(previousProvenStartMs: number | null, nextProvenStartMs: number | null) {
  if (typeof nextProvenStartMs !== 'number' || !Number.isFinite(nextProvenStartMs)) {
    return false;
  }

  if (typeof previousProvenStartMs !== 'number' || !Number.isFinite(previousProvenStartMs)) {
    return true;
  }

  return nextProvenStartMs < previousProvenStartMs;
}

export function computeCompletenessRetryDelayMs(failureCount: number) {
  if (!Number.isFinite(failureCount) || failureCount <= 0) {
    return 0;
  }

  const multiplier = 2 ** Math.max(0, Math.floor(failureCount) - 1);
  return Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * multiplier);
}

function shouldDeferSourceRetry(input: {
  state: Pick<CompletenessSourceState, 'status' | 'failureCount' | 'lastFailureAt'>;
  trigger: CompletenessTrigger;
  nowMs: number;
}) {
  if (input.trigger !== 'interval') {
    return false;
  }
  if (input.state.status !== 'retrying' || input.state.failureCount <= 0) {
    return false;
  }
  if (typeof input.state.lastFailureAt !== 'number' || !Number.isFinite(input.state.lastFailureAt)) {
    return false;
  }

  return input.nowMs - input.state.lastFailureAt < computeCompletenessRetryDelayMs(input.state.failureCount);
}

function buildNextSourceState(input: {
  currentState: CompletenessSourceState;
  result: CompletenessRunSourceResult;
  configuredStartMs: number;
  nowMs: number;
}) {
  const nextProvenStartMs = normalizeTimestamp(input.result.provenStartMs);
  const nextProvenEndMs = normalizeTimestamp(input.result.provenEndMs);
  const madeProgress =
    input.result.madeProgress ?? didSourceMakeProgress(input.currentState.provenStartMs, nextProvenStartMs);
  const nextFailureCount = madeProgress ? 0 : input.currentState.failureCount + 1;
  const reachedConfiguredStart = isSourceProvenToConfiguredStartMs(
    {
      provenStartMs: nextProvenStartMs,
    },
    input.configuredStartMs
  );

  let nextStatus = input.result.status;
  if (reachedConfiguredStart) {
    nextStatus = 'complete';
  } else if (!madeProgress && nextFailureCount >= MAX_FAILURES_WITHOUT_PROGRESS) {
    nextStatus = 'blocked';
  }

  const nextCheckpointJson =
    input.result.checkpointJson === undefined
      ? input.currentState.checkpointJson
      : normalizeOptionalString(input.result.checkpointJson);

  return {
    ...input.currentState,
    requestedStartMs: input.configuredStartMs,
    provenStartMs: nextProvenStartMs,
    provenEndMs: nextProvenEndMs,
    status: nextStatus,
    failureCount: nextFailureCount,
    lastSuccessAt: madeProgress ? input.nowMs : input.currentState.lastSuccessAt,
    lastFailureAt: madeProgress ? input.currentState.lastFailureAt : input.nowMs,
    blockedReason:
      nextStatus === 'blocked'
        ? normalizeOptionalString(input.result.blockedReason) ??
          input.currentState.blockedReason ??
          `No progress after ${MAX_FAILURES_WITHOUT_PROGRESS} attempts`
        : null,
    checkpointJson: nextCheckpointJson,
  } satisfies CompletenessSourceState;
}

async function appendMaintenanceLog(
  deps: CompletenessMaintenanceServiceDeps,
  input: {
    runId?: number | null;
    level: SyncLogInput['level'];
    message: string;
    payload: Record<string, unknown>;
  }
) {
  await deps.appendSyncLog({
    runKind: 'completeness',
    runId: input.runId,
    level: input.level,
    phase: 'maintenance',
    message: input.message,
    payload: input.payload,
  });
}

async function runSourceStep(
  deps: CompletenessMaintenanceServiceDeps,
  input: CompletenessRunSourceInput
): Promise<CompletenessRunSourceResult> {
  if (deps.runSource) {
    return deps.runSource(input);
  }

  const adapter = deps.sourceAdapters?.[input.source];
  if (!adapter) {
    throw new Error(`missing completeness adapter for source: ${input.source}`);
  }

  return adapter.runStep({
    state: input.state,
    configuredStartMs: input.configuredStartMs,
    trigger: input.trigger,
    reason: input.reason,
  });
}

export function createCompletenessMaintenanceService(deps: CompletenessMaintenanceServiceDeps) {
  return {
    async runOnce(input: CompletenessMaintenanceRunInput) {
      const targetedSource = input.source ?? null;

      const leaseAcquired = await deps.acquireLease();
      if (!leaseAcquired) {
        const globalState = (await deps.readGlobalState()) ?? createDefaultGlobalState();
        const currentSourceStates = mergeSourceStates(await deps.readSourceStates());
        const configuredStartMs = normalizeTimestamp(globalState.configuredStartMs);
        const globalProvenStartMs = computeGlobalProvenStartMs(currentSourceStates);
        const status = computeCompletenessGlobalStatus({
          configuredStartMs,
          sources: currentSourceStates,
        });

        await appendMaintenanceLog(deps, {
          runId: globalState.activeRunId,
          level: 'debug',
          message: 'completeness maintenance skipped because lease is busy',
          payload: {
            started: false,
            targetedSource,
            configuredStartMs,
            status,
            globalProvenStartMs,
          },
        });

        return {
          started: false,
          status,
          globalProvenStartMs,
          sourceResults: [] as CompletenessMaintenanceSourceRunSummary[],
        };
      }

      try {
        const globalState = (await deps.readGlobalState()) ?? createDefaultGlobalState();
        const currentSourceStates = mergeSourceStates(await deps.readSourceStates());
        const configuredStartMs = normalizeTimestamp(globalState.configuredStartMs);
        const nowMs = deps.now ? deps.now() : Date.now();
        const selectedSourceStates =
          typeof configuredStartMs === 'number'
            ? currentSourceStates.filter((state) => {
                if (targetedSource && state.source !== targetedSource) {
                  return false;
                }

                if (state.status === 'blocked') {
                  return false;
                }
                if (
                  shouldDeferSourceRetry({
                    state,
                    trigger: input.trigger,
                    nowMs,
                  })
                ) {
                  return false;
                }

                return !isSourceProvenToConfiguredStartMs(state, configuredStartMs);
              })
            : [];

        let nextSourceStates = currentSourceStates.slice();
        const sourceResults: CompletenessMaintenanceSourceRunSummary[] = [];

        for (const state of selectedSourceStates) {
          const result = await runSourceStep(deps, {
            source: state.source,
            state,
            configuredStartMs: configuredStartMs as number,
            trigger: input.trigger,
            reason: normalizeOptionalString(input.reason),
          });
          const nextState = buildNextSourceState({
            currentState: state,
            result,
            configuredStartMs: configuredStartMs as number,
            nowMs: deps.now ? deps.now() : Date.now(),
          });

          nextSourceStates = nextSourceStates.map((candidate) => (candidate.source === nextState.source ? nextState : candidate));
          await deps.saveSourceState(nextState);
          sourceResults.push({
            source: nextState.source,
            requestedStartMs: configuredStartMs,
            provenStartMs: nextState.provenStartMs,
            provenEndMs: nextState.provenEndMs,
            status: nextState.status,
            fetchedCount: Math.max(0, Math.floor(result.fetchedCount ?? 0)),
            storedCount: Math.max(0, Math.floor(result.storedCount ?? 0)),
            projectedCount: Math.max(0, Math.floor(result.projectedCount ?? 0)),
            blockedReason: nextState.blockedReason,
            checkpointJson: nextState.checkpointJson,
            madeProgress: result.madeProgress ?? false,
          });
        }

        const globalProvenStartMs = computeGlobalProvenStartMs(nextSourceStates);
        const status = computeCompletenessGlobalStatus({
          configuredStartMs,
          sources: nextSourceStates,
        });
        const started = selectedSourceStates.length > 0;

        const nextGlobalState: CompletenessGlobalState = {
          ...globalState,
          configuredStartMs,
          globalProvenStartMs,
          status,
          activeRunId: globalState.activeRunId,
          lastSuccessAt:
            started && status === 'complete' ? nowMs : globalState.lastSuccessAt,
          lastFailureAt:
            started && status !== 'complete' ? nowMs : globalState.lastFailureAt,
        };

        await deps.saveGlobalState(nextGlobalState);
        await appendMaintenanceLog(deps, {
          runId: globalState.activeRunId,
          level: status === 'blocked' ? 'warn' : 'info',
          message: started
            ? 'completeness maintenance run finished'
            : 'completeness maintenance had no eligible sources',
          payload: {
            started,
            targetedSource,
            configuredStartMs,
            selectedSources: selectedSourceStates.map((state) => state.source),
            status,
            globalProvenStartMs,
          },
        });

        return {
          started,
          status,
          globalProvenStartMs,
          sourceResults,
        };
      } finally {
        await deps.releaseLease();
      }
    },
  };
}
