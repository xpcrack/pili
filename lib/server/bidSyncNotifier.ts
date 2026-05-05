import 'server-only';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 200;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 1_500;

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
  | {
      ok: true;
      status: 'sent';
      attempts: number;
    }
  | {
      ok: false;
      status: 'skipped-missing-config' | 'failed';
      attempts: number;
      error?: string;
    };

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

function formatResponseFailure(status: number, detail: string) {
  const normalizedDetail = detail.trim();
  return normalizedDetail ? `webhook responded ${status}: ${normalizedDetail}` : `webhook responded ${status}`;
}

function formatUnknownError(error: unknown) {
  if (error instanceof Error) {
    return error.message || error.name;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'unknown error';
}

function computeRetryDelayMs(attempt: number, retryBaseDelayMs: number) {
  return retryBaseDelayMs * 2 ** Math.max(0, attempt - 1);
}

function normalizePositiveInteger(value: number | undefined, fallback: number) {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value!)) : fallback;
}

function createAttemptTimeoutError(timeoutMs: number) {
  return new Error(`webhook request timed out after ${timeoutMs}ms`);
}

const inFlightBid2MirrorSyncTasks = new Set<Promise<BidSyncNotificationResult>>();

function trackBid2MirrorSyncTask(task: Promise<BidSyncNotificationResult>) {
  inFlightBid2MirrorSyncTasks.add(task);
  void task.then(
    () => {
      inFlightBid2MirrorSyncTasks.delete(task);
    },
    () => {
      inFlightBid2MirrorSyncTasks.delete(task);
    }
  );
}

export function triggerBid2MirrorSync(
  input: BidSyncNotificationInput,
  deps: BidSyncNotifierDeps = {}
) {
  trackBid2MirrorSyncTask(notifyBid2MirrorSync(input, deps));
}

export async function waitForBid2MirrorSyncDrain() {
  while (inFlightBid2MirrorSyncTasks.size > 0) {
    await Promise.allSettled(Array.from(inFlightBid2MirrorSyncTasks));
  }
}

export async function notifyBid2MirrorSync(
  input: BidSyncNotificationInput,
  deps: BidSyncNotifierDeps = {}
): Promise<BidSyncNotificationResult> {
  const env = deps.env || process.env;
  const config = resolveConfig(env);
  if (!config.url || !config.apiKey) {
    return {
      ok: false,
      status: 'skipped-missing-config',
      attempts: 0,
    };
  }

  const fetchImpl = deps.fetchImpl || fetch;
  const sleep = deps.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = deps.log || createDefaultLogger();
  const maxAttempts = normalizePositiveInteger(deps.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const retryBaseDelayMs = Number.isFinite(deps.retryBaseDelayMs)
    ? Math.max(0, Math.floor(deps.retryBaseDelayMs!))
    : DEFAULT_RETRY_BASE_DELAY_MS;
  const attemptTimeoutMs = normalizePositiveInteger(deps.attemptTimeoutMs, DEFAULT_ATTEMPT_TIMEOUT_MS);
  const body = JSON.stringify(buildPayload(input));

  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(createAttemptTimeoutError(attemptTimeoutMs));
    }, attemptTimeoutMs);

    try {
      const response = await fetchImpl(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': config.apiKey,
        },
        body,
        signal: controller.signal,
      });

      if (response.ok) {
        return {
          ok: true,
          status: 'sent',
          attempts: attempt,
        };
      }

      const detail = await response.text().catch(() => '');
      lastError = formatResponseFailure(response.status, detail);
      log('webhook request failed', {
        attempt,
        maxAttempts,
        entity: input.entity,
        action: input.action,
        userId: input.userId || null,
        address: input.address || null,
        error: lastError,
      });
    } catch (error) {
      lastError = formatUnknownError(error);
      log('webhook request threw', {
        attempt,
        maxAttempts,
        entity: input.entity,
        action: input.action,
        userId: input.userId || null,
        address: input.address || null,
        error: lastError,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (attempt < maxAttempts) {
      await sleep(computeRetryDelayMs(attempt, retryBaseDelayMs));
    }
  }

  return {
    ok: false,
    status: 'failed',
    attempts: maxAttempts,
    error: lastError,
  };
}
