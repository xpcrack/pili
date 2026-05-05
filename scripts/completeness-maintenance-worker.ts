import path from 'node:path';

import { runCompletenessMaintenanceWorkerLoop } from '@/lib/server/completenessMaintenanceWorkerRuntime';
import { upsertWorkerStatus } from '@/lib/server/workerStateRepo';

import './server-only-shim.cjs';
import { loadEnvFile } from './telegram-bridge-core';

loadEnvFile(path.join(process.cwd(), '.env.local'));

const WORKER_KEY = 'completeness-maintenance';

function installShutdownHandlers() {
  const shutdown = (signal: string) => {
    upsertWorkerStatus({
      workerKey: WORKER_KEY,
      workerType: WORKER_KEY,
      status: 'stopped',
      lastError: `received ${signal}`,
    });
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function run() {
  installShutdownHandlers();
  await runCompletenessMaintenanceWorkerLoop();
}

void run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  upsertWorkerStatus({
    workerKey: WORKER_KEY,
    workerType: WORKER_KEY,
    status: 'failed',
    lastError: message,
  });
  console.error(`[completeness-worker] failed: ${message}`);
  process.exit(1);
});
