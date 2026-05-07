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
  /** Called once per signal before the process exits. Should be fast and synchronous. */
  onShutdown: (signal: 'SIGINT' | 'SIGTERM') => void;
  /** Process exit code. Defaults to 0. */
  exitCode?: number;
}

/** Wires SIGINT/SIGTERM to a single handler that runs `onShutdown` then `process.exit`. */
export function installShutdownHandlers(opts: InstallShutdownHandlersOptions): void {
  const handler = (signal: 'SIGINT' | 'SIGTERM') => {
    opts.onShutdown(signal);
    process.exit(opts.exitCode ?? 0);
  };
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
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
    this.heartbeatTimer = setInterval(() => {
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
    releaseIngestionLease(this.opts.workerKey, this.owner);
  }
}
