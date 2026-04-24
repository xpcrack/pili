import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Activity, User } from '@/types';

import './server-only-shim.cjs';

function makeUser(): User {
  return {
    id: 'events-upsert-user',
    name: 'Events Upsert User',
    handle: 'events-upsert-user',
    avatar: '',
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
    tags: [],
  };
}

function makeActivity(tradeAmountUsdAtTx?: number): Activity {
  return {
    id: 'events-upsert-activity',
    userId: 'events-upsert-user',
    source: 'blockchain',
    type: 'transfer',
    title: '买入资产',
    content: '买入 100 TEST，花费 1 BNB',
    timestamp: 1_710_000_000_000,
    metadata: {
      txHash: '0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed',
      value: '100',
      token: 'TEST',
      tokenAddress: '0xtesttoken',
      quoteToken: 'BNB',
      quoteAmount: '1',
      chain: 'bsc',
      txAction: 'buy',
      trackedAddress: '0x1111111111111111111111111111111111111111',
      tradeAmountUsdAtTx,
    },
  };
}

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-events-upsert-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { upsertEventsFromFeedRows, readEventsFeed } = await import('@/lib/server/eventsRepo');

    const user = makeUser();

    upsertEventsFromFeedRows(
      [
        {
          user,
          activity: makeActivity(600),
        },
      ],
      'test-events-upsert'
    );

    upsertEventsFromFeedRows(
      [
        {
          user,
          activity: makeActivity(undefined),
        },
      ],
      'test-events-upsert'
    );

    const rows = readEventsFeed({
      limit: 10,
      userId: user.id,
    });

    assert.equal(rows.total, 1, 'expected a single merged event');
    assert.equal(
      rows.feed[0]?.activity.metadata.tradeAmountUsdAtTx,
      600,
      'tradeAmountUsdAtTx should be preserved when an incoming refresh omits it'
    );

    console.log('events upsert tests: ok');
  } finally {
    if (typeof previousDbPath === 'string') {
      process.env.PILIPILI_DB_PATH = previousDbPath;
    } else {
      delete process.env.PILIPILI_DB_PATH;
    }
    if (typeof previousDataDir === 'string') {
      process.env.PILIPILI_DATA_DIR = previousDataDir;
    } else {
      delete process.env.PILIPILI_DATA_DIR;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
