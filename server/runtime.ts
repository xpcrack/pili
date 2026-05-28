import path from 'node:path';

import { createServer } from '@/server/server';
import { loadRuntimeEnv } from '@/server/env';
import { readRuntimeContextSnapshot } from '@/server/runtime-context';
import { readWorkerStatuses } from '@/lib/server/workerStateRepo';

type RuntimeMode = 'live' | 'prod' | 'status';
type BunGlobal = { version: string };

function parseMode(value: string | undefined): RuntimeMode {
  if (value === 'live' || value === 'prod' || value === 'status') {
    return value;
  }
  return 'live';
}

async function main() {
  const mode = parseMode(process.argv[2]);
  const repoRoot = process.cwd();
  const port = Number.parseInt(process.env.PORT || '3005', 10) || 3005;
  loadRuntimeEnv(repoRoot);

  if (mode === 'status') {
    const bunVersion = (globalThis as typeof globalThis & { Bun?: BunGlobal }).Bun?.version ?? null;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/runtime/status`);
      if (response.ok) {
        console.log(await response.text());
        return;
      }
    } catch {
      // Fall back to a local snapshot below.
    }

    console.log(
      JSON.stringify(
        {
          ...readRuntimeContextSnapshot(),
          cwd: repoRoot,
          distDir: path.join(repoRoot, 'dist/client'),
          persistedWorkers: readWorkerStatuses(),
          bun: bunVersion,
        },
        null,
        2
      )
    );
    return;
  }

  const server = await createServer({
    mode,
    repoRoot,
    port,
  });

  let shuttingDown = false;
  const shutdown = async (signal: 'SIGINT' | 'SIGTERM') => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[runtime] shutting down (${signal})`);

    try {
      await server.stop(signal);
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await server.start();
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
