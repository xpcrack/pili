import { getDb, type DbHandle } from '@/lib/server/sqlite';

import {
  createDefaultRuntimeTasks,
  createTaskRegistry,
  resolveDefaultRuntimeTaskOptions,
  type RuntimeTaskRegistry,
} from './runtime-tasks';

export interface RuntimeContext {
  repoRoot: string;
  mode: 'live' | 'prod';
  port: number;
  db: DbHandle;
  tasks: RuntimeTaskRegistry;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

let runtimeContext: RuntimeContext | null = null;

export function createRuntimeContext(input: { repoRoot: string; mode: 'live' | 'prod'; port: number }): RuntimeContext {
  const db = getDb();
  const taskOptions = resolveDefaultRuntimeTaskOptions({
    mode: input.mode,
  });
  const tasks = createTaskRegistry(createDefaultRuntimeTasks({}, taskOptions));
  const context: RuntimeContext = {
    repoRoot: input.repoRoot,
    mode: input.mode,
    port: input.port,
    db,
    tasks,
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
  };
  runtimeContext = context;
  return context;
}

export function getRuntimeContext() {
  if (!runtimeContext) {
    throw new Error('runtime context has not been initialized');
  }

  return runtimeContext;
}

export function readRuntimeContextSnapshot() {
  const context = runtimeContext;
  const memory = process.memoryUsage();
  return {
    ok: true,
    runtime: 'bun-hono-vite',
    repoRoot: context?.repoRoot ?? null,
    mode: context?.mode ?? null,
    port: context?.port ?? null,
    tasks: context?.tasks.listStatuses() ?? [],
    process: {
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
      },
    },
    bun: typeof (globalThis as typeof globalThis & { Bun?: { version: string } }).Bun !== 'undefined'
      ? (globalThis as typeof globalThis & { Bun?: { version: string } }).Bun?.version ?? null
      : null,
  };
}
