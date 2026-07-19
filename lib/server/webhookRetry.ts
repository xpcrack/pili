import 'server-only';

/** Shared POST-with-timeout-and-retry for BID webhook notifiers. */

export interface WebhookRetryOptions {
  url: string;
  body: string;
  headers: Record<string, string>;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  attemptTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string, meta?: Record<string, unknown>) => void;
  logMeta?: Record<string, unknown>;
}

export type WebhookRetryResult =
  | { ok: true; attempts: number; responseText: string }
  | { ok: false; attempts: number; error: string };

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 200;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 1_500;

function normalizePositiveInteger(value: number | undefined, fallback: number) {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value!)) : fallback;
}

function formatUnknownError(error: unknown) {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

function formatResponseFailure(status: number, detail: string) {
  const normalizedDetail = detail.trim();
  return normalizedDetail ? `webhook responded ${status}: ${normalizedDetail}` : `webhook responded ${status}`;
}

function computeRetryDelayMs(attempt: number, retryBaseDelayMs: number) {
  return retryBaseDelayMs * 2 ** Math.max(0, attempt - 1);
}

export async function postWithRetry(options: WebhookRetryOptions): Promise<WebhookRetryResult> {
  const fetchImpl = options.fetchImpl || fetch;
  const sleep =
    options.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log;
  const maxAttempts = normalizePositiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const retryBaseDelayMs = Number.isFinite(options.retryBaseDelayMs)
    ? Math.max(0, Math.floor(options.retryBaseDelayMs!))
    : DEFAULT_RETRY_BASE_DELAY_MS;
  const attemptTimeoutMs = normalizePositiveInteger(options.attemptTimeoutMs, DEFAULT_ATTEMPT_TIMEOUT_MS);
  const baseMeta = options.logMeta || {};

  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(new Error(`webhook request timed out after ${attemptTimeoutMs}ms`));
    }, attemptTimeoutMs);

    try {
      const response = await fetchImpl(options.url, {
        method: 'POST',
        headers: options.headers,
        body: options.body,
        signal: controller.signal,
      });

      const responseText = await response.text().catch(() => '');
      if (response.ok) {
        return { ok: true, attempts: attempt, responseText };
      }

      lastError = formatResponseFailure(response.status, responseText);
      log?.('webhook request failed', { ...baseMeta, attempt, maxAttempts, error: lastError });
    } catch (error) {
      lastError = formatUnknownError(error);
      log?.('webhook request threw', { ...baseMeta, attempt, maxAttempts, error: lastError });
    } finally {
      clearTimeout(timeoutId);
    }

    if (attempt < maxAttempts) {
      await sleep(computeRetryDelayMs(attempt, retryBaseDelayMs));
    }
  }

  return { ok: false, attempts: maxAttempts, error: lastError };
}

/** Fire-and-forget set for background webhook tasks (tests can drain). */
export function createInFlightTracker<T>() {
  const inFlight = new Set<Promise<T>>();

  function track(task: Promise<T>) {
    inFlight.add(task);
    void task.finally(() => {
      inFlight.delete(task);
    });
  }

  async function waitForDrain() {
    while (inFlight.size > 0) {
      await Promise.allSettled(Array.from(inFlight));
    }
  }

  return { track, waitForDrain };
}
