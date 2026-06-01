import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';

import './server-only-shim.cjs';

function makeDexScreenerResponse(address: string) {
  return {
    schemaVersion: '1.0.0',
    pairs: [
      {
        chainId: 'bsc',
        pairAddress: '0xpair',
        baseToken: {
          address,
          name: 'Token One',
          symbol: 'ONE',
        },
        quoteToken: {
          address: '0xwbnb',
          name: 'Wrapped BNB',
          symbol: 'WBNB',
        },
        priceUsd: '1.23',
        priceChange: { m5: 0, h1: 0, h6: 0, h24: 2.34 },
        liquidity: { usd: 1234 },
        volume: { m5: 0, h1: 0, h6: 0, h24: 0 },
        fdv: 1000,
        marketCap: 2000,
        pairCreatedAt: 0,
      },
    ],
  };
}

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-tokens-api-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  const originalFetch = globalThis.fetch;

  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  globalThis.fetch = (async (input: string | URL | Request) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, 'http://localhost');

    if (url.pathname.startsWith('/latest/dex/tokens/')) {
      return new Response(JSON.stringify(makeDexScreenerResponse('0xaaaa000000000000000000000000000000000001')), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`unexpected fetch: ${url.toString()}`);
  }) as typeof fetch;

  try {
    const { createTrackedUser } = await import('@/lib/server/trackedUsersRepo');
    const { addToken } = await import('@/lib/server/tokensRepo');
    const { upsertEventsFromFeedRows } = await import('@/lib/server/eventsRepo');
    const route = await import('../app/api/tokens/route');

    const user = createTrackedUser({
      name: 'Token Tester',
      handle: 'token-tester',
      avatar: '',
      tags: [],
      addresses: [
        {
          address: '0x1111111111111111111111111111111111111111',
          name: '#1',
          chain: 'bsc',
          totalAssetUsd: null,
          assetUpdatedAt: null,
        },
      ],
      totalAssetUsd: 0,
      historicalMaxAssetUsd: 0,
      assetUpdatedAt: null,
      twitter: undefined,
      telegram: undefined,
    });

    addToken('bsc', '0xaaaa000000000000000000000000000000000001', ['alpha']);
    addToken('bsc', '0xbbbb000000000000000000000000000000000002', ['beta']);

    upsertEventsFromFeedRows(
      [
        {
          user,
          activity: {
            id: 'buy-1',
            userId: user.id,
            source: 'blockchain',
            type: 'transfer',
            title: '买入资产',
            content: '买入资产',
            timestamp: 1_000,
            metadata: {
              txHash: '0x1',
              chain: 'bsc',
              txAction: 'buy',
              trackedAddress: user.addresses[0]!.address,
              tokenAddress: '0xaaaa000000000000000000000000000000000001',
              token: 'ONE',
            },
          },
        },
        {
          user,
          activity: {
            id: 'buy-2',
            userId: user.id,
            source: 'blockchain',
            type: 'transfer',
            title: '买入资产',
            content: '买入资产',
            timestamp: 2_000,
            metadata: {
              txHash: '0x2',
              chain: 'bsc',
              txAction: 'buy',
              trackedAddress: user.addresses[0]!.address,
              tokenAddress: '0xaaaa000000000000000000000000000000000001',
              token: 'ONE',
            },
          },
        },
      ],
      'test'
    );

    const response = await route.GET(new NextRequest('http://localhost/api/tokens'));
    assert.equal(response.status, 200);

    const payload = (await response.json()) as {
      items: Array<{
        chain: string;
        contract_address: string;
        price: number | null;
        last_buy_at: number | null;
      }>;
    };

    const first = payload.items.find((item) => item.contract_address === '0xaaaa000000000000000000000000000000000001');
    const second = payload.items.find((item) => item.contract_address === '0xbbbb000000000000000000000000000000000002');

    assert.equal(first?.price, 1.23);
    assert.equal(first?.last_buy_at, 2_000);
    assert.equal(second?.last_buy_at, null);

    console.log('tokens api tests: ok');
  } finally {
    globalThis.fetch = originalFetch;

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

void run();
