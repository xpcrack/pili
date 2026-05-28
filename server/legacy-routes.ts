import { Hono } from 'hono';
import { NextRequest } from 'next/server';

type RouteMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type RouteModule = Record<string, unknown>;

interface LegacyRouteDefinition {
  method: RouteMethod;
  path: string;
  load: () => Promise<RouteModule>;
}

const ROUTES: LegacyRouteDefinition[] = [
  { method: 'GET', path: '/feed', load: () => import('@/app/api/feed/route') },
  { method: 'POST', path: '/feed', load: () => import('@/app/api/feed/route') },
  { method: 'POST', path: '/feed/prewarm', load: () => import('@/app/api/feed/prewarm/route') },
  { method: 'GET', path: '/users', load: () => import('@/app/api/users/route') },
  { method: 'POST', path: '/users', load: () => import('@/app/api/users/route') },
  { method: 'POST', path: '/users/import', load: () => import('@/app/api/users/import/route') },
  { method: 'GET', path: '/users/:id', load: () => import('@/app/api/users/[id]/route') },
  { method: 'PATCH', path: '/users/:id', load: () => import('@/app/api/users/[id]/route') },
  { method: 'DELETE', path: '/users/:id', load: () => import('@/app/api/users/[id]/route') },
  { method: 'GET', path: '/users/:id/addresses', load: () => import('@/app/api/users/[id]/addresses/route') },
  { method: 'POST', path: '/users/:id/addresses', load: () => import('@/app/api/users/[id]/addresses/route') },
  { method: 'DELETE', path: '/users/:id/addresses', load: () => import('@/app/api/users/[id]/addresses/route') },
  { method: 'GET', path: '/users/activity-stats', load: () => import('@/app/api/users/activity-stats/route') },
  { method: 'GET', path: '/addresses', load: () => import('@/app/api/addresses/route') },
  { method: 'GET', path: '/tokens', load: () => import('@/app/api/tokens/route') },
  { method: 'POST', path: '/tokens', load: () => import('@/app/api/tokens/route') },
  { method: 'DELETE', path: '/tokens', load: () => import('@/app/api/tokens/route') },
  { method: 'POST', path: '/tokens/bulk-import', load: () => import('@/app/api/tokens/bulk-import/route') },
  { method: 'GET', path: '/diagnostics', load: () => import('@/app/api/diagnostics/route') },
  { method: 'GET', path: '/system-config', load: () => import('@/app/api/system-config/route') },
  { method: 'PATCH', path: '/system-config', load: () => import('@/app/api/system-config/route') },
  { method: 'POST', path: '/system-config/test-notify', load: () => import('@/app/api/system-config/test-notify/route') },
  { method: 'GET', path: '/completeness', load: () => import('@/app/api/completeness/route') },
  { method: 'POST', path: '/completeness', load: () => import('@/app/api/completeness/route') },
  { method: 'GET', path: '/events/stats', load: () => import('@/app/api/events/stats/route') },
  { method: 'GET', path: '/sync/status', load: () => import('@/app/api/sync/status/route') },
  { method: 'GET', path: '/sync/logs', load: () => import('@/app/api/sync/logs/route') },
  { method: 'POST', path: '/sync', load: () => import('@/app/api/sync/route') },
  { method: 'GET', path: '/twitter/sync', load: () => import('@/app/api/twitter/sync/route') },
  { method: 'POST', path: '/twitter/sync', load: () => import('@/app/api/twitter/sync/route') },
  { method: 'GET', path: '/debug/tx-judgment', load: () => import('@/app/api/debug/tx-judgment/route') },
  { method: 'GET', path: '/debug/tx-judgment/stream', load: () => import('@/app/api/debug/tx-judgment/stream/route') },
  { method: 'GET', path: '/avatar', load: () => import('@/app/api/avatar/route') },
  { method: 'GET', path: '/token-logo', load: () => import('@/app/api/token-logo/route') },
];

function toNextRequest(request: Request) {
  return new NextRequest(request);
}

function buildContextParams(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

export function registerLegacyRouteAdapters(app: Hono) {
  for (const route of ROUTES) {
    app.on(route.method, route.path, async (c) => {
      const mod = await route.load();
      const handler = mod[route.method] as
        | ((request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>)
        | undefined;

      if (!handler) {
        return c.json({ ok: false, error: 'method not implemented' }, 501);
      }

      const request = toNextRequest(c.req.raw.clone());
      const params = c.req.param();
      const context = buildContextParams(params);
      return handler(request, context);
    });
  }
}
