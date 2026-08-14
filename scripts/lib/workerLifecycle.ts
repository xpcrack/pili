/**
 * Shared lifecycle helpers for long-running worker entrypoints under scripts/.
 *
 * Consolidates the env-loading, signal handling, status reporting, and lease
 * management boilerplate that was duplicated across:
 *   - scripts/completeness-maintenance-worker.ts
 *   - scripts/telegram-channel-worker.ts
 *   - scripts/telegram-bridge.ts
 *   - scripts/telegram-agent-approval-bot.ts
 *
 * Behavior is intentionally kept identical to the previous inline implementations.
 */

import os from 'node:os';
import path from 'node:path';

import { queueCompletenessPoke } from '@/lib/server/completenessRepo';
import type { CompletenessSource, CompletenessTrigger } from '@/lib/server/completenessTypes';
import {
  acquireIngestionLease,
  heartbeatIngestionLease,
  releaseIngestionLease,
} from '@/lib/server/twitterRepo';
import { upsertWorkerStatus } from '@/lib/server/workerStateRepo';
import { sleep } from '@/lib/timing';

import { loadEnvFile } from '../telegram-bridge-core';

// --------------------------------------------------------------------------
// Env loading
// --------------------------------------------------------------------------

/** Loads `.env.local` from the current working directory into `process.env`. */
export function loadWorkerEnv(): void {
  loadEnvFile(path.join(process.cwd(), '.env.local'));
  // DexScreener / external HTTP via Node fetch needs env proxy (Node 24+ NODE_USE_ENV_PROXY).
  // TG MTPROTO uses TELEGRAM_PROXY separately; outbound HTTPS often still needs these.
  if (!process.env.HTTP_PROXY && !process.env.HTTPS_PROXY && !process.env.ALL_PROXY) {
    process.env.HTTP_PROXY = 'http://127.0.0.1:7897';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';
    process.env.ALL_PROXY = 'http://127.0.0.1:7897';
  }
  if (!process.env.NODE_USE_ENV_PROXY) {
    process.env.NODE_USE_ENV_PROXY = '1';
  }
  // OKX calls use an explicit undici ProxyAgent in long-running workers;
  // Node's global fetch + env proxy is prone to stale/reset sockets here.
  if (!process.env.PILI_OKX_USE_PROXY_AGENT) {
    process.env.PILI_OKX_USE_PROXY_AGENT = '1';
  }
  if (!process.env.NO_PROXY) {
    process.env.NO_PROXY = '127.0.0.1,localhost,::1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12';
  }
}

// --------------------------------------------------------------------------
// Worker owner string
// --------------------------------------------------------------------------

/** Returns `${hostname}:${pid}` — used as the unique owner key for ingestion leases. */
export function getWorkerOwner(): string {
  return `${os.hostname()}:${process.pid}`;
}

// --------------------------------------------------------------------------
// Shutdown handlers
// --------------------------------------------------------------------------

export interface InstallShutdownHandlersOptions {
  /** Called once per signal before the process exits. May be async; the process exits after it resolves. */
  onShutdown: (signal: 'SIGINT' | 'SIGTERM') => void | Promise<void>;
  /** Process exit code. Defaults to 0. */
  exitCode?: number;
}

/**
 * Wires SIGINT/SIGTERM to a single handler that runs `onShutdown` then
 * `process.exit`. Async `onShutdown` (e.g. `tasks.stopAll`) is awaited before
 * exit; a second signal during shutdown is ignored so the cleanup can finish.
 */
