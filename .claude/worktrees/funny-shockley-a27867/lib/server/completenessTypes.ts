import 'server-only';

export const COMPLETENESS_SOURCES = [
  'blockchain',
  'twitter',
  'telegram-bridge',
  'telegram-channel',
] as const;

export const COMPLETENESS_STATUSES = [
  'idle',
  'running',
  'complete',
  'partial',
  'retrying',
  'blocked',
] as const;

export const COMPLETENESS_TRIGGERS = [
  'manual',
  'interval',
  'ingest',
  'config-change',
  'recovery',
] as const;

export type CompletenessSource = (typeof COMPLETENESS_SOURCES)[number];
export type CompletenessStatus = (typeof COMPLETENESS_STATUSES)[number];
export type CompletenessTrigger = (typeof COMPLETENESS_TRIGGERS)[number];

export interface CompletenessGlobalState {
  configuredStartMs: number | null;
  globalProvenStartMs: number | null;
  status: CompletenessStatus;
  activeRunId: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

export interface CompletenessSourceState {
  source: CompletenessSource;
  requestedStartMs: number | null;
  provenStartMs: number | null;
  provenEndMs: number | null;
  status: CompletenessStatus;
  failureCount: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  blockedReason: string | null;
  checkpointJson: string | null;
}

export interface CompletenessPokeRow {
  id: number;
  trigger: CompletenessTrigger;
  sourceHint: CompletenessSource | null;
  reason: string | null;
  createdAt: number;
  claimedAt: number | null;
}
