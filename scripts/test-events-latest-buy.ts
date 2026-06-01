import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Activity } from '@/types';

import './server-only-shim.cjs';

function makeTradeActivity(params: {
  action: 'buy' | 'sell';
  txHash: string;
  timestamp: number;
  trackedAddress: string;
  tokenAddress: string;
}): Activity {
  return {
    id: `${params.action}:${params.txHash}`,
    userId: 'temp-user',
    source: 'blockchain',
    type: 'transfer',
    title: params.action === 'buy' ? '买入资产' : '卖出资产',
    content: params.action === 'buy' ? '买入资产' : '卖出资产',
    timestamp: params.timestamp,
    metadata: {
      txHash: params.txHash,
      chain: 'bsc',
      txAction: params.action,
      trackedAddress: params.trackedAddress,
      tokenAddress: params.tokenAddress,
      token: 'TEST',
    },
  };
}

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-events-latest-buy-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { createTrackedUser } = await import('@/lib/server/trackedUsersRepo');
    const { upsertEventsFromFeedRows, readLatestBuyAtByToken } = await import('@/lib/server/eventsRepo');

    const tokenAddress = '0xaaaa000000000000000000000000000000000001';
    const otherTokenAddress = '0xbbbb000000000000000000000000000000000002';

    const userA = createTrackedUser({
      name: 'A',
      handle: 'a',
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
    const userB = createTrackedUser({
      name: 'B',
      handle: 'b',
      avatar: '',
      tags: [],
      addresses: [
        {
          address: '0x2222222222222222222222222222222222222222',
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

    upsertEventsFromFeedRows(
      [
        {
          user: userA,
          activity: makeTradeActivity({
            action: 'buy',
            txHash: '0x1',
            timestamp: 1_000,
            trackedAddress: userA.addresses[0]!.address,
            tokenAddress,
          }),
        },
      ],
      'test'
    );
    upsertEventsFromFeedRows(
      [
        {
          user: userB,
          activity: makeTradeActivity({
            action: 'buy',
            txHash: '0x2',
            timestamp: 2_500,
            trackedAddress: userB.addresses[0]!.address,
            tokenAddress,
          }),
        },
      ],
      'test'
    );
    upsertEventsFromFeedRows(
      [
        {
          user: userA,
          activity: makeTradeActivity({
            action: 'sell',
            txHash: '0x3',
            timestamp: 4_000,
            trackedAddress: userA.addresses[0]!.address,
            tokenAddress,
          }),
        },
      ],
      'test'
    );
    upsertEventsFromFeedRows(
      [
        {
          user: userA,
          activity: makeTradeActivity({
            action: 'buy',
            txHash: '0x4',
            timestamp: 3_000,
            trackedAddress: userA.addresses[0]!.address,
            tokenAddress: otherTokenAddress,
          }),
        },
      ],
      'test'
    );

    const result = readLatestBuyAtByToken([
      { chain: 'bsc', contractAddress: tokenAddress.toUpperCase() },
      { chain: 'bsc', contractAddress: otherTokenAddress },
      { chain: 'ethereum', contractAddress: tokenAddress },
    ]);

    assert.equal(result.get('bsc:0xaaaa000000000000000000000000000000000001'), 2_500);
    assert.equal(result.get('bsc:0xbbbb000000000000000000000000000000000002'), 3_000);
    assert.equal(result.has('ethereum:0xaaaa000000000000000000000000000000000001'), false);

    console.log('events latest buy tests: ok');
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

void run();
