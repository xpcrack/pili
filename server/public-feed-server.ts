import fs from 'node:fs';
import path from 'node:path';

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { compress } from 'hono/compress';
import type { StatusCode } from 'hono/utils/http-status';

import { loadRuntimeEnv } from '@/server/env';

const repoRoot = process.cwd();
loadRuntimeEnv(repoRoot);

const PUBLIC_PORT = Number.parseInt(process.env.PUBLIC_FEED_PORT || '3014', 10) || 3014;
const distIndexPath = path.join(repoRoot, 'dist/client/index.html');

const PUBLIC_FEED_USER = (process.env.PILI_PUBLIC_FEED_USER || '').trim();
const PUBLIC_FEED_PASSWORD = (process.env.PILI_PUBLIC_FEED_PASSWORD || '').trim();
const publicFeedCredentialsConfigured = Boolean(PUBLIC_FEED_USER && PUBLIC_FEED_PASSWORD);

const app = new Hono();

// 公网只读视图访问门：未配置口令时 fail-closed 拒绝服务，避免误暴露。
if (!publicFeedCredentialsConfigured) {
  app.use('*', async (c) =>
    c.text('public feed disabled: PILI_PUBLIC_FEED_USER / PILI_PUBLIC_FEED_PASSWORD not configured', 503)
  );
} else {
  app.use('*', basicAuth({ username: PUBLIC_FEED_USER, password: PUBLIC_FEED_PASSWORD, realm: 'pili' }));
}

app.use(compress());

// SPA static assets
app.use('/assets/*', serveStatic({ root: './dist/client' }));

// Proxy feed API (GET only) to internal server
app.get('/api/feed', async (c) => {
  const url = new URL(c.req.url);
  url.protocol = 'http:';
  url.hostname = '127.0.0.1';
  url.port = String(Number.parseInt(process.env.PORT || '3013', 10) || 3013);
  try {
    const resp = await fetch(url.toString(), {
      headers: { 'accept': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await resp.text();
    return c.newResponse(body, resp.status as StatusCode, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    });
  } catch {
    return c.json({ ok: false, error: 'feed unavailable' }, 502);
  }
});

// Serve public-feed SPA
app.get('*', async (c) => {
  try {
    const html = await fs.promises.readFile(distIndexPath, 'utf8');
    return c.html(html);
  } catch {
    return c.text('not found', 404);
  }
});

serve({
  fetch: app.fetch,
  port: PUBLIC_PORT,
  hostname: '0.0.0.0',
}, () => {
  console.log(`[public-feed] http://0.0.0.0:${PUBLIC_PORT}/public-feed auth=${publicFeedCredentialsConfigured ? 'on' : 'DISABLED (fail-closed)'}`);
});