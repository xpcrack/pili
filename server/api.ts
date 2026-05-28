import { Hono } from 'hono';

import { registerLegacyRouteAdapters } from '@/server/legacy-routes';
import { registerRuntimeRoutes } from '@/server/runtime-api';

export function registerApiRoutes(app: Hono) {
  const api = new Hono();

  registerRuntimeRoutes(api);
  registerLegacyRouteAdapters(api);

  app.route('/api', api);
}
