import { existsSync } from 'node:fs';
import path from 'node:path';
import { getDb, type DbHandle } from '@/lib/server/sqlite';

import {
  createDefaultRuntimeTasks,
  createTaskRegistry,
  resolveDefaultRuntimeTaskOptions,
  type RuntimeTaskRegistry,
} from './runtime-tasks';

export type LifecycleState = 'booting' | 'ready' | 'draining' | 'stopped';

export interface RuntimeContext {
  repoRoot: string;
  mode: 'live' | 'prod';
  port: number;
  db: DbHandle;
  tasks: RuntimeTaskRegistry;
  lifecycle: LifecycleState;
  startedAt: number;
  readyAt: number | null;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

let runtimeContext: RuntimeContext | null = null;

export function createRuntimeContext(input: { repoRoot: string; mode: 'live' | 'prod'; port: number }): RuntimeContext {
  const db = getDb();
  const taskOptions = resolveDefaultRuntimeTaskOptions({
    mode: input.mode,
  });
  // In prod, don't start embedded tasks — the background worker runs them separately.
  // Override with PILIPILI_EMBED_RUNTIME_TASKS=true for rollback.
  const embedTasks = process.env.PILIPILI_EMBED_RUNTIME_TASKS === 'true' || input.mode !== 'prod';
  const tasks = embedTasks
    ? // Never in a process that serves HTTP, dev included: the PnL walk is a
      // multi-second synchronous scan of the whole trade history.
      createTaskRegistry(createDefaultRuntimeTasks({}, { ...taskOptions, includeWalletPnl: false }))
    : createTaskRegistry([]);
  const context: RuntimeContext = {
    repoRoot: input.repoRoot,
    mode: input.mode,
    port: input.port,
    db,
    tasks,
    lifecycle: 'booting',
    startedAt: Date.now(),
    readyAt: null,
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

export function isReady(context: RuntimeContext = getRuntimeContext()): boolean {
  if (context.lifecycle !== 'ready') return false;
  try {
    // lightweight probe: can we read from the database?
    context.db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

export function isLive(): boolean {
  return runtimeContext !== null && runtimeContext.lifecycle !== 'stopped';
}

export function markReady() {
  const ctx = runtimeContext;
  if (!ctx) return;
  ctx.lifecycle = 'ready';
  ctx.readyAt = Date.now();
  ctx.log(`[runtime] ready after ${ctx.readyAt - ctx.startedAt}ms`);
  process.send?.('ready');
}

export function markDraining() {
  const ctx = runtimeContext;
  if (!ctx) return;
  ctx.lifecycle = 'draining';
  ctx.log('[runtime] draining');
}

export function markStopped() {
  const ctx = runtimeContext;
  if (!ctx) return;
  ctx.lifecycle = 'stopped';
}

export function readRuntimeContextSnapshot() {
  const context = runtimeContext;
  const memory = process.memoryUsage();
  const clientDist = context ? path.join(context.repoRoot, 'dist', 'client') : null;
  return {
    ok: true,
    runtime: 'bun-hono-vite',
    repoRoot: context?.repoRoot ?? null,
    mode: context?.mode ?? null,
    port: context?.port ?? null,
    lifecycle: context?.lifecycle ?? null,
    startedAt: context?.startedAt ?? null,
    readyAt: context?.readyAt ?? null,
    uptimeMs: context ? Date.now() - context.startedAt : null,
    clientDistExists: clientDist ? existsSync(clientDist) : null,
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
