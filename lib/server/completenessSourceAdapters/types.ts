import 'server-only';

import type {
  CompletenessSource,
  CompletenessSourceState,
  CompletenessStatus,
  CompletenessTrigger,
} from '@/lib/server/completenessTypes';

export interface CompletenessRunSourceInput {
  source: CompletenessSource;
  state: CompletenessSourceState;
  configuredStartMs: number;
  trigger: CompletenessTrigger;
  reason: string | null;
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

export interface CompletenessSourceAdapter {
  source: CompletenessSource;
  runStep: (
    input: Omit<CompletenessRunSourceInput, 'source'>
  ) => Promise<CompletenessRunSourceResult> | CompletenessRunSourceResult;
}

export function normalizeCompletenessTimestamp(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.floor(value);
}

export function parseCompletenessCheckpoint<T extends Record<string, unknown>>(
  checkpointJson: string | null | undefined
): T | null {
  if (typeof checkpointJson !== 'string' || !checkpointJson.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(checkpointJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}
