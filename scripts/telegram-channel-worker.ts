import { readTelegramMtprotoPolicy } from '@/lib/server/telegramMtprotoPolicy';
import { runTelegramChannelWorkerCycle } from '@/lib/server/telegramChannelWorkerRuntime';
import { TimeoutError, sleep, withTimeout } from '@/lib/timing';

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

    // 2026-09-03 事故：一轮 cycle 在 MTProto 断连后永久挂起（无超时），进程假活 13 天、
    // 频道一条没进。每轮必须有硬超时：超时即退出进程由 pm2 重建连接，绝不无限等。
    const cycle = await withTimeout(
      () => runTelegramChannelWorkerCycle(),
      readTelegramMtprotoPolicy().channelCycleTimeoutMs,
      'telegram-channel-worker cycle'
    );
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
  const timedOut = error instanceof TimeoutError;
  if (lease.isOwned()) {
    status.set(timedOut ? 'cycle-timeout' : 'failed', { lastError: message });
  }
  console.error(
    `${LOG_PREFIX} ${timedOut ? 'cycle timed out, exiting for a fresh client' : 'failed'}: ${message}`
  );
  lease.release();
  process.exit(1);
});
