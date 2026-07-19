import 'server-only';

import { createInFlightTracker, postWithRetry } from '@/lib/server/webhookRetry';

export type BidSyncEntity = 'user' | 'address';
export type BidSyncAction = 'created' | 'imported' | 'updated' | 'deleted';

export interface BidSyncNotificationInput {
  entity: BidSyncEntity;
  action: BidSyncAction;
  userId?: string | null;
  address?: string | null;
}

type BidSyncNotifierLog = (message: string, meta?: Record<string, unknown>) => void;

interface BidSyncNotifierDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: BidSyncNotifierLog;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  attemptTimeoutMs?: number;
}

export type BidSyncNotificationResult =
  | { ok: true; status: 'sent'; attempts: number }
  | { ok: false; status: 'skipped-missing-config' | 'failed'; attempts: number; error?: string };

function normalizeConfigValue(value: string | undefined) {
  return (value || '').trim();
}

function createDefaultLogger(): BidSyncNotifierLog {
  return (message, meta) => {
    if (meta) {
      console.error(`[bidSyncNotifier] ${message}`, meta);
      return;
    }
    console.error(`[bidSyncNotifier] ${message}`);
  };
}

function resolveConfig(env: NodeJS.ProcessEnv) {
  return {
    url: normalizeConfigValue(env.BID2_SYNC_WEBHOOK_URL),
    apiKey: normalizeConfigValue(env.BID2_SYNC_WEBHOOK_API_KEY),
  };
}

function buildPayload(input: BidSyncNotificationInput) {
  return {
    event: 'bid2-mirror-sync',
    entity: input.entity,
    action: input.action,
    userId: input.userId || undefined,
    address: input.address || undefined,
  };
}

const inFlight = createInFlightTracker<BidSyncNotificationResult>();

export function triggerBid2MirrorSync(
  input: BidSyncNotificationInput,
  deps: BidSyncNotifierDeps = {}
) {
  inFlight.track(notifyBid2MirrorSync(input, deps));
}

export async function waitForBid2MirrorSyncDrain() {
  await inFlight.waitForDrain();
}

export async function notifyBid2MirrorSync(
  input: BidSyncNotificationInput,
  deps: BidSyncNotifierDeps = {}
): Promise<BidSyncNotificationResult> {
  const env = deps.env || process.env;
  const config = resolveConfig(env);
  if (!config.url || !config.apiKey) {
    return { ok: false, status: 'skipped-missing-config', attempts: 0 };
  }

  const result = await postWithRetry({
    url: config.url,
    body: JSON.stringify(buildPayload(input)),
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.apiKey,
    },
    maxAttempts: deps.maxAttempts,
    retryBaseDelayMs: deps.retryBaseDelayMs,
    attemptTimeoutMs: deps.attemptTimeoutMs,
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
    log: deps.log || createDefaultLogger(),
    logMeta: {
      entity: input.entity,
      action: input.action,
      userId: input.userId || null,
      address: input.address || null,
    },
  });

  if (result.ok) {
    return { ok: true, status: 'sent', attempts: result.attempts };
  }
  return { ok: false, status: 'failed', attempts: result.attempts, error: result.error };
}
