import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { registerLegacyRouteAdapters } from '@/server/legacy-routes';
import { registerRuntimeRoutes } from '@/server/runtime-api';
import { registerHolderSnapshotApiRoutes } from '@/server/holder-snapshot-api';

function hasValidAgentToken(authorization: string | undefined) {
  const expectedToken = process.env.AGENT_API_TOKEN?.trim();
  return Boolean(expectedToken && authorization === `Bearer ${expectedToken}`);
}

export function registerApiRoutes(app: Hono) {
  const api = new Hono();

  api.use(
    '*',
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json({ ok: false, error: 'payload_too_large' }, 413),
    })
  );
  api.use('*', async (c, next) => {
    const method = c.req.method.toUpperCase();
    const isMutation = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    if (isMutation && c.req.header('sec-fetch-site') === 'cross-site') {
      return c.json({ ok: false, error: 'cross_site_request_rejected' }, 403);
    }
    await next();
  });

  registerRuntimeRoutes(api);
  registerLegacyRouteAdapters(api);
  registerHolderSnapshotApiRoutes(api);

  api.get('/agent/opportunities', (c) => {
    if (!hasValidAgentToken(c.req.header('authorization'))) {
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    c.header('Cache-Control', 'no-store');
    return c.json(
      {
        ok: false,
        error: 'gone',
        code: 'AGENT_OPPORTUNITIES_DISABLED',
        message: 'This API has been permanently disabled. No active callers were identified.',
      },
      410,
    );
  });

  app.route('/api', api);
}
