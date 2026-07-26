import { Hono } from 'hono';

import { readWorkerStatuses } from '@/lib/server/workerStateRepo';

import { getRuntimeContext, readRuntimeContextSnapshot, isReady, isLive } from './runtime-context';

export function registerRuntimeRoutes(app: Hono) {
  const runtime = new Hono();

  runtime.get('/live', (c) => {
    if (!isLive()) return c.json({ ok: false, error: 'not live' }, 503);
    return c.json({ ok: true, lifecycle: getRuntimeContext().lifecycle });
  });

  runtime.get('/ready', (c) => {
    if (!isReady()) return c.json({ ok: false, error: 'not ready' }, 503);
    return c.json({ ok: true, lifecycle: getRuntimeContext().lifecycle });
  });

  runtime.get('/status', (c) => {
    return c.json({
      ...readRuntimeContextSnapshot(),
      persistedWorkers: readWorkerStatuses(),
    });
  });

  runtime.post('/tasks/:key/run', async (c) => {
    const key = c.req.param('key');
    const body = await c.req.json().catch(() => ({}));
    const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'manual';
    const runtimeContext = getRuntimeContext();
    if (!runtimeContext.tasks.getTask(key)) {
      return c.json({ ok: false, error: `task not registered in this process: ${key}` }, 404);
    }
    await runtimeContext.tasks.runTaskNow(key, reason);
    return c.json({
      ok: true,
      task: runtimeContext.tasks.getTask(key)?.getStatus() ?? null,
    });
  });

  app.route('/runtime', runtime);
}
