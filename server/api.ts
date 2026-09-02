import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';

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
  // CORS: allow the GemView FOMO-Lens Chrome extension (chrome-extension://
  // origin) to POST /api/fomo/token. Every sensitive endpoint behind /api
  // requires an admin/agent token (fail-closed), so allowing browser
  // cross-origin preflight does not bypass auth — a request without the token
  // still 401s at requireAdmin. cors() with default origin '*' reflects any
  // Origin, which is what a browser preflight needs.
  api.use('*', cors());
  api.use('*', async (c, next) => {
    const method = c.req.method.toUpperCase();
    const isMutation = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    // Same-origin SPA requests are the normal path; keep the cross-site guard
    // for everything EXCEPT /fomo/token (the extension's token push carries a
    // valid admin token, so it needs to survive the cross-site check).
    if (
      isMutation &&
      c.req.header('sec-fetch-site') === 'cross-site' &&
      !/\/fomo\/token$/.test(c.req.path)
    ) {
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
