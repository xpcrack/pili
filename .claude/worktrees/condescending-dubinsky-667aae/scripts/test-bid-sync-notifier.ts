import assert from 'node:assert/strict';

import './server-only-shim.cjs';

type EnvOverrides = {
  BID2_SYNC_WEBHOOK_URL?: string | undefined;
  BID2_SYNC_WEBHOOK_API_KEY?: string | undefined;
};

async function withEnv<T>(overrides: EnvOverrides, callback: () => Promise<T>) {
  const previousUrl = process.env.BID2_SYNC_WEBHOOK_URL;
  const previousApiKey = process.env.BID2_SYNC_WEBHOOK_API_KEY;

  if (overrides.BID2_SYNC_WEBHOOK_URL === undefined) {
    delete process.env.BID2_SYNC_WEBHOOK_URL;
  } else {
    process.env.BID2_SYNC_WEBHOOK_URL = overrides.BID2_SYNC_WEBHOOK_URL;
  }

  if (overrides.BID2_SYNC_WEBHOOK_API_KEY === undefined) {
    delete process.env.BID2_SYNC_WEBHOOK_API_KEY;
  } else {
    process.env.BID2_SYNC_WEBHOOK_API_KEY = overrides.BID2_SYNC_WEBHOOK_API_KEY;
  }

  try {
    return await callback();
  } finally {
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
  const { notifyBid2MirrorSync } = await import('../lib/server/bidSyncNotifier');

  await withEnv(
    {
      BID2_SYNC_WEBHOOK_URL: undefined,
      BID2_SYNC_WEBHOOK_API_KEY: undefined,
    },
    async () => {
      let fetchCalls = 0;
      const result = await notifyBid2MirrorSync(
        {
          entity: 'user',
          action: 'created',
          userId: 'user-missing-env',
        },
        {
          fetchImpl: async () => {
            fetchCalls += 1;
            return new Response(null, { status: 200 });
          },
          sleep: async () => {},
        }
      );

      assert.equal(result.ok, false);
      assert.equal(result.status, 'skipped-missing-config');
      assert.equal(result.attempts, 0);
      assert.equal(fetchCalls, 0);
    }
  );

  await withEnv(
    {
      BID2_SYNC_WEBHOOK_URL: 'https://bid2.example/sync',
      BID2_SYNC_WEBHOOK_API_KEY: 'bid2-secret',
    },
    async () => {
      const calls: Array<{
        url: string;
        method: string | undefined;
        headers: Headers;
        body: string;
      }> = [];

      const result = await notifyBid2MirrorSync(
        {
          entity: 'address',
          action: 'deleted',
          userId: 'user-success',
          address: '0xabc',
        },
        {
          fetchImpl: async (input, init) => {
            calls.push({
              url: String(input),
              method: init?.method,
              headers: new Headers(init?.headers),
              body: String(init?.body || ''),
            });
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
          sleep: async () => {},
        }
      );

      assert.equal(result.ok, true);
      assert.equal(result.status, 'sent');
      assert.equal(result.attempts, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.url, 'https://bid2.example/sync');
      assert.equal(calls[0]?.method, 'POST');
      assert.equal(calls[0]?.headers.get('content-type'), 'application/json');
      assert.equal(calls[0]?.headers.get('x-api-key'), 'bid2-secret');

      const body = JSON.parse(calls[0]?.body || '{}') as {
        entity?: string;
        action?: string;
        userId?: string;
        address?: string;
      };
      assert.equal(body.entity, 'address');
      assert.equal(body.action, 'deleted');
      assert.equal(body.userId, 'user-success');
      assert.equal(body.address, '0xabc');
    }
  );

  await withEnv(
    {
      BID2_SYNC_WEBHOOK_URL: 'https://bid2.example/sync',
      BID2_SYNC_WEBHOOK_API_KEY: 'bid2-secret',
    },
    async () => {
      const sleeps: number[] = [];
      const logLines: string[] = [];
      let attempt = 0;

      const result = await notifyBid2MirrorSync(
        {
          entity: 'user',
          action: 'updated',
          userId: 'user-retry',
        },
        {
          fetchImpl: async () => {
            attempt += 1;
            if (attempt === 1) {
              throw new Error('temporary network error');
            }
            if (attempt === 2) {
              return new Response('bad gateway', { status: 502 });
            }
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          log: (message, meta) => {
            logLines.push(`${message}:${JSON.stringify(meta)}`);
          },
        }
      );

      assert.equal(result.ok, true);
      assert.equal(result.status, 'sent');
      assert.equal(result.attempts, 3);
      assert.deepEqual(sleeps, [200, 400]);
      assert.equal(logLines.length >= 2, true);
    }
  );

  await withEnv(
    {
      BID2_SYNC_WEBHOOK_URL: 'https://bid2.example/sync',
      BID2_SYNC_WEBHOOK_API_KEY: 'bid2-secret',
    },
    async () => {
      const logLines: string[] = [];
      let releaseFetch: (() => void) | null = null;

      const resultPromise = notifyBid2MirrorSync(
        {
          entity: 'user',
          action: 'updated',
          userId: 'user-timeout',
        },
        {
          fetchImpl: async (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              const onAbort = () => {
                reject(init?.signal?.reason || new Error('aborted'));
              };
              init?.signal?.addEventListener('abort', onAbort, { once: true });
              releaseFetch = () => {
                init?.signal?.removeEventListener('abort', onAbort);
                reject(new Error('released manually'));
              };
            }),
          sleep: async () => {},
          log: (message, meta) => {
            logLines.push(`${message}:${JSON.stringify(meta)}`);
          },
          maxAttempts: 1,
          attemptTimeoutMs: 10,
        }
      );

      try {
        const observed = await Promise.race([
          resultPromise.then((result) => result.status),
          new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
        ]);

        assert.notEqual(observed, 'timed-out');
        assert.equal(observed, 'failed');
      } finally {
        (releaseFetch ?? (() => {}))();
        await resultPromise.catch(() => null);
      }

      assert.equal(logLines.length >= 1, true);
    }
  );

  await withEnv(
    {
      BID2_SYNC_WEBHOOK_URL: 'https://bid2.example/sync',
      BID2_SYNC_WEBHOOK_API_KEY: 'bid2-secret',
    },
    async () => {
      const sleeps: number[] = [];
      const logLines: string[] = [];

      const result = await notifyBid2MirrorSync(
        {
          entity: 'user',
          action: 'imported',
          userId: 'user-fail',
        },
        {
          fetchImpl: async () => new Response('server error', { status: 500 }),
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          log: (message, meta) => {
            logLines.push(`${message}:${JSON.stringify(meta)}`);
          },
        }
      );

      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.equal(result.attempts, 3);
      assert.deepEqual(sleeps, [200, 400]);
      assert.equal(logLines.length >= 3, true);
      assert.match(result.error || '', /500|server error/i);
    }
  );

  console.log('bid sync notifier tests: ok');
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
