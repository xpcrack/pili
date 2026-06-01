import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

import type { Activity, User } from '@/types';

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
    id: 'xxyy-monitor:base:0xHashTrigger:1717178981000',
    userId: 'user-alpha',
    source: 'blockchain',
    type: 'transfer',
    content: '建仓100USDC',
    timestamp: 1_717_178_981_000,
    metadata: {
      chain: 'base',
      trackedAddress: '0xAbCdEf0000000000000000000000000000000001',
      tokenAddress: '0xPushTriggerAaA000000000000000000000000001',
      token: 'PUSH',
      txHash: '0xHashTrigger',
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

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-bid-feed-push-trigger-'));
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousUrl = process.env.BID_FEED_PUSH_URL;
  const previousSecret = process.env.INTERNAL_BID_HMAC_SECRET;
  const previousFetch = globalThis.fetch;

  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');
  process.env.BID_FEED_PUSH_URL = 'http://127.0.0.1:5000/api/internal/pilipili/feed-events';
  process.env.INTERNAL_BID_HMAC_SECRET = 'unit-test-internal-bid-secret-1234567890abcdef';

  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body || '{}')) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    const { upsertEventsFromFeedRows } = await import('../lib/server/eventsRepo');
    const { waitForBidFeedPushDrain } = await import('../lib/server/bidFeedPushNotifier');

    upsertEventsFromFeedRows([{ user: buildUser(), activity: buildActivity() }], 'telegram-monitor-ingest');
    await waitForBidFeedPushDrain();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'http://127.0.0.1:5000/api/internal/pilipili/feed-events');
    assert.equal(calls[0]?.body.events[0].tokenAddress, '0xPushTriggerAaA000000000000000000000000001');
    assert.equal(calls[0]?.body.trades[0].eventId, 'xxyy-monitor:base:0xHashTrigger:1717178981000');

    calls.length = 0;
    upsertEventsFromFeedRows([{ user: buildUser(), activity: buildActivity() }], 'feed-snapshot-upsert');
    await waitForBidFeedPushDrain();
    assert.equal(calls.length, 0);

    console.log('bid feed push trigger tests: ok');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDataDir === undefined) delete process.env.PILIPILI_DATA_DIR;
    else process.env.PILIPILI_DATA_DIR = previousDataDir;
    if (previousDbPath === undefined) delete process.env.PILIPILI_DB_PATH;
    else process.env.PILIPILI_DB_PATH = previousDbPath;
    if (previousUrl === undefined) delete process.env.BID_FEED_PUSH_URL;
    else process.env.BID_FEED_PUSH_URL = previousUrl;
    if (previousSecret === undefined) delete process.env.INTERNAL_BID_HMAC_SECRET;
    else process.env.INTERNAL_BID_HMAC_SECRET = previousSecret;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
