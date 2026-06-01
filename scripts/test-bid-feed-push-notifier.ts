import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import type { Activity, User } from '@/types';

type EnvOverrides = {
  BID_FEED_PUSH_URL?: string | undefined;
  INTERNAL_BID_HMAC_SECRET?: string | undefined;
};

async function withEnv<T>(overrides: EnvOverrides, callback: () => Promise<T>) {
  const previousUrl = process.env.BID_FEED_PUSH_URL;
  const previousSecret = process.env.INTERNAL_BID_HMAC_SECRET;

  if (overrides.BID_FEED_PUSH_URL === undefined) delete process.env.BID_FEED_PUSH_URL;
  else process.env.BID_FEED_PUSH_URL = overrides.BID_FEED_PUSH_URL;

  if (overrides.INTERNAL_BID_HMAC_SECRET === undefined) delete process.env.INTERNAL_BID_HMAC_SECRET;
  else process.env.INTERNAL_BID_HMAC_SECRET = overrides.INTERNAL_BID_HMAC_SECRET;

  try {
    return await callback();
  } finally {
    if (previousUrl === undefined) delete process.env.BID_FEED_PUSH_URL;
    else process.env.BID_FEED_PUSH_URL = previousUrl;

    if (previousSecret === undefined) delete process.env.INTERNAL_BID_HMAC_SECRET;
    else process.env.INTERNAL_BID_HMAC_SECRET = previousSecret;
  }
}

function buildUser(): User {
  return {
    id: 'user-alpha',
    name: '光源',
    handle: 'alpha',
    avatar: '',
    addresses: [{
      address: '0xAbCdEf0000000000000000000000000000000001',
      chain: 'base',
      name: '主钱包',
      totalAssetUsd: null,
      assetUpdatedAt: null,
    }],
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
  };
}

function buildActivity(): Activity {
  return {
    id: 'xxyy-monitor:base:0xHashAaA:1717178981000',
    userId: 'user-alpha',
    source: 'blockchain',
    type: 'transfer',
    content: '建仓100USDC',
    timestamp: 1_717_178_981_000,
    metadata: {
      chain: 'base',
      trackedAddress: '0xAbCdEf0000000000000000000000000000000001',
      tokenAddress: '0xPushTokenAaA000000000000000000000000000001',
      token: 'PUSH',
      txHash: '0xHashAaA',
      txAction: 'buy',
      txActionVariant: 'open',
      txActionLabel: '建仓',
      value: '250',
      quoteAmount: '100',
      quoteToken: 'USDC',
      tradeAmountUsdAtTx: 100,
      marketCapAtTxUsd: 123456,
      monitorWalletAliasLabel: '光源主钱包',
      monitorWalletGroupLabel: '光源',
    },
  };
}

function decodeB64Url(value: string) {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

async function run() {
  const {
    buildBidFeedPushPayload,
    notifyBidFeedPush,
  } = await import('../lib/server/bidFeedPushNotifier');

  const payload = buildBidFeedPushPayload([{ user: buildUser(), activity: buildActivity() }]);
  assert.equal(payload.events.length, 1);
  assert.equal(payload.trades.length, 1);
  assert.equal(payload.events[0]?.tokenAddress, '0xPushTokenAaA000000000000000000000000000001');
  assert.equal(payload.events[0]?.userName, '光源');
  assert.equal(payload.events[0]?.sourceAddressName, '主钱包');
  assert.equal(payload.trades[0]?.tokenAddress, '0xPushTokenAaA000000000000000000000000000001');
  assert.equal(payload.trades[0]?.trackedWalletAddressRaw, '0xAbCdEf0000000000000000000000000000000001');

  await withEnv(
    {
      BID_FEED_PUSH_URL: undefined,
      INTERNAL_BID_HMAC_SECRET: undefined,
    },
    async () => {
      let fetchCalls = 0;
      const result = await notifyBidFeedPush([{ user: buildUser(), activity: buildActivity() }], {
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        sleep: async () => {},
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'skipped-missing-config');
      assert.equal(result.attempts, 0);
      assert.equal(fetchCalls, 0);
    }
  );

  await withEnv(
    {
      BID_FEED_PUSH_URL: 'http://127.0.0.1:5000/api/internal/pilipili/feed-events',
      INTERNAL_BID_HMAC_SECRET: 'unit-test-internal-bid-secret-1234567890abcdef',
    },
    async () => {
      const calls: Array<{ url: string; headers: Headers; body: any }> = [];
      const result = await notifyBidFeedPush([{ user: buildUser(), activity: buildActivity() }], {
        fetchImpl: async (input, init) => {
          calls.push({
            url: String(input),
            headers: new Headers(init?.headers),
            body: JSON.parse(String(init?.body || '{}')),
          });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        sleep: async () => {},
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, 'sent');
      assert.equal(result.attempts, 1);
      assert.equal(calls[0]?.url, 'http://127.0.0.1:5000/api/internal/pilipili/feed-events');
      assert.equal(calls[0]?.headers.get('content-type'), 'application/json');
      const auth = calls[0]?.headers.get('authorization') || '';
      assert.match(auth, /^Bearer /);
      const payloadB64 = auth.slice('Bearer '.length).split('.')[0] || '';
      const tokenPayload = JSON.parse(decodeB64Url(payloadB64).toString('utf8'));
      assert.equal(tokenPayload.scope, 'internal:bid:write');
      assert.equal(calls[0]?.body.events[0].tokenAddress, '0xPushTokenAaA000000000000000000000000000001');
    }
  );

  await withEnv(
    {
      BID_FEED_PUSH_URL: 'http://127.0.0.1:5000/api/internal/pilipili/feed-events',
      INTERNAL_BID_HMAC_SECRET: 'unit-test-internal-bid-secret-1234567890abcdef',
    },
    async () => {
      const sleeps: number[] = [];
      let attempt = 0;
      const result = await notifyBidFeedPush([{ user: buildUser(), activity: buildActivity() }], {
        fetchImpl: async () => {
          attempt += 1;
          if (attempt === 1) throw new Error('temporary network error');
          if (attempt === 2) return new Response('bad gateway', { status: 502 });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        log: () => {},
      });

      assert.equal(result.ok, true);
      assert.equal(result.attempts, 3);
      assert.deepEqual(sleeps, [200, 400]);
    }
  );

  console.log('bid feed push notifier tests: ok');
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
