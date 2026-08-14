import './server-only-shim.cjs';

import { loadRuntimeEnv } from '@/server/env';
import {
  createDefaultRuntimeTasks,
  createTaskRegistry,
} from '@/server/runtime-tasks';
import {
  createWorkerStatusReporter,
  installShutdownHandlers,
  loadWorkerEnv,
  getWorkerOwner,
} from './lib/workerLifecycle';

loadWorkerEnv();

const WORKER_KEY = 'pili-background-worker';
const WORKER_TYPE = 'background-worker';

async function main() {
  const status = createWorkerStatusReporter(WORKER_KEY, WORKER_TYPE);
  loadRuntimeEnv(process.cwd());

  // Sole owner of periodic work in production: pili-web-prod registers no tasks.
  // Telegram bridge/channel-sync stay excluded — they have their own PM2 processes.
  const tasks = createTaskRegistry(
    createDefaultRuntimeTasks({}, { embedTelegramTasks: false })
  );

  status.set('starting');

  let shuttingDown = false;
  const shutdown = async (signal: 'SIGINT' | 'SIGTERM') => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[background-worker] shutting down (${signal})`);
    status.set('stopping', { lastError: `received ${signal}` });
    await tasks.stopAll(signal);
    status.set('stopped');
    process.exit(0);
  };

  installShutdownHandlers({
    onShutdown: (signal) => shutdown(signal),
  });

  await tasks.startAll();
  status.set('running');
  console.log(
    `[background-worker] owner=${getWorkerOwner()} started ${tasks.listStatuses().length} tasks`
  );

  setInterval(() => {
    status.set('running');
  }, 60_000);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
