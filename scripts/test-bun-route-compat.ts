import assert from 'node:assert/strict';

import { NextRequest } from 'next/server';

async function run() {
  const usersRoute = await import('../app/api/users/route');
  const feedRoute = await import('../app/api/feed/route');

  const usersResponse = await usersRoute.GET();
  assert.equal(usersResponse.status, 200, 'users route should respond under Bun runtime');
  const usersPayload = (await usersResponse.json()) as { ok?: boolean; users?: unknown[] };
  assert.equal(usersPayload.ok, true);
  assert.ok(Array.isArray(usersPayload.users), 'users payload should include users array');

  const feedResponse = await feedRoute.GET(
    new NextRequest('http://127.0.0.1:3005/api/feed?page=1&pageSize=1')
  );
  assert.equal(feedResponse.status, 200, 'feed route should respond under Bun runtime');
  const feedPayload = (await feedResponse.json()) as { ok?: boolean; feed?: unknown[] };
  assert.equal(feedPayload.ok, true);
  assert.ok(Array.isArray(feedPayload.feed), 'feed payload should include feed array');

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
