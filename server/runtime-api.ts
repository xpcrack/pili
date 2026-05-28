import { Hono } from 'hono';

import { readWorkerStatuses } from '@/lib/server/workerStateRepo';

import { getRuntimeContext, readRuntimeContextSnapshot } from './runtime-context';

export function registerRuntimeRoutes(app: Hono) {
  const runtime = new Hono();

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
    await runtimeContext.tasks.runTaskNow(key, reason);
    return c.json({
      ok: true,
      task: runtimeContext.tasks.getTask(key)?.getStatus() ?? null,
    });
  });

  app.route('/runtime', runtime);
}
