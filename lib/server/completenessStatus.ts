import 'server-only';

import type { CompletenessSourceState, CompletenessStatus } from '@/lib/server/completenessTypes';

type CompletenessStatusSource = Pick<CompletenessSourceState, 'provenStartMs' | 'status'>;

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

export function computeCompletenessGlobalStatus(input: {
  configuredStartMs: number | null;
  sources: ReadonlyArray<CompletenessStatusSource>;
}): CompletenessStatus {
  const { configuredStartMs, sources } = input;

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
      (source) =>
        hasNumericProvenStartMs(source.provenStartMs) && (source.provenStartMs as number) <= configuredStartMs
    )
  ) {
    return 'complete';
  }

  return 'partial';
}
