/**
 * Debounced in-memory queue for trade-triggered per-wallet holdings refresh.
 * Same wallet×chain coalesces into one OKX/GMGN pull after debounce.
 */
import 'server-only';

import {
  refreshWalletHoldings,
  type RefreshWalletHoldingsParams,
  type RefreshWalletHoldingsResult,
} from '@/lib/server/holdingsRefreshRuntime';

const DEFAULT_DEBOUNCE_MS = 50_000;
const DEFAULT_MAX_CONCURRENT = 1;

export type EnqueueHoldingsRefreshInput = {
  address: string;
  chain: string;
  userId: string;
};

type QueueJob = EnqueueHoldingsRefreshInput & {
  key: string;
  timer: ReturnType<typeof setTimeout> | null;
};

export type HoldingsRefreshQueueDeps = {
  refreshWallet?: (params: RefreshWalletHoldingsParams) => Promise<RefreshWalletHoldingsResult>;
  debounceMs?: number;
  maxConcurrent?: number;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  log?: (message: string) => void;
};

function getDebounceMs(envDebounce?: number) {
  if (typeof envDebounce === 'number' && Number.isFinite(envDebounce) && envDebounce >= 0) {
    return envDebounce;
  }
  const configured = Number.parseInt(process.env.HOLDINGS_TRADE_REFRESH_DEBOUNCE_MS || '', 10);
  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }
  return DEFAULT_DEBOUNCE_MS;
}

function jobKey(address: string, chain: string) {
  return `${chain.trim().toLowerCase()}:${address.trim().toLowerCase()}`;
}

export function createHoldingsRefreshQueue(deps: HoldingsRefreshQueueDeps = {}) {
  const pending = new Map<string, QueueJob>();
  const inFlight = new Set<string>();
  let active = 0;
  const waitQueue: string[] = [];

  const refreshWallet = deps.refreshWallet ?? refreshWalletHoldings;
  const debounceMs = getDebounceMs(deps.debounceMs);
  const maxConcurrent = Math.max(1, deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const log =
    deps.log ??
    ((message: string) => {
      console.log(`[holdings-refresh-queue] ${message}`);
    });

  async function runJob(key: string) {
    const job = pending.get(key);
    if (!job) return;
    pending.delete(key);
    if (job.timer) {
      clearTimer(job.timer);
      job.timer = null;
    }
    if (inFlight.has(key)) {
      // Already running; re-enqueue so a trailing trade still refreshes after.
      enqueue(job);
      return;
    }

    inFlight.add(key);
    active += 1;
    try {
      const result = await refreshWallet({
        address: job.address,
        chain: job.chain,
        userId: job.userId,
      });
      if (result.status === 'idle') {
        log(
          `ok ${key} rows=${result.holdingsRowCount} total=${result.totalAssetUsd ?? '-'}`
        );
      } else {
        log(`fail ${key} status=${result.status} err=${result.lastError ?? '-'}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`error ${key}: ${message}`);
    } finally {
      inFlight.delete(key);
      active -= 1;
      pump();
    }
  }

  function pump() {
    while (active < maxConcurrent && waitQueue.length > 0) {
      const key = waitQueue.shift();
      if (!key) break;
      if (pending.has(key)) {
        void runJob(key);
      }
    }
  }

  function scheduleRun(key: string) {
    if (!waitQueue.includes(key)) {
      waitQueue.push(key);
    }
    pump();
  }

  function enqueue(input: EnqueueHoldingsRefreshInput) {
    const address = (input.address || '').trim();
    const chain = (input.chain || '').trim();
    const userId = (input.userId || '').trim();
    if (!address || !chain || !userId) {
      return { enqueued: false, key: null as string | null };
    }

    const key = jobKey(address, chain);
    const existing = pending.get(key);
    if (existing?.timer) {
      clearTimer(existing.timer);
    }

    const job: QueueJob = {
      key,
      address,
      chain,
      userId,
      timer: null,
    };

    job.timer = setTimer(() => {
      job.timer = null;
      scheduleRun(key);
    }, debounceMs);

    pending.set(key, job);
    return { enqueued: true, key };
  }

  function pendingCount() {
    return pending.size;
  }

  function resetForTests() {
    for (const job of pending.values()) {
      if (job.timer) clearTimer(job.timer);
    }
    pending.clear();
    waitQueue.length = 0;
    inFlight.clear();
    active = 0;
  }

  return {
    enqueue,
    pendingCount,
    resetForTests,
    /** Exposed for tests / runtime wiring. */
    debounceMs,
  };
}

/** Process-wide queue used by live-monitor. */
export const holdingsRefreshQueue = createHoldingsRefreshQueue();

export function enqueueHoldingsRefresh(input: EnqueueHoldingsRefreshInput) {
  return holdingsRefreshQueue.enqueue(input);
}
