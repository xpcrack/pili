import 'server-only';

import type { CompletenessSourceState, CompletenessStatus } from '@/lib/server/completenessTypes';

type CompletenessStatusSource = Pick<CompletenessSourceState, 'provenStartMs' | 'provenEndMs' | 'status'>;

function hasNumericProvenStartMs(value: number | null) {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasNumericProvenEndMs(value: number | null) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function computeGlobalProvenStartMs(sources: ReadonlyArray<Pick<CompletenessSourceState, 'provenStartMs'>>) {
  if (sources.length === 0) {
    return null;
  }

  const provenStartValues = sources.map((source) => source.provenStartMs);
  if (!provenStartValues.every((value) => hasNumericProvenStartMs(value))) {
    return null;
  }

  return Math.max(...(provenStartValues as number[]));
}

export function computeGlobalProvenEndMs(sources: ReadonlyArray<Pick<CompletenessSourceState, 'provenEndMs'>>) {
  if (sources.length === 0) {
    return null;
  }

  const provenEndValues = sources.map((source) => source.provenEndMs);
  if (!provenEndValues.every((value) => hasNumericProvenEndMs(value))) {
    return null;
  }

  return Math.min(...(provenEndValues as number[]));
}

export function isCompletenessEndStale(input: {
  provenEndMs: number | null;
  nowMs: number;
  staleAfterMs: number;
}) {
  const { provenEndMs, nowMs, staleAfterMs } = input;
  return !hasNumericProvenEndMs(provenEndMs) || nowMs - (provenEndMs as number) > staleAfterMs;
}

export function computeCompletenessGlobalStatus(input: {
  configuredStartMs: number | null;
  sources: ReadonlyArray<CompletenessStatusSource>;
  nowMs?: number;
  staleAfterMs?: number;
}): CompletenessStatus {
  const { configuredStartMs, sources } = input;
  const nowMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const staleAfterMs =
    typeof input.staleAfterMs === 'number' && Number.isFinite(input.staleAfterMs) && input.staleAfterMs > 0
      ? input.staleAfterMs
      : 30 * 60 * 1000;

  if (sources.some((source) => source.status === 'blocked')) {
    return 'blocked';
  }

  if (sources.some((source) => source.status === 'running' || source.status === 'retrying')) {
    return 'retrying';
  }

  if (
    typeof configuredStartMs === 'number' &&
    Number.isFinite(configuredStartMs) &&
    sources.length > 0 &&
    sources.every(
      (source) => !isCompletenessEndStale({ provenEndMs: source.provenEndMs, nowMs, staleAfterMs })
    ) &&
    sources.every(
      (source) =>
        hasNumericProvenStartMs(source.provenStartMs) && (source.provenStartMs as number) <= configuredStartMs
    )
  ) {
    return 'complete';
  }

  return 'partial';
}
