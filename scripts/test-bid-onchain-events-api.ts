import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';

import './server-only-shim.cjs';

function createTempDbDir() {
  return mkdtempSync(path.join(tmpdir(), 'pilipili-bid-onchain-events-api-'));
}

function buildEventInput(params: {
  messageId: number;
  chain: string;
  tokenAddress: string;
  trackedWalletAddress: string;
  eventTimeMs: number;
  actionVariant: 'open' | 'add' | 'reduce' | 'close' | 'send';
  walletAliasLabel: string;
}) {
  return {
    provider: 'xxyy' as const,
    sourceChatId: '-100123456',
    sourceMessageId: params.messageId,
    chain: params.chain,
    tokenAddress: params.tokenAddress,
    tokenSymbol: 'AAA',
    txHash: `0xhash${params.messageId}`,
    marketCapUsd: 123456 + params.messageId,
    quoteAmount: 1 + params.messageId,
    quoteSymbol: 'SOL',
    action: params.actionVariant === 'reduce' || params.actionVariant === 'close' ? 'sell' : 'buy',
    actionLabel:
      params.actionVariant === 'open'
        ? '建仓'
        : params.actionVariant === 'add'
          ? '加仓'
          : params.actionVariant === 'reduce'
            ? '减仓'
            : params.actionVariant === 'close'
              ? '清仓'
              : '发送',
    actionVariant: params.actionVariant,
    walletLabel: 'Alpha Wallet',
    walletGroupLabel: 'Alpha',
    walletAliasLabel: params.walletAliasLabel,
    trackedWalletAddress: params.trackedWalletAddress,
    eventTimeMs: params.eventTimeMs,
    rawText: `event-${params.messageId}`,
    messageLinks: [`https://xxyy.test/${params.messageId}`],
    payload: { messageId: params.messageId },
  };
}

async function run() {
  const tempDir = createTempDbDir();
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  const previousHmacSecret = process.env.INTERNAL_BID_HMAC_SECRET;

  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');
  process.env.INTERNAL_BID_HMAC_SECRET = 'pili-bid-onchain-events-test-internal-bid-secret-1234567890abcdef';

  try {
    const { createTrackedUser } = await import('@/lib/server/trackedUsersRepo');
    const { upsertTelegramMonitorEvent } = await import('@/lib/server/telegramMonitorRepo');
    const { signInternalBidToken } = await import('@/lib/server/internalBidAuth');
    const route = await import('../app/api/internal/bid/onchain-events/route');

    const authHeader = () => `Bearer ${signInternalBidToken()}`;

    const alpha = createTrackedUser({
      name: 'Alpha',
      handle: 'alpha',
      avatar: 'alpha.png',
      tags: [],
      addresses: [
        {
          address: '0xAbCdEf0000000000000000000000000000000001',
          name: '#1',
          chain: 'base',
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

    createTrackedUser({
      name: 'Beta',
      handle: 'beta',
      avatar: 'beta.png',
      tags: [],
      addresses: [
        {
          address: '0x9999999999999999999999999999999999999999',
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

    upsertTelegramMonitorEvent(
      buildEventInput({
        messageId: 1001,
        chain: 'base',
        tokenAddress: '0xTokenAAA',
        trackedWalletAddress: '0xAbCdEf0000000000000000000000000000000001',
        eventTimeMs: 1_717_178_981_000,
        actionVariant: 'open',
        walletAliasLabel: 'alpha#1',
      })
    );
    upsertTelegramMonitorEvent(
      buildEventInput({
        messageId: 1002,
        chain: 'bsc',
        tokenAddress: '0xTokenBBB',
        trackedWalletAddress: '0x9999999999999999999999999999999999999999',
        eventTimeMs: 1_717_178_982_000,
        actionVariant: 'add',
        walletAliasLabel: 'beta#1',
      })
    );

    const unauthorized = await route.GET(new NextRequest('http://localhost:3005/api/internal/bid/onchain-events'));
    assert.equal(unauthorized.status, 401);

    const response = await route.GET(
      new NextRequest(
        `http://localhost:3005/api/internal/bid/onchain-events?userIds=${alpha.id}&limit=1&fromMs=1717178980000&toMs=1717178985000`,
        {
          headers: {
            authorization: authHeader(),
          },
        }
      )
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.events.length, 1);
    assert.equal(payload.events[0].userId, alpha.id);
    assert.equal(payload.events[0].trackedWalletAddress, '0xAbCdEf0000000000000000000000000000000001');
    assert.equal(payload.events[0].trackedWalletAddressRaw, '0xAbCdEf0000000000000000000000000000000001');
    assert.equal(payload.events[0].tokenAddress, '0xTokenAAA');
    assert.equal(payload.events[0].actionVariant, 'open');
    assert.deepEqual(payload.events[0].messageLinks, ['https://xxyy.test/1001']);
    assert.ok(payload.nextCursor);

    const cursorResponse = await route.GET(
      new NextRequest(
        `http://localhost:3005/api/internal/bid/onchain-events?userIds=${alpha.id}&limit=10&cursor=${encodeURIComponent(payload.nextCursor)}`,
        {
          headers: {
            authorization: authHeader(),
          },
        }
      )
    );
    const cursorPayload = await cursorResponse.json();
    assert.equal(cursorPayload.events.length, 0);

    console.log('bid onchain events api tests: ok');
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
    if (previousHmacSecret === undefined) {
      delete process.env.INTERNAL_BID_HMAC_SECRET;
    } else {
      process.env.INTERNAL_BID_HMAC_SECRET = previousHmacSecret;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
