import assert from 'node:assert/strict';

import { Hono } from 'hono';

import { registerApiRoutes } from '@/server/api';

async function main() {
  const app = new Hono();
  registerApiRoutes(app);

  const crossSite = await app.request('/api/feed/prewarm', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403, 'browser cross-site mutations must be rejected');

  const oversized = await app.request('/api/token-logo/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024 + 1) }),
  });
  assert.equal(oversized.status, 413, 'oversized JSON bodies must be rejected before route parsing');

  const normal = await app.request('/api/token-logo/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ items: [] }),
  });
  assert.equal(normal.status, 200, 'normal same-origin requests must remain compatible');

  console.log('API request guard tests: ok');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
