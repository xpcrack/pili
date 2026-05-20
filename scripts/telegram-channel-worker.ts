import { readTelegramMtprotoPolicy } from '@/lib/server/telegramMtprotoPolicy';
import { runTelegramChannelWorkerCycle } from '@/lib/server/telegramChannelWorkerRuntime';
import { touchWorkerHeartbeat } from '@/lib/server/workerStateRepo';
import { sleep } from '@/lib/timing';

import './server-only-shim.cjs';
import {
  WorkerLease,
  createWorkerStatusReporter,
  installShutdownHandlers,
  loadWorkerEnv,
} from './lib/workerLifecycle';

loadWorkerEnv();

const WORKER_KEY = 'telegram-channel-sync';
const LOG_PREFIX = '[telegram-channel-worker]';

const status = createWorkerStatusReporter(WORKER_KEY, WORKER_KEY);

const lease = new WorkerLease({
  workerKey: WORKER_KEY,
  status,
  leaseTtlMs: () => readTelegramMtprotoPolicy().channelSyncLeaseTtlMs,
  pokeOnAcquired: {
    trigger: 'recovery',
    sourceHint: 'telegram-channel',
    reason: 'telegram channel worker lease recovered',
  },
  onHeartbeat: () => touchWorkerHeartbeat(WORKER_KEY),
  log: (message) => console.log(`${LOG_PREFIX} ${message}`),
});

installShutdownHandlers({
  onShutdown: (signal) => {
    lease.markShuttingDown();
    console.log(`${LOG_PREFIX} shutting down (${signal})`);
    if (lease.isOwned()) {
      status.set('stopped');
    }
    lease.release();
  },
});

async function run() {
  await lease.waitForAcquire();
  let cycleCount = 0;
  let lastActiveAt = Date.now();

  while (lease.shouldRun()) {
    if (lease.isLost()) {
      console.warn(`${LOG_PREFIX} lease lost, reacquiring...`);
      lease.release();
      await lease.waitForAcquire();
      continue;
    }

    const cycle = await runTelegramChannelWorkerCycle();
    cycleCount += 1;
    if (cycle.status !== 'idle' && cycle.status !== 'partial') {
      lastActiveAt = Date.now();
    }

    const policy = readTelegramMtprotoPolicy();
    if (cycleCount >= policy.channelWorkerMaxCyclesBeforeRestart) {
      console.log(
        `${LOG_PREFIX} restart reason=cycle-limit cycles=${cycleCount} limit=${policy.channelWorkerMaxCyclesBeforeRestart}`
      );
      lease.release();
      process.exit(0);
    }

    const idleMs = Date.now() - lastActiveAt;
    if (idleMs >= policy.channelWorkerMaxIdleMsBeforeRestart) {
      console.log(
        `${LOG_PREFIX} restart reason=idle-limit idleMs=${idleMs} limitMs=${policy.channelWorkerMaxIdleMsBeforeRestart}`
      );
      lease.release();
      process.exit(0);
    }

    if (lease.isShuttingDown()) {
      break;
    }
    if (cycle.status === 'missing-credentials' || cycle.status === 'auth-required') {
      lease.release();
    }
    await sleep(cycle.sleepMs);
    if (!lease.isOwned() && !lease.isShuttingDown()) {
      await lease.waitForAcquire();
    }
  }
}

void run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (lease.isOwned()) {
    status.set('failed', { lastError: message });
  }
  console.error(`${LOG_PREFIX} failed: ${message}`);
  lease.release();
  process.exit(1);
});