export function installShutdownHandlers(opts: InstallShutdownHandlersOptions): void {
  let exiting = false;
  const handler = async (signal: 'SIGINT' | 'SIGTERM') => {
    if (exiting) return;
    exiting = true;
    try {
      await opts.onShutdown(signal);
    } catch (error) {
      console.error(
        `[workerLifecycle] shutdown handler failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    process.exit(opts.exitCode ?? 0);
  };
  process.on('SIGINT', () => void handler('SIGINT'));
  process.on('SIGTERM', () => void handler('SIGTERM'));
}

// --------------------------------------------------------------------------
// Worker status reporter
// --------------------------------------------------------------------------

export interface WorkerStatusUpdate {
  lastError?: string | null;
  lastUpdateId?: number | null;
}

export interface WorkerStatusReporter {
  set(status: string, update?: WorkerStatusUpdate): void;
}

/** Returns a thin wrapper that always upserts with the same workerKey/workerType. */
export function createWorkerStatusReporter(
  workerKey: string,
  workerType: string
): WorkerStatusReporter {
  return {
    set(status, update) {
      upsertWorkerStatus({
        workerKey,
        workerType,
        status,
        lastUpdateId: update?.lastUpdateId ?? null,
        lastError: update?.lastError ?? null,
      });
    },
  };
}

// --------------------------------------------------------------------------
// Lease management
// --------------------------------------------------------------------------

export interface WorkerLeaseOptions {
  workerKey: string;
  status: WorkerStatusReporter;
  /** Lease TTL in ms. Pass a function for dynamic TTL (read on every acquire). */
  leaseTtlMs: number | (() => number);
  /** Delay between acquire retries when lease is busy. Defaults to 10_000. */
  retryDelayMs?: number;
  /**
   * Heartbeat interval. If a function, called with the resolved TTL each acquire.
   * Defaults to `min(30_000, max(5_000, ttl/3))`.
   */
  heartbeatMs?: number | ((ttlMs: number) => number);
  /** Hook called after every successful heartbeat (e.g. touchWorkerHeartbeat). */
  onHeartbeat?: () => void;
  /** If set, status is upserted with this value after every successful heartbeat. */
  heartbeatStatus?: string;
  /** If set, status is upserted with this value while waiting for the lease. */
  waitingStatus?: string;
  /** If set, queued as a completeness poke each time the lease is acquired. */
  pokeOnAcquired?: { trigger: CompletenessTrigger; sourceHint: CompletenessSource | null; reason: string };
  /** Logger for "lease acquired" / "lease busy" lines. Defaults to no-op. */
  log?: (message: string) => void;
}

/**
 * Owns the acquire / heartbeat / release lifecycle for a single worker lease.
 * The `status` reporter parameter is reused for status upserts so the workerKey
 * and workerType stay consistent across the lifecycle events.
 */
export class WorkerLease {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private leaseLost = false;
  private leaseOwned = false;
  private shuttingDown = false;
  private readonly owner = getWorkerOwner();

  constructor(private readonly opts: WorkerLeaseOptions) {}

  isOwned(): boolean {
    return this.leaseOwned;
  }

  isLost(): boolean {
    return this.leaseLost;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  shouldRun(): boolean {
    return !this.shuttingDown;
  }

  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  private resolveTtlMs(): number {
    return typeof this.opts.leaseTtlMs === 'function' ? this.opts.leaseTtlMs() : this.opts.leaseTtlMs;
  }

  private resolveHeartbeatMs(ttlMs: number): number {
    if (typeof this.opts.heartbeatMs === 'function') return this.opts.heartbeatMs(ttlMs);
    if (typeof this.opts.heartbeatMs === 'number') return this.opts.heartbeatMs;
    return Math.min(30_000, Math.max(5_000, Math.floor(ttlMs / 3)));
  }

  private startHeartbeat(ttlMs: number): void {
    this.stopHeartbeat();
    const intervalMs = this.resolveHeartbeatMs(ttlMs);
    // Anything thrown from a bare setInterval callback is an unhandled
    // rejection and kills the process. `onHeartbeat` reaches straight into
    // SQLite, so this catch is the last line of defence between a contended
    // write and a dead ingest worker.
    this.heartbeatTimer = setInterval(() => {
      try {
        const now = Date.now();
        if (!heartbeatIngestionLease(this.opts.workerKey, this.owner, now, ttlMs)) {
          this.leaseLost = true;
          this.opts.status.set('lease-lost', { lastError: 'worker lease heartbeat failed' });
          return;
        }
        if (this.opts.heartbeatStatus) {
          this.opts.status.set(this.opts.heartbeatStatus);
        }
        this.opts.onHeartbeat?.();
      } catch (error) {
        console.warn(
          `[worker-lifecycle] heartbeat failed for ${this.opts.workerKey} (non-fatal):`,
          error instanceof Error ? error.message : error
        );
      }
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Blocks until the lease is acquired or shutdown is signaled. */
  async waitForAcquire(): Promise<void> {
    const retryDelayMs = this.opts.retryDelayMs ?? 10_000;
    const log = this.opts.log ?? (() => {});

    while (!this.shuttingDown) {
      const ttlMs = this.resolveTtlMs();
      const now = Date.now();
      if (acquireIngestionLease(this.opts.workerKey, this.owner, now, ttlMs)) {
        this.leaseLost = false;
        this.leaseOwned = true;
        this.opts.status.set('running');
        if (this.opts.pokeOnAcquired) {
          queueCompletenessPoke(this.opts.pokeOnAcquired);
        }
        this.startHeartbeat(ttlMs);
        log('worker lease acquired');
        return;
      }

      if (this.opts.waitingStatus) {
        this.opts.status.set(this.opts.waitingStatus);
      }
      log('worker lease busy, waiting...');
      await sleep(retryDelayMs);
    }
  }

  /** Releases the lease and stops the heartbeat. Safe to call repeatedly. */
  release(): void {
    this.stopHeartbeat();
    this.leaseOwned = false;
    try {
      releaseIngestionLease(this.opts.workerKey, this.owner);
    } catch (error) {
      // Runs during shutdown; the lease expires by TTL regardless.
      console.warn(
        `[worker-lifecycle] lease release failed for ${this.opts.workerKey} (non-fatal):`,
        error instanceof Error ? error.message : error
      );
    }
  }
}
