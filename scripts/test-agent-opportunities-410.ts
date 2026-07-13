import assert from 'node:assert/strict';

import { Hono } from 'hono';

import { registerApiRoutes } from '@/server/api';

const AGENT_TOKEN = 'test-agent-token';

function createRuntimeApp() {
  const app = new Hono();
  registerApiRoutes(app);
  return app;
}

async function request(app: Hono, token?: string, query = '') {
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  return app.request(`/api/agent/opportunities${query}`, { headers });
}

async function run() {
  process.env.AGENT_API_TOKEN = AGENT_TOKEN;
  const app = createRuntimeApp();

  assert.equal((await request(app)).status, 401, 'missing token must remain unauthorized');
  assert.equal((await request(app, 'wrong-token')).status, 401, 'invalid token must remain unauthorized');

  const response = await request(app, AGENT_TOKEN);
  assert.equal(response.status, 410);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'gone',
    code: 'AGENT_OPPORTUNITIES_DISABLED',
    message: 'This API has been permanently disabled. No active callers were identified.',
  });

  const queryResponse = await request(app, AGENT_TOKEN, '?limit=10&minUsd=1000');
  assert.equal(queryResponse.status, 410, 'query parameters must not bypass the disabled route');

  console.log('agent-opportunities-410 runtime route tests: ok');
}

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
