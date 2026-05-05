import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';

import type { Activity, User } from '@/types';

import './server-only-shim.cjs';

function createTempDbDir() {
  return mkdtempSync(path.join(tmpdir(), 'pilipili-bid-trades-api-'));
}

interface BidTradeRow {
  eventId: string;
  userId: string;
  userName: string;
  sourceAddressName: string | null;
  chain: string;
  trackedWalletAddress: string;
  trackedWalletAddressRaw: string;
  tokenAddress: string;
  tokenSymbol: string;
  txHash: string;
  action: 'buy' | 'sell';
  actionVariant: 'open' | 'add' | 'reduce' | 'close';
  eventTimeMs: number;
  tokenAmount: number;
  amountUsd: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  quoteSymbol: string | null;
  quoteAmount: number | null;
  costDataStatus: 'complete' | 'missing-usd' | 'missing-market-cap' | 'partial';
}

interface BidTradesPayload {
  ok: boolean;
  trades: BidTradeRow[];
  nextCursor: string | null;
}

function makeUser(params: {
  id: string;
  name: string;
  handle: string;
  chain: 'base' | 'bsc' | 'ethereum' | 'solana';
  address: string;
  addressName: string;
}): User {
  return {
    id: params.id,
    name: params.name,
    handle: params.handle,
    avatar: `${params.handle}.png`,
    addresses: [
      {
        address: params.address,
        name: params.addressName,
        chain: params.chain,
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

function makeTradeActivity(params: {
  id: string;
  userId: string;
  timestamp: number;
  txHash: string;
  trackedAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenAmount: string;
  quoteSymbol: string;
  quoteAmount: string;
  txAction: 'buy' | 'sell';
  txActionVariant: 'open' | 'add' | 'reduce' | 'close';
  marketCapUsd: number | null;
  chain?: 'base' | 'bsc' | 'ethereum' | 'solana' | '';
}): Activity {
  return {
    id: params.id,
    userId: params.userId,
    source: 'blockchain',
    type: 'transfer',
    content: `${params.txActionVariant} ${params.tokenAmount} ${params.tokenSymbol}`,
    timestamp: params.timestamp,
    metadata: {
      txHash: params.txHash,
      value: params.tokenAmount,
      token: params.tokenSymbol,
      tokenAddress: params.tokenAddress,
      quoteToken: params.quoteSymbol,
      quoteAmount: params.quoteAmount,
      chain: params.chain ?? 'base',
      txAction: params.txAction,
      txActionVariant: params.txActionVariant,
      trackedAddress: params.trackedAddress,
      marketCapAtTxUsd: params.marketCapUsd ?? undefined,
    },
  };
}

function makeTransferActivity(params: {
  id: string;
  userId: string;
  timestamp: number;
  txHash: string;
  trackedAddress: string;
}): Activity {
  return {
    id: params.id,
    userId: params.userId,
    source: 'blockchain',
    type: 'transfer',
    content: 'send 5 AAA',
    timestamp: params.timestamp,
    metadata: {
      txHash: params.txHash,
      value: '5',
      token: 'AAA',
      tokenAddress: '0xsendtoken',
      chain: 'base',
      txAction: 'send',
      trackedAddress: params.trackedAddress,
      fromAddress: params.trackedAddress,
      toAddress: '0xReceiver0000000000000000000000000000000001',
    },
  };
}

async function run() {
  const tempDir = createTempDbDir();
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  const previousAdminToken = process.env.ADMIN_API_TOKEN;

  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');
  process.env.ADMIN_API_TOKEN = 'bid-internal-token';

  try {
    const { upsertEventsFromFeedRows } = await import('@/lib/server/eventsRepo');
    const route = await import('../app/api/internal/bid/trades/route');

    const alpha = makeUser({
      id: 'bid-trades-alpha',
      name: 'Alpha',
      handle: 'alpha',
      chain: 'base',
      address: '0xAbCdEf0000000000000000000000000000000001',
      addressName: '#1',
    });
    const beta = makeUser({
      id: 'bid-trades-beta',
      name: 'Beta',
      handle: 'beta',
      chain: 'base',
      address: '0x9999999999999999999999999999999999999999',
      addressName: '#1',
    });

    upsertEventsFromFeedRows(
      [
        {
          user: beta,
          activity: makeTradeActivity({
            id: 'trade-beta-open',
            userId: beta.id,
            timestamp: 1_717_178_985_000,
            txHash: '0xbetaopen',
            trackedAddress: beta.addresses[0].address,
            tokenAddress: '0xTokenBeta',
            tokenSymbol: 'BETA',
            tokenAmount: '10',
            quoteSymbol: 'USDC',
            quoteAmount: '40',
            txAction: 'buy',
            txActionVariant: 'open',
            marketCapUsd: 400_000,
          }),
        },
        {
          user: alpha,
          activity: makeTradeActivity({
            id: 'trade-open',
            userId: alpha.id,
            timestamp: 1_717_178_984_000,
            txHash: '0xopen',
            trackedAddress: alpha.addresses[0].address,
            tokenAddress: '0xTokenOpen',
            tokenSymbol: 'OPEN',
            tokenAmount: '100',
            quoteSymbol: 'USDC',
            quoteAmount: '250',
            txAction: 'buy',
            txActionVariant: 'open',
            marketCapUsd: 1_250_000,
          }),
        },
        {
          user: alpha,
          activity: makeTransferActivity({
            id: 'transfer-send',
            userId: alpha.id,
            timestamp: 1_717_178_983_000,
            txHash: '0xsend',
            trackedAddress: alpha.addresses[0].address,
          }),
        },
        {
          user: alpha,
          activity: makeTradeActivity({
            id: 'trade-add',
            userId: alpha.id,
            timestamp: 1_717_178_982_000,
            txHash: '0xadd',
            trackedAddress: alpha.addresses[0].address,
            tokenAddress: '0xTokenAdd',
            tokenSymbol: 'ADD',
            tokenAmount: '50',
            quoteSymbol: 'USDT',
            quoteAmount: '175',
            txAction: 'buy',
            txActionVariant: 'add',
            marketCapUsd: 900_000,
          }),
        },
        {
          user: alpha,
          activity: makeTradeActivity({
            id: 'trade-missing-token',
            userId: alpha.id,
            timestamp: 1_717_178_981_000,
            txHash: '0xmissingtoken',
            trackedAddress: alpha.addresses[0].address,
            tokenAddress: '',
            tokenSymbol: 'MISS',
            tokenAmount: '20',
            quoteSymbol: 'USDC',
            quoteAmount: '20',
            txAction: 'buy',
            txActionVariant: 'open',
            marketCapUsd: 500_000,
          }),
        },
        {
          user: alpha,
          activity: makeTradeActivity({
            id: 'trade-reduce',
            userId: alpha.id,
            timestamp: 1_717_178_980_000,
            txHash: '0xreduce',
            trackedAddress: alpha.addresses[0].address,
            tokenAddress: '0xTokenReduce',
            tokenSymbol: 'RED',
            tokenAmount: '25',
            quoteSymbol: 'USDC',
            quoteAmount: '125',
            txAction: 'sell',
            txActionVariant: 'reduce',
            marketCapUsd: 800_000,
          }),
        },
        {
          user: alpha,
          activity: makeTradeActivity({
            id: 'trade-close',
            userId: alpha.id,
            timestamp: 1_717_178_979_000,
            txHash: '0xclose',
            trackedAddress: alpha.addresses[0].address,
            tokenAddress: '0xTokenClose',
            tokenSymbol: 'CLS',
            tokenAmount: '15',
            quoteSymbol: 'USDT',
            quoteAmount: '90',
            txAction: 'sell',
            txActionVariant: 'close',
            marketCapUsd: 700_000,
          }),
        },
      ],
      'test-bid-trades-api'
    );

    const unauthorized = await route.GET(new NextRequest('http://localhost:3005/api/internal/bid/trades'));
    assert.equal(unauthorized.status, 401);

    const page1Response = await route.GET(
      new NextRequest(
        `http://localhost:3005/api/internal/bid/trades?userIds=${alpha.id}&limit=2&fromMs=1717178979000&toMs=1717178985000`,
        {
          headers: {
            authorization: 'Bearer bid-internal-token',
          },
        }
      )
    );
    assert.equal(page1Response.status, 200);

    const page1Payload = (await page1Response.json()) as BidTradesPayload;
    assert.equal(page1Payload.ok, true);
    assert.deepEqual(
      page1Payload.trades.map((trade) => trade.eventId),
      ['trade-open', 'trade-add']
    );
    assert.deepEqual(
      page1Payload.trades.map((trade) => `${trade.action}/${trade.actionVariant}`),
      ['buy/open', 'buy/add']
    );
    assert.equal(page1Payload.trades[0].trackedWalletAddress, alpha.addresses[0].address.toLowerCase());
    assert.equal(page1Payload.trades[0].trackedWalletAddressRaw, alpha.addresses[0].address);
    assert.equal(page1Payload.trades[0].sourceAddressName, '#1');
    assert.equal(page1Payload.trades[0].tokenAmount, 100);
    assert.equal(page1Payload.trades[0].amountUsd, 250);
    assert.equal(page1Payload.trades[0].marketCapUsd, 1_250_000);
    assert.equal(page1Payload.trades[0].costDataStatus, 'complete');
    assert.ok(page1Payload.nextCursor);

    const page1RepeatResponse = await route.GET(
      new NextRequest(
        `http://localhost:3005/api/internal/bid/trades?userIds=${alpha.id}&limit=2&fromMs=1717178979000&toMs=1717178985000`,
        {
          headers: {
            authorization: 'Bearer bid-internal-token',
          },
        }
      )
    );
    const page1RepeatPayload = (await page1RepeatResponse.json()) as BidTradesPayload;
    assert.equal(page1RepeatPayload.nextCursor, page1Payload.nextCursor);

    const page2Response = await route.GET(
      new NextRequest(
        `http://localhost:3005/api/internal/bid/trades?userIds=${alpha.id}&limit=2&cursor=${encodeURIComponent(page1Payload.nextCursor || '')}`,
        {
          headers: {
            authorization: 'Bearer bid-internal-token',
          },
        }
      )
    );
    assert.equal(page2Response.status, 200);

    const page2Payload = (await page2Response.json()) as BidTradesPayload;
    assert.deepEqual(
      page2Payload.trades.map((trade) => trade.eventId),
      ['trade-reduce', 'trade-close']
    );
    assert.deepEqual(
      page2Payload.trades.map((trade) => `${trade.action}/${trade.actionVariant}`),
      ['sell/reduce', 'sell/close']
    );
    assert.equal(page2Payload.trades.some((trade) => trade.eventId === 'transfer-send'), false);
    assert.equal(page2Payload.trades.some((trade) => trade.eventId === 'trade-missing-token'), false);

    console.log('bid trades api tests: ok');
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

void run();
