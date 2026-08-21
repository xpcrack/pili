import assert from 'node:assert/strict';

import { Hono } from 'hono';
import { NextRequest } from '@/lib/server/httpCompat';

import {
  _resetInternalBidAuthCacheForTest,
  signInternalBidToken,
} from '../lib/server/internalBidAuth';
import { registerApiRoutes } from '../server/api';

async function run() {
  const feedRoute = await import('../app/api/feed/route');


  const feedResponse = await feedRoute.GET(
    new NextRequest('http://127.0.0.1:3005/api/feed?page=1&pageSize=1')
  );
  assert.equal(feedResponse.status, 200, 'feed route should respond under Bun runtime');
  const feedPayload = (await feedResponse.json()) as { ok?: boolean; feed?: unknown[] };
  assert.equal(feedPayload.ok, true);
  assert.ok(Array.isArray(feedPayload.feed), 'feed payload should include feed array');

  const env = process.env as Record<string, string | undefined>;
  const previousNodeEnv = env.NODE_ENV;
  const previousSecret = env.INTERNAL_BID_HMAC_SECRET;
  const previousAllowedIps = env.INTERNAL_BID_ALLOWED_IPS;
  env.NODE_ENV = 'test';
  env.INTERNAL_BID_HMAC_SECRET = 'bun-route-compat-internal-bid-secret-1234567890abcdef';
  delete env.INTERNAL_BID_ALLOWED_IPS;
  _resetInternalBidAuthCacheForTest();

  try {
    const app = new Hono();
    registerApiRoutes(app);

    for (const path of [
      '/api/internal/bid/users',
      '/api/internal/bid/trades',
      '/api/internal/bid/onchain-events',
    ]) {
      const unauthorized = await app.request(path);
      assert.equal(unauthorized.status, 401, `${path} should be registered and require auth`);

      const authorized = await app.request(path, {
        headers: { authorization: `Bearer ${signInternalBidToken()}` },
      });
      assert.equal(authorized.status, 200, `${path} should respond with valid auth`);
      const payload = (await authorized.json()) as { ok?: boolean };
      assert.equal(payload.ok, true, `${path} should preserve its JSON contract`);
    }
  } finally {
    if (previousNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = previousNodeEnv;
    if (previousSecret === undefined) delete env.INTERNAL_BID_HMAC_SECRET;
    else env.INTERNAL_BID_HMAC_SECRET = previousSecret;
    if (previousAllowedIps === undefined) delete env.INTERNAL_BID_ALLOWED_IPS;
    else env.INTERNAL_BID_ALLOWED_IPS = previousAllowedIps;
    _resetInternalBidAuthCacheForTest();
  }

  console.log('bun route compatibility tests: ok');
}

const keepAlive = setInterval(() => {}, 1_000);

run()
  .then(() => {
    clearInterval(keepAlive);
  })
  .catch((error) => {
    clearInterval(keepAlive);
    console.error(error);
    process.exitCode = 1;
  });
