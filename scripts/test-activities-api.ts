import assert from 'node:assert/strict';

import { fetchAllActivities } from '@/lib/activitiesApi';

async function run() {
  const originalFetch = globalThis.fetch;
  let capturedUrl: URL | null = null;
  let capturedMethod = 'GET';

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    capturedUrl = new URL(rawUrl, 'http://localhost');
    capturedMethod = init?.method || (input instanceof Request ? input.method : 'GET');

    return new Response(
      JSON.stringify({
        ok: true,
        feed: [],
        users: [
          {
            id: 'server-user-1',
            name: 'Server User',
            handle: 'server-user',
            avatar: '',
            addresses: [],
            totalAssetUsd: 0,
            historicalMaxAssetUsd: 0,
            assetUpdatedAt: null,
            tags: [],
          },
        ],
        total: 0,
        page: 1,
        pageSize: 25,
        hasMore: false,
        nextCursor: 'next-cursor-1',
        historyComplete: null,
        localQualifiedCount: 0,
        activityBreakdown: null,
        completenessWindow: null,
        latestActivityAtByUser: {},
        diagnostics: [],
        summary: {
          userCount: 0,
          addressCount: 0,
          transactionCount: 0,
          successfulAddressCount: 0,
          failedAddressCount: 0,
          emptyAddressCount: 0,
          completedAt: 0,
        },
        addressAssets: [],
        userAssets: [],
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  }) as typeof fetch;

  try {
    await fetchAllActivities([], {
      pageSize: 25,
      syncStrategy: 'local',
      source: 'telegram',
    } as never);

    assert.equal(capturedMethod, 'GET', 'local reads should use GET requests');
    const firstCapturedUrl = capturedUrl as URL | null;
    if (!firstCapturedUrl) {
      throw new Error('fetch should be invoked');
    }
    assert.equal(firstCapturedUrl.pathname, '/api/feed');
    assert.equal(
      firstCapturedUrl.searchParams.get('source'),
      'telegram',
      'activities API should forward remote source filters to the feed endpoint'
    );

    capturedUrl = null;
    const paged = await fetchAllActivities([], {
      pageSize: 25,
      syncStrategy: 'local',
      source: 'telegram',
      cursor: 'cursor-123',
    } as never);
    const secondCapturedUrl = capturedUrl as URL | null;
    if (!secondCapturedUrl) {
      throw new Error('fetch should be invoked for cursor requests');
    }
    assert.equal(
      secondCapturedUrl.searchParams.get('cursor'),
      'cursor-123',
      'activities API should forward feed cursors to the endpoint'
    );
    assert.equal(
      paged.nextCursor,
      'next-cursor-1',
      'activities API should preserve nextCursor from the endpoint response'
    );
    assert.equal(Array.isArray(paged.users), true, 'activities API should preserve users from the feed payload');
    assert.equal(paged.users?.[0]?.id, 'server-user-1');
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('activities api tests: ok');
}

void run();
