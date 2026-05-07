import { NextRequest } from 'next/server';

import { enforceAdminRateLimit, requireAdmin } from '@/lib/server/apiGuard';
import { apiError, apiOk } from '@/lib/server/apiResponse';
import {
  readCompletenessGlobalState,
  readCompletenessRunSources,
  readCompletenessSourceStates,
  readRecentCompletenessRuns,
  saveCompletenessSourceState,
} from '@/lib/server/completenessRepo';
import { runCompletenessMaintenancePass } from '@/lib/server/completenessMaintenanceWorkerRuntime';
import { computeCompletenessGlobalStatus, computeGlobalProvenStartMs } from '@/lib/server/completenessStatus';
import { COMPLETENESS_SOURCES, type CompletenessSource, type CompletenessSourceState } from '@/lib/server/completenessTypes';
import { readSystemConfig } from '@/lib/server/systemConfigRepo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CompletenessAction = 'run-now' | 'retry-source' | 'clear-source-checkpoint';

function parseSource(value: unknown): CompletenessSource | null {
  return COMPLETENESS_SOURCES.includes(value as CompletenessSource) ? (value as CompletenessSource) : null;
}

function parseAction(value: unknown): CompletenessAction | null {
  if (value === 'run-now' || value === 'retry-source' || value === 'clear-source-checkpoint') {
    return value;
  }
  return null;
}

function makeIdleSourceState(source: CompletenessSource): CompletenessSourceState {
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

function mergeSourceStates(sourceStates: CompletenessSourceState[]) {
  const stateBySource = new Map(sourceStates.map((state) => [state.source, state]));
  return COMPLETENESS_SOURCES.map((source) => stateBySource.get(source) ?? makeIdleSourceState(source));
}

function buildCompletenessPayload() {
  const config = readSystemConfig();
  const sourceStates = mergeSourceStates(readCompletenessSourceStates());
  const persistedGlobalState = readCompletenessGlobalState();
  const configuredStartMs = config.completenessStartMs;
  const globalProvenStartMs = computeGlobalProvenStartMs(sourceStates);
  const status = computeCompletenessGlobalStatus({ configuredStartMs, sources: sourceStates });
  const runs = readRecentCompletenessRuns(10);
  const latestRun = runs[0] || null;
  const latestRunSources = latestRun ? readCompletenessRunSources(latestRun.id) : [];

  return {
    configuredStartMs,
    globalState: {
      configuredStartMs,
      globalProvenStartMs,
      status,
      activeRunId: persistedGlobalState?.activeRunId ?? null,
      lastSuccessAt: persistedGlobalState?.lastSuccessAt ?? null,
      lastFailureAt: persistedGlobalState?.lastFailureAt ?? null,
    },
    sourceStates,
    latestRun,
    latestRunSources,
    runs,
  };
}

export async function GET() {
  return apiOk({ completeness: buildCompletenessPayload() });
}

export async function POST(request: NextRequest) {
  const unauthorizedResponse = requireAdmin(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  const rateLimitResponse = enforceAdminRateLimit(request, {
    endpoint: 'completeness',
    max: 12,
    windowMs: 60_000,
  });
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const body = await request.json().catch(() => ({}));
    const action = parseAction(body?.action);
    const source = parseSource(body?.source);

    if (!action) {
      return apiError('invalid_action', { status: 400 });
    }

    if (action === 'clear-source-checkpoint') {
      if (!source) {
        return apiError('source_required', { status: 400 });
      }
      const sourceState = readCompletenessSourceStates().find((item) => item.source === source) ?? null;
      if (!sourceState) {
        return apiError('source_not_found', { status: 404 });
      }
      saveCompletenessSourceState({
        ...sourceState,
        status: 'partial',
        failureCount: 0,
        blockedReason: null,
        checkpointJson: null,
        provenStartMs: null,
        provenEndMs: null,
      });
      return apiOk({ action, source, completeness: buildCompletenessPayload() });
    }

    if (action === 'retry-source') {
      if (!source) {
        return apiError('source_required', { status: 400 });
      }
      const sourceState = readCompletenessSourceStates().find((item) => item.source === source) ?? null;
      if (sourceState) {
        saveCompletenessSourceState({
          ...sourceState,
          status: 'partial',
          failureCount: 0,
          blockedReason: null,
          lastFailureAt: null,
        });
      }
    }

    const result = await runCompletenessMaintenancePass({
      trigger: action === 'retry-source' ? 'recovery' : 'manual',
      source,
      reason: typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : action,
    });

    return apiOk({ action, result, completeness: buildCompletenessPayload() });
  } catch (error) {
    return apiError(error, { fallback: 'completeness request failed' });
  }
}
