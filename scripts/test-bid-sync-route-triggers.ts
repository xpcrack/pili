import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from '@/lib/server/httpCompat';

import './server-only-shim.cjs';

interface WebhookCall {
  url: string;
  headers: Headers;
  body: {
    entity?: string;
    action?: string;
    userId?: string;
  };
}

function createTempDbDir() {
  return mkdtempSync(path.join(tmpdir(), 'pilipili-bid-sync-route-'));
}

function makeRequest(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers:
      body === undefined
        ? undefined
        : { 'content-type': 'application/json', 'x-admin-token': 'test-admin-token' },
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

    if (mode === 'success') {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response('boom', { status: 500 });
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
  // admin auth 现为 fail-closed（默认拒绝无 token 请求），测试显式配置 token
  const previousAdminToken = process.env.ADMIN_API_TOKEN;
  process.env.ADMIN_API_TOKEN = 'test-admin-token';

  try {
    const notifier = await import('../lib/server/bidSyncNotifier');
    const waitForBid2MirrorSyncDrain =
      'waitForBid2MirrorSyncDrain' in notifier && typeof notifier.waitForBid2MirrorSyncDrain === 'function'
        ? notifier.waitForBid2MirrorSyncDrain
        : async () => {};
    const importRoute = await import('../app/api/users/import/route');

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
      assert.equal(calls[0]?.url, 'https://bid2.example/sync');
      assert.equal(calls[0]?.headers.get('x-api-key'), 'bid2-secret');
      assert.equal(calls[0]?.body.entity, 'user');
      assert.equal(calls[0]?.body.action, 'imported');
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

    if (previousAdminToken === undefined) {
      delete process.env.ADMIN_API_TOKEN;
    } else {
      process.env.ADMIN_API_TOKEN = previousAdminToken;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
