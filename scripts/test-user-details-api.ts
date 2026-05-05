import assert from 'node:assert/strict';

import { fetchUserDetails } from '@/lib/userDetailsApi';
import type { UserDetailsSuccessPayload } from '@/lib/userDetails';

function createSuccessPayload(): UserDetailsSuccessPayload {
  return {
    ok: true,
    user: {
      id: 'user 1',
      name: '详情用户',
      handle: 'detail-user',
      avatar: '',
      addresses: [
        {
          address: '0xabc',
          name: '主钱包',
          chain: 'bsc',
          totalAssetUsd: 12,
          assetUpdatedAt: 123,
        },
      ],
      totalAssetUsd: 0,
      historicalMaxAssetUsd: 0,
      assetUpdatedAt: null,
      tags: ['alpha'],
    },
    holdings: [
      {
        chain: 'bsc',
        tokenAddress: '0xusdt',
        symbol: 'USDT',
        name: 'Tether USD',
        balance: 1,
        priceUsd: 1,
        valueUsd: 1,
      },
    ],
    holdingsUpdatedAt: null,
    holdingsThresholdUsd: 5,
    holdingsSummary: {
      visibleCount: 0,
      partial: false,
      successfulAddressCount: 0,
      failedAddressCount: 0,
    },
  };
}

async function expectRejects(fn: () => Promise<unknown>, message: string) {
  await assert.rejects(fn, (error: unknown) => {
    assert.equal(error instanceof Error, true);
    assert.equal((error as Error).message, message);
    return true;
  });
}

async function run() {
  const originalFetch = globalThis.fetch;
  const capturedRequests: Array<{ url: string; init?: RequestInit }> = [];

  try {
    const successPayload = createSuccessPayload();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      capturedRequests.push({ url, init });

      return new Response(JSON.stringify(successPayload), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    }) as typeof fetch;

    const result = await fetchUserDetails('user 1');
    assert.deepEqual(result, successPayload);
    assert.equal(capturedRequests.length, 1);
    assert.equal(capturedRequests[0]?.url, '/api/users/user%201');
    assert.equal(capturedRequests[0]?.init?.cache, 'no-store');

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: '用户不存在' }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
        },
      })) as typeof fetch;

    await expectRejects(() => fetchUserDetails('missing-user'), '用户不存在');

    globalThis.fetch = (async () =>
      new Response('not-json', {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
        },
      })) as typeof fetch;

    await expectRejects(() => fetchUserDetails('bad-gateway-user'), 'HTTP 502');

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })) as typeof fetch;

    await expectRejects(() => fetchUserDetails('broken-user'), 'Malformed user details payload');

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ...successPayload,
          user: {
            ...successPayload.user,
            addresses: [{ bad: true }],
          },
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )) as typeof fetch;

    await expectRejects(() => fetchUserDetails('broken-addresses-user'), 'Malformed user details payload');

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ...successPayload,
          holdings: [
            {
              chain: 'bsc',
              tokenAddress: '0xusdt',
              symbol: 'USDT',
              name: 'Tether USD',
              balance: '1',
              priceUsd: 1,
              valueUsd: 1,
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )) as typeof fetch;

    await expectRejects(() => fetchUserDetails('broken-holdings-user'), 'Malformed user details payload');
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('user details api tests: ok');
}

void run();
