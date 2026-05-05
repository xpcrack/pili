import os from 'node:os';
import path from 'node:path';

import { queueCompletenessPoke } from '@/lib/server/completenessRepo';
import { acquireIngestionLease, heartbeatIngestionLease, releaseIngestionLease } from '@/lib/server/twitterRepo';
import { readTelegramMtprotoPolicy, sleep } from '@/lib/server/telegramMtprotoPolicy';
import { runTelegramChannelWorkerCycle } from '@/lib/server/telegramChannelWorkerRuntime';
import { touchWorkerHeartbeat, upsertWorkerStatus } from '@/lib/server/workerStateRepo';

import './server-only-shim.cjs';
import { loadEnvFile } from './telegram-bridge-core';

loadEnvFile(path.join(process.cwd(), '.env.local'));

const WORKER_KEY = 'telegram-channel-sync';
const WORKER_TYPE = 'telegram-channel-sync';
const LEASE_RETRY_DELAY_MS = 10_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let leaseLost = false;
let shuttingDown = false;
let leaseOwned = false;

function getWorkerOwner() {
  return `${os.hostname()}:${process.pid}`;
}

function upsertChannelWorkerStatus(status: string, lastError?: string | null) {
  upsertWorkerStatus({
    workerKey: WORKER_KEY,
    workerType: WORKER_TYPE,
    status,
    lastError: lastError || null,
  });
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat(leaseTtlMs: number) {
  stopHeartbeat();
  const heartbeatMs = Math.min(30_000, Math.max(5_000, Math.floor(leaseTtlMs / 3)));
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    if (!heartbeatIngestionLease(WORKER_KEY, getWorkerOwner(), now, leaseTtlMs)) {
      leaseLost = true;
      upsertChannelWorkerStatus('lease-lost', 'worker lease heartbeat failed');
      return;
    }
    touchWorkerHeartbeat(WORKER_KEY);
  }, heartbeatMs);
}

async function waitForWorkerLease(leaseTtlMs: number) {
  while (!shuttingDown) {
    const now = Date.now();
    if (acquireIngestionLease(WORKER_KEY, getWorkerOwner(), now, leaseTtlMs)) {
      leaseLost = false;
      leaseOwned = true;
      upsertChannelWorkerStatus('running');
      queueCompletenessPoke({
        trigger: 'recovery',
        sourceHint: 'telegram-channel',
        reason: 'telegram channel worker lease recovered',
      });
      startHeartbeat(leaseTtlMs);
      console.log('[telegram-channel-worker] worker lease acquired');
      return;
    }

    console.log('[telegram-channel-worker] worker lease busy, waiting...');
    await sleep(LEASE_RETRY_DELAY_MS);
  }
}

function releaseWorkerLease() {
  stopHeartbeat();
  leaseOwned = false;
  releaseIngestionLease(WORKER_KEY, getWorkerOwner());
}

function installShutdownHandlers() {
  const shutdown = (signal: string) => {
    shuttingDown = true;
    console.log(`[telegram-channel-worker] shutting down (${signal})`);
    if (leaseOwned) {
      upsertChannelWorkerStatus('stopped');
    }
    releaseWorkerLease();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function run() {
  installShutdownHandlers();
  const policy = readTelegramMtprotoPolicy();
  await waitForWorkerLease(policy.channelSyncLeaseTtlMs);

  while (!shuttingDown) {
    if (leaseLost) {
      console.warn('[telegram-channel-worker] lease lost, reacquiring...');
      releaseWorkerLease();
      await waitForWorkerLease(readTelegramMtprotoPolicy().channelSyncLeaseTtlMs);
      continue;
    }

    const cycle = await runTelegramChannelWorkerCycle();
    if (shuttingDown) {
      break;
    }
    if (cycle.status === 'missing-credentials' || cycle.status === 'auth-required') {
      releaseWorkerLease();
    }
    await sleep(cycle.sleepMs);
    if (!leaseOwned && !shuttingDown) {
      await waitForWorkerLease(readTelegramMtprotoPolicy().channelSyncLeaseTtlMs);
    }
  }
}

void run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (leaseOwned) {
    upsertChannelWorkerStatus('failed', message);
  }
  console.error(`[telegram-channel-worker] failed: ${message}`);
  releaseWorkerLease();
  process.exit(1);
});
