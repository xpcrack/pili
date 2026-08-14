import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';
import { NextRequest } from '@/lib/server/httpCompat';

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
  // 静态路径必须先于 /users/:id 注册，否则被参数路由吞掉（404 用户不存在）
  { method: 'GET', path: '/users/activity-stats', load: () => import('@/app/api/users/activity-stats/route') },
  { method: 'GET', path: '/users/:id', load: () => import('@/app/api/users/[id]/route') },
  { method: 'PATCH', path: '/users/:id', load: () => import('@/app/api/users/[id]/route') },
  { method: 'DELETE', path: '/users/:id', load: () => import('@/app/api/users/[id]/route') },
  { method: 'GET', path: '/users/:id/addresses', load: () => import('@/app/api/users/[id]/addresses/route') },
  { method: 'POST', path: '/users/:id/addresses', load: () => import('@/app/api/users/[id]/addresses/route') },
  { method: 'DELETE', path: '/users/:id/addresses', load: () => import('@/app/api/users/[id]/addresses/route') },
  { method: 'GET', path: '/addresses', load: () => import('@/app/api/addresses/route') },
  { method: 'GET', path: '/ranking', load: () => import('@/app/api/ranking/route') },
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
  { method: 'GET', path: '/internal/bid/users', load: () => import('@/app/api/internal/bid/users/route') },
  { method: 'GET', path: '/internal/bid/trades', load: () => import('@/app/api/internal/bid/trades/route') },
  { method: 'GET', path: '/internal/bid/onchain-events', load: () => import('@/app/api/internal/bid/onchain-events/route') },
  { method: 'GET', path: '/debug/tx-judgment', load: () => import('@/app/api/debug/tx-judgment/route') },
  { method: 'GET', path: '/debug/tx-judgment/stream', load: () => import('@/app/api/debug/tx-judgment/stream/route') },
  { method: 'GET', path: '/avatar', load: () => import('@/app/api/avatar/route') },
  { method: 'GET', path: '/media', load: () => import('@/app/api/media/route') },
  { method: 'GET', path: '/token-logo', load: () => import('@/app/api/token-logo/route') },
  { method: 'POST', path: '/token-logo/batch', load: () => import('@/app/api/token-logo/batch/route') },
  { method: 'GET', path: '/okx/transactions', load: () => import('@/app/api/okx/transactions/route') },
  { method: 'GET', path: '/okx/health', load: () => import('@/app/api/okx/health/route') },
  { method: 'POST', path: '/backfill-14days', load: () => import('@/app/api/backfill-14days/route') },
  { method: 'POST', path: '/twitter/relay', load: () => import('@/app/api/twitter/relay/route') },
  { method: 'POST', path: '/telegram/relay', load: () => import('@/app/api/telegram/relay/route') },
  { method: 'POST', path: '/telegram/channel-sync', load: () => import('@/app/api/telegram/channel-sync/route') },
  { method: 'POST', path: '/telegram/monitor', load: () => import('@/app/api/telegram/monitor/route') },
];

function normalizeLoopback(address: string | undefined | null) {
  const value = (address || '').trim();
  if (!value) return null;
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return '127.0.0.1';
  if (value.startsWith('::ffff:')) {
    const v4 = value.slice(7);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return v4;
  }
  return value;
}

function readRemoteAddress(c: { env?: unknown; req: { raw: Request } }) {
  try {
    return normalizeLoopback(getConnInfo(c as never).remote.address);
  } catch {
    // app.request() / non-node bindings: no socket
  }

  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return normalizeLoopback(env?.incoming?.socket?.remoteAddress);
}

// BID client only sends Authorization; inject socket IP so INTERNAL_BID_ALLOWED_IPS works.
// Always overwrite: a client-supplied x-real-ip is forgeable, the socket is ground truth.
function toNextRequest(request: Request, remoteAddress?: string | null) {
  const next = new NextRequest(request);
  if (remoteAddress) {
    next.headers.set('x-real-ip', remoteAddress);
  }
  return next;
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

      const request = toNextRequest(c.req.raw.clone(), readRemoteAddress(c));
      const params = c.req.param();
      const context = buildContextParams(params);
      return handler(request, context);
    });
  }
}
