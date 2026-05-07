import { runCompletenessMaintenanceWorkerLoop } from '@/lib/server/completenessMaintenanceWorkerRuntime';

import './server-only-shim.cjs';
import {
  createWorkerStatusReporter,
  installShutdownHandlers,
  loadWorkerEnv,
} from './lib/workerLifecycle';

loadWorkerEnv();

const WORKER_KEY = 'completeness-maintenance';
const status = createWorkerStatusReporter(WORKER_KEY, WORKER_KEY);

installShutdownHandlers({
  onShutdown: (signal) => {
    status.set('stopped', { lastError: `received ${signal}` });
  },
});

void runCompletenessMaintenanceWorkerLoop().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  status.set('failed', { lastError: message });
  console.error(`[completeness-worker] failed: ${message}`);
  process.exit(1);
});
