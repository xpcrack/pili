import { NextRequest, NextResponse } from 'next/server';

import { enforceAdminRateLimit, requireAdmin } from '@/lib/server/apiGuard';
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

function parseSource(value: unknown): CompletenessSource | null {
  return COMPLETENESS_SOURCES.includes(value as CompletenessSource) ? (value as CompletenessSource) : null;
}

function mergeSourceStates(sourceStates: CompletenessSourceState[]) {
  const stateBySource = new Map(sourceStates.map((state) => [state.source, state]));
  return COMPLETENESS_SOURCES.map(
    (source) =>
      stateBySource.get(source) || {
        source,
        requestedStartMs: null,
        provenStartMs: null,
        provenEndMs: null,
        status: 'idle' as const,
        failureCount: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        blockedReason: null,
        checkpointJson: null,
      }
  );
}

function parseAction(value: unknown) {
  if (value === 'run-now' || value === 'retry-source' || value === 'clear-source-checkpoint') {
    return value;
  }
  return null;
}

function buildCompletenessPayload() {
  const config = readSystemConfig();
  const sourceStates = mergeSourceStates(readCompletenessSourceStates());
  const persistedGlobalState = readCompletenessGlobalState();
  const configuredStartMs = config.completenessStartMs;
  const globalProvenStartMs = computeGlobalProvenStartMs(sourceStates);
  const status = computeCompletenessGlobalStatus({
    configuredStartMs,
    sources: sourceStates,
  });
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
  return NextResponse.json({
    ok: true,
    completeness: buildCompletenessPayload(),
  });
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
      return NextResponse.json({ ok: false, error: 'invalid_action' }, { status: 400 });
    }

    if (action === 'clear-source-checkpoint') {
      if (!source) {
        return NextResponse.json({ ok: false, error: 'source_required' }, { status: 400 });
      }
      const sourceState = readCompletenessSourceStates().find((item) => item.source === source) || null;
      if (!sourceState) {
        return NextResponse.json({ ok: false, error: 'source_not_found' }, { status: 404 });
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
      return NextResponse.json({
        ok: true,
        action,
        source,
        completeness: buildCompletenessPayload(),
      });
    }

    if (action === 'retry-source') {
      if (!source) {
        return NextResponse.json({ ok: false, error: 'source_required' }, { status: 400 });
      }
      const sourceState = readCompletenessSourceStates().find((item) => item.source === source) || null;
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

    return NextResponse.json({
      ok: true,
      action,
      result,
      completeness: buildCompletenessPayload(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'completeness request failed',
      },
      { status: 500 }
    );
  }
}
