import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

import './server-only-shim.cjs';

interface WebhookCall {
  url: string;
  headers: Headers;
  body: {
    entity?: string;
    action?: string;
    userId?: string;
    address?: string;
  };
}

function createTempDbDir() {
  return mkdtempSync(path.join(tmpdir(), 'pilipili-bid-sync-route-'));
}

function makeRequest(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function withWebhook<T>(
  mode: 'success' | 'failure',
  callback: (calls: WebhookCall[]) => Promise<T>
) {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.BID2_SYNC_WEBHOOK_URL;
  const previousApiKey = process.env.BID2_SYNC_WEBHOOK_API_KEY;
  const calls: WebhookCall[] = [];

  process.env.BID2_SYNC_WEBHOOK_URL = 'https://bid2.example/sync';
  process.env.BID2_SYNC_WEBHOOK_API_KEY = 'bid2-secret';

  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body || '{}')) as WebhookCall['body'];
    calls.push({
      url: String(input),
      headers,
      body,
    });

    if (mode === 'failure') {
      return new Response('webhook failed', { status: 502 });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    return await callback(calls);
  } finally {
    globalThis.fetch = previousFetch;

    if (previousUrl === undefined) {
      delete process.env.BID2_SYNC_WEBHOOK_URL;
    } else {
      process.env.BID2_SYNC_WEBHOOK_URL = previousUrl;
    }

    if (previousApiKey === undefined) {
      delete process.env.BID2_SYNC_WEBHOOK_API_KEY;
    } else {
      process.env.BID2_SYNC_WEBHOOK_API_KEY = previousApiKey;
    }
  }
}

