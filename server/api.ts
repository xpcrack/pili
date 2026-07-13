import { Hono } from 'hono';

import { registerLegacyRouteAdapters } from '@/server/legacy-routes';
import { registerRuntimeRoutes } from '@/server/runtime-api';
import { registerHolderSnapshotApiRoutes } from '@/server/holder-snapshot-api';

function hasValidAgentToken(authorization: string | undefined) {
  const expectedToken = process.env.AGENT_API_TOKEN?.trim();
  return Boolean(expectedToken && authorization === `Bearer ${expectedToken}`);
}

export function registerApiRoutes(app: Hono) {
  const api = new Hono();

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
