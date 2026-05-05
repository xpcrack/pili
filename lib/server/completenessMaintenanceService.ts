import 'server-only';

import { computeCompletenessGlobalStatus, computeGlobalProvenStartMs } from '@/lib/server/completenessStatus';
import { COMPLETENESS_SOURCES, type CompletenessGlobalState, type CompletenessSource, type CompletenessSourceState, type CompletenessStatus, type CompletenessTrigger } from '@/lib/server/completenessTypes';
import type { SyncLogInput } from '@/lib/server/syncLogRepo';

type Awaitable<T> = T | Promise<T>;

export const MAX_FAILURES_WITHOUT_PROGRESS = 10;

export interface CompletenessMaintenanceRunInput {
  trigger: CompletenessTrigger;
  reason?: string | null;
  source?: CompletenessSource | null;
}

export interface CompletenessRunSourceResult {
  status: CompletenessStatus;
  provenStartMs: number | null;
  provenEndMs: number | null;
  fetchedCount?: number;
  storedCount?: number;
  projectedCount?: number;
  blockedReason?: string | null;
  checkpointJson?: string | null;
  madeProgress?: boolean;
}

export interface CompletenessMaintenanceServiceDeps {
  acquireLease: () => Awaitable<boolean>;
  releaseLease: () => Awaitable<void>;
  readGlobalState: () => Awaitable<CompletenessGlobalState | null>;
  readSourceStates: () => Awaitable<CompletenessSourceState[]>;
  saveGlobalState: (state: CompletenessGlobalState) => Awaitable<void>;
  saveSourceState: (state: CompletenessSourceState) => Awaitable<void>;
  runSource: (input: {
    source: CompletenessSource;
    state: CompletenessSourceState;
    configuredStartMs: number;
    trigger: CompletenessTrigger;
    reason: string | null;
  }) => Awaitable<CompletenessRunSourceResult>;
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
        };
      }

      try {
        const globalState = (await deps.readGlobalState()) ?? createDefaultGlobalState();
        const currentSourceStates = mergeSourceStates(await deps.readSourceStates());
        const configuredStartMs = normalizeTimestamp(globalState.configuredStartMs);
        const selectedSourceStates =
          typeof configuredStartMs === 'number'
            ? currentSourceStates.filter((state) => {
                if (targetedSource && state.source !== targetedSource) {
                  return false;
                }

                if (state.status === 'blocked') {
                  return false;
                }

                return !isSourceProvenToConfiguredStartMs(state, configuredStartMs);
              })
            : [];

        let nextSourceStates = currentSourceStates.slice();

        for (const state of selectedSourceStates) {
          const result = await deps.runSource({
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
        }

        const globalProvenStartMs = computeGlobalProvenStartMs(nextSourceStates);
        const status = computeCompletenessGlobalStatus({
          configuredStartMs,
          sources: nextSourceStates,
        });
        const started = selectedSourceStates.length > 0;
        const nowMs = deps.now ? deps.now() : Date.now();

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
        };
      } finally {
        await deps.releaseLease();
      }
    },
  };
}