async function run() {
  const tempDir = createTempDbDir();
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;

  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const notifier = await import('../lib/server/bidSyncNotifier');
    const waitForBid2MirrorSyncDrain =
      'waitForBid2MirrorSyncDrain' in notifier && typeof notifier.waitForBid2MirrorSyncDrain === 'function'
        ? notifier.waitForBid2MirrorSyncDrain
        : async () => {};
    const usersRoute = await import('../app/api/users/route');
    const importRoute = await import('../app/api/users/import/route');
    const userRoute = await import('../app/api/users/[id]/route');
    const addressRoute = await import('../app/api/users/[id]/addresses/route');

    await withWebhook('success', async (calls) => {
      let releaseFetch: (() => void) | null = null;

      const previousFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const headers = new Headers(init?.headers);
        const body = JSON.parse(String(init?.body || '{}')) as WebhookCall['body'];
        calls.push({
          url: String(input),
          headers,
          body,
        });

        return new Promise<Response>((resolve) => {
          releaseFetch = () => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        });
      };

      const responsePromise = usersRoute.POST(
        makeRequest('http://localhost:3000/api/users', 'POST', {
          user: {
            name: 'Non Blocking User',
            handle: 'non-blocking-user',
            avatar: 'avatar.png',
            tags: [],
            addresses: [
              {
                address: 'Aqa8H5hmHe9MFY9sW6widbqEuaYv7q2KnRo25ApPhWhA',
                name: '#1',
                chain: 'solana',
              },
            ],
          },
        })
      );

      try {
        const observed = await Promise.race([
          responsePromise.then(() => 'resolved' as const),
          new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
        ]);

        assert.equal(observed, 'resolved');
        const response = await responsePromise;
        const payload = (await response.json()) as { ok: boolean; user: { id: string } };
        assert.equal(response.status, 200);
        assert.equal(payload.ok, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.body.action, 'created');
      } finally {
        globalThis.fetch = previousFetch;
        (releaseFetch ?? (() => {}))();
        await waitForBid2MirrorSyncDrain();
      }
    });

    await withWebhook('success', async (calls) => {
      const response = await usersRoute.POST(
        makeRequest('http://localhost:3000/api/users', 'POST', {
          user: {
            name: 'Create User',
            handle: 'create-user',
            avatar: 'avatar.png',
            tags: ['alpha'],
            addresses: [
              {
                address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
                name: '#1',
                chain: 'solana',
              },
            ],
          },
        })
      );
      const payload = (await response.json()) as { ok: boolean; user: { id: string } };
      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      await waitForBid2MirrorSyncDrain();
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.url, 'https://bid2.example/sync');
      assert.equal(calls[0]?.headers.get('x-api-key'), 'bid2-secret');
      assert.equal(calls[0]?.body.entity, 'user');
      assert.equal(calls[0]?.body.action, 'created');
      assert.equal(calls[0]?.body.userId, payload.user.id);
    });

    await withWebhook('success', async (calls) => {
      const response = await importRoute.POST(
        makeRequest('http://localhost:3000/api/users/import', 'POST', {
          users: [
            {
              name: 'Import User',
              handle: 'import-user',
              avatar: 'avatar.png',
              tags: [],
              addresses: [
                {
                  address: '0x1111111111111111111111111111111111111111',
                  name: '#1',
                  chain: 'bsc',
                },
              ],
            },
          ],
        })
      );
      const payload = (await response.json()) as { ok: boolean; importedCount: number };
      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      assert.equal(payload.importedCount, 1);
      await waitForBid2MirrorSyncDrain();
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.body.entity, 'user');
      assert.equal(calls[0]?.body.action, 'imported');
    });

    const createdForMutation = await usersRoute.POST(
      makeRequest('http://localhost:3000/api/users', 'POST', {
        user: {
          name: 'Mutate User',
          handle: 'mutate-user',
          avatar: 'avatar.png',
          tags: [],
          addresses: [
            {
              address: '0x2222222222222222222222222222222222222222',
              name: '#1',
              chain: 'bsc',
            },
          ],
        },
      })
    );
    const createdMutationPayload = (await createdForMutation.json()) as { user: { id: string } };
    const targetUserId = createdMutationPayload.user.id;

    await withWebhook('success', async (calls) => {
      const response = await userRoute.PATCH(
        makeRequest(`http://localhost:3000/api/users/${targetUserId}`, 'PATCH', {
          name: 'Mutate User Renamed',
        }),
        { params: Promise.resolve({ id: targetUserId }) }
      );
      const payload = (await response.json()) as { ok: boolean; user: { name: string } };
      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      assert.equal(payload.user.name, 'Mutate User Renamed');
      await waitForBid2MirrorSyncDrain();
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.body.entity, 'user');
      assert.equal(calls[0]?.body.action, 'updated');
      assert.equal(calls[0]?.body.userId, targetUserId);
    });

    await withWebhook('success', async (calls) => {
      const response = await addressRoute.POST(
        makeRequest(`http://localhost:3000/api/users/${targetUserId}/addresses`, 'POST', {
          addresses: [
            {
              address: '0x3333333333333333333333333333333333333333',
              name: '#2',
              chain: 'ethereum',
            },
          ],
        }),
        { params: Promise.resolve({ id: targetUserId }) }
      );
      const payload = (await response.json()) as { ok: boolean; user: { addresses: Array<{ address: string }> } };
      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      assert.equal(payload.user.addresses.some((item) => item.address === '0x3333333333333333333333333333333333333333'), true);
      await waitForBid2MirrorSyncDrain();
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.body.entity, 'address');
      assert.equal(calls[0]?.body.action, 'created');
      assert.equal(calls[0]?.body.userId, targetUserId);
      assert.equal(calls[0]?.body.address, '0x3333333333333333333333333333333333333333');
    });

    await withWebhook('success', async (calls) => {
      const response = await addressRoute.DELETE(
        makeRequest(`http://localhost:3000/api/users/${targetUserId}/addresses`, 'DELETE', {
          address: '0x3333333333333333333333333333333333333333',
        }),
        { params: Promise.resolve({ id: targetUserId }) }
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      await waitForBid2MirrorSyncDrain();
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.body.entity, 'address');
      assert.equal(calls[0]?.body.action, 'deleted');
      assert.equal(calls[0]?.body.userId, targetUserId);
      assert.equal(calls[0]?.body.address, '0x3333333333333333333333333333333333333333');
    });

    await withWebhook('success', async (calls) => {
      const response = await userRoute.DELETE(
        makeRequest(`http://localhost:3000/api/users/${targetUserId}`, 'DELETE'),
        { params: Promise.resolve({ id: targetUserId }) }
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      await waitForBid2MirrorSyncDrain();
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.body.entity, 'user');
      assert.equal(calls[0]?.body.action, 'deleted');
      assert.equal(calls[0]?.body.userId, targetUserId);
    });

    const failureCreate = await withWebhook('failure', async (calls) => {
      const response = await usersRoute.POST(
        makeRequest('http://localhost:3000/api/users', 'POST', {
          user: {
            name: 'Failure Create',
            handle: 'failure-create',
            avatar: 'avatar.png',
            tags: [],
            addresses: [
              {
                address: 'E7Q6ZB3iC1cA6jFmJwG5s9LqKQ2Y6m1rjvW7c8D9e1F2',
                name: '#1',
                chain: 'solana',
              },
            ],
          },
        })
      );
      const payload = (await response.json()) as { ok: boolean; user: { id: string } };
      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      await waitForBid2MirrorSyncDrain();
      assert.equal(calls.length, 3);
      return payload.user.id;
    });

    await withWebhook('failure', async (calls) => {
      const response = await importRoute.POST(
        makeRequest('http://localhost:3000/api/users/import', 'POST', {
          users: [
            {
              name: 'Failure Import',
              handle: 'failure-import',
              avatar: 'avatar.png',
              tags: [],
              addresses: [
                {
                  address: '0x4444444444444444444444444444444444444444',
                  name: '#1',
                  chain: 'bsc',
                },
              ],
            },
          ],
        })
      );
      const payload = (await response.json()) as { ok: boolean; importedCount: number };
      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      assert.equal(payload.importedCount, 1);
      await waitForBid2MirrorSyncDrain();
      assert.equal(calls.length, 3);
    });

    const failureMutationUser = await usersRoute.POST(
      makeRequest('http://localhost:3000/api/users', 'POST', {
        user: {
          name: 'Failure Mutate',
          handle: 'failure-mutate',
          avatar: 'avatar.png',
          tags: [],
          addresses: [
            {
              address: '0x5555555555555555555555555555555555555555',
              name: '#1',
              chain: 'bsc',
            },
          ],
        },
      })
    );
    const failureMutationPayload = (await failureMutationUser.json()) as { user: { id: string } };
    const failureMutationUserId = failureMutationPayload.user.id;

    await withWebhook('failure', async (calls) => {
      const response = await userRoute.PATCH(
        makeRequest(`http://localhost:3000/api/users/${failureMutationUserId}`, 'PATCH', {
          name: 'Failure Mutate Patched',
        }),
        { params: Promise.resolve({ id: failureMutationUserId }) }
      );
      const payload = (await response.json()) as { ok: boolean; user: { name: string } };
      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      assert.equal(payload.user.name, 'Failure Mutate Patched');
      await waitForBid2MirrorSyncDrain();
      assert.equal(calls.length, 3);
    });

    await withWebhook('failure', async (calls) => {
      const response = await addressRoute.POST(
        makeRequest(`http://localhost:3000/api/users/${failureMutationUserId}/addresses`, 'POST', {
          addresses: [
            {
              address: '0x6666666666666666666666666666666666666666',
              name: '#2',
              chain: 'base',
            },
          ],
        }),
        { params: Promise.resolve({ id: failureMutationUserId }) }
      );
      const payload = (await response.json()) as { ok: boolean; user: { addresses: Array<{ address: string }> } };
      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      assert.equal(payload.user.addresses.some((item) => item.address === '0x6666666666666666666666666666666666666666'), true);
      await waitForBid2MirrorSyncDrain();
      assert.equal(calls.length, 3);
    });

    await withWebhook('failure', async (calls) => {
      const response = await addressRoute.DELETE(
        makeRequest(`http://localhost:3000/api/users/${failureMutationUserId}/addresses`, 'DELETE', {
          address: '0x6666666666666666666666666666666666666666',
          chain: 'base',
        }),
        { params: Promise.resolve({ id: failureMutationUserId }) }
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      await waitForBid2MirrorSyncDrain();
      assert.equal(calls.length, 3);
    });

    await withWebhook('failure', async (calls) => {
      const response = await userRoute.DELETE(
        makeRequest(`http://localhost:3000/api/users/${failureMutationUserId}`, 'DELETE'),
        { params: Promise.resolve({ id: failureMutationUserId }) }
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      await waitForBid2MirrorSyncDrain();
      assert.equal(calls.length, 3);
    });

    assert.equal(typeof failureCreate, 'string');

    console.log('bid sync route trigger tests: ok');
  } finally {
    if (previousDbPath === undefined) {
      delete process.env.PILIPILI_DB_PATH;
    } else {
      process.env.PILIPILI_DB_PATH = previousDbPath;
    }

    if (previousDataDir === undefined) {
      delete process.env.PILIPILI_DATA_DIR;
    } else {
      process.env.PILIPILI_DATA_DIR = previousDataDir;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
