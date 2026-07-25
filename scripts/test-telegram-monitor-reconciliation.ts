import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

process.env.OKX_API_KEY ??= 'fixture-okx-key';
process.env.OKX_SECRET_KEY ??= 'fixture-okx-secret';
process.env.OKX_API_PASSPHRASE ??= 'fixture-okx-passphrase';
process.env.TELEGRAM_MONITOR_INGEST_TOKEN ??= 'fixture-telegram-ingest-token';
process.env.PILI_DISABLE_TELEGRAM_MONITOR_AUTO_RECONCILE = '1';
// Legacy project path under test (doorbell is production default for alchemy/dual).
process.env.PILI_XXYY_FEED = 'project';
process.env.PILI_LIVE_SOURCE = 'xxyy';
delete process.env.INTERNAL_BID_HMAC_SECRET;
delete process.env.BID_FEED_PUSH_URL;

const TRACKED_SOL_ADDRESS = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const TX_HASH = '2tLRE1WugGAJquDrSph5XMMySFBBDmnxRgEsKPgr1tRCjqiFmLoT345V3DfkQASSdc3BMUx2brt3xEauGLsQNJsQ';
const TOKEN_ADDRESS = 'CJUrENDAuSm4FxxziUgftnUJqqXjm4VL1zhJgwXupump';
const TX_TIME_MS = 1777178981000;
const TRACKED_BSC_ADDRESS = '0x7592ca1ad468ddac5a97a5625c1c55e36338f786';
const BSC_TX_HASH = '0x9e4de1b154b0664ab97aeadec2ceee38930360b786c8b36197793475441e0878';
const BSC_TOKEN_ADDRESS = '0x930809fb99dd10d404504d1603e8756eafd84444';
const BSC_EVENT_TIME_MS = 1777865833000;
const BSC_MULTI_FILL_TX_HASH = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BSC_MULTI_FILL_TOKEN_ADDRESS = '0x0a43fc31a73013089df59194872ecae4cae14444';
const BSC_MULTI_FILL_EVENT_TIME_MS = 1777878447000;
const BSC_SAME_TX_DUAL_TOKEN_TX_HASH = '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const BSC_SAME_TX_DUAL_TOKEN_BUY_ADDRESS = '0x495dfbd37e443255e075b8d2482bde6bce337777';
const BSC_SAME_TX_DUAL_TOKEN_SELL_ADDRESS = '0x444045b0ee1ee319a660a5e3d604ca0ffa35acaa';
const BSC_SAME_TX_DUAL_TOKEN_EVENT_TIME_MS = 1777879447000;
const BSC_MISSING_QUOTE_TX_HASH = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const BSC_MISSING_QUOTE_TOKEN_ADDRESS = '0xe68bd56b99ab9a527375bd87bf03ee6344f68ca1';
const BSC_MISSING_QUOTE_EVENT_TIME_MS = 1777933730000;
const SPLIT_FILL_TX_HASH =
  '5VERv8NMhxG9vqMDKMt8kN6E9MPBbJqN6tG3Rz2ZjqTp3VQJuGVEJJmBwXkG7s84N2wEVCcpYPbJj8FPmYrPhJk';
const SPLIT_FILL_TOKEN_ADDRESS = '2CKp88BFyPzr7gEuQKXMJ9cqa24AFXUNC41FR7udpump';
const SOL_UNKNOWN_COLLAPSE_TX_HASH =
  '3dtgw8AyJ2yLQtgkannhoSsKUcGb2aPTZfvTTds9uRgqeMgZzqnbRPVwvhN3HQhosmbhYaK3pH92fCTrWmTbdSmL';
const SOL_UNKNOWN_COLLAPSE_TOKEN_ADDRESS = 'Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump';
const SOL_UNKNOWN_COLLAPSE_EVENT_TIME_MS = 1784427565000;
const SOL_LEGACY_WSOL_MINT = 'So11111111111111111111111111111111111111111';

function buildExpectedMonitorEventId(chain: string, trackedAddress: string, txHash: string, tokenAddress: string) {
  return `xxyy-monitor:${chain.toLowerCase()}:${trackedAddress.toLowerCase()}:${txHash.toLowerCase()}:${tokenAddress.toLowerCase()}`;
}

function createJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function buildTelegramUpdate(messageId: number, txHash = TX_HASH) {
  return {
    update_id: 900_100 + messageId,
    message: {
      message_id: messageId,
      date: Math.floor(TX_TIME_MS / 1000),
      chat: { id: -100123456 },
      text: [
        '[xp] [user_a#1]',
        '🟢 New buy 0.1181 SOL',
        'Token: 45188.989541  [HENRY]',
        'Price: $0.000239',
        'MCAP: $239.0K',
        `CA: ${TOKEN_ADDRESS}`,
      ].join('\n'),
      entities: [
        {
          type: 'text_link',
          url: `https://www.xxyy.io/sol/${TOKEN_ADDRESS}?wallet=${TRACKED_SOL_ADDRESS}&ref=`,
        },
      ],
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Solscan',
              url: `https://solscan.io/tx/${txHash}`,
            },
          ],
        ],
      },
    },
  };
}

function buildLegacyOnlyTelegramUpdate(messageId: number, txHash: string, quoteAmount = '0.1181') {
  return {
    update_id: 910_000 + messageId,
    message: {
      message_id: messageId,
      date: Math.floor(TX_TIME_MS / 1000),
      chat: { id: -100123456 },
      text: [
        '[xp] [user_a#1]',
        `🟢 New buy ${quoteAmount} SOL`,
        'Token: 45188.989541  [HENRY]',
        'Price: $0.000239',
        'MCAP: $239.0K',
        `CA: ${TOKEN_ADDRESS}`,
      ].join('\n'),
      entities: [
        {
          type: 'text_link',
          url: `https://www.xxyy.io/sol/${TOKEN_ADDRESS}?wallet=${TRACKED_SOL_ADDRESS}&ref=`,
        },
      ],
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Solscan',
              url: `https://solscan.io/tx/${txHash}`,
            },
          ],
        ],
      },
    },
  };
}

function buildSplitFillTelegramUpdate(messageId: number, txHash = SPLIT_FILL_TX_HASH) {
  return {
    update_id: 920_000 + messageId,
    message: {
      message_id: messageId,
      date: Math.floor(TX_TIME_MS / 1000) + 100,
      chat: { id: -100123456 },
      text: [
        '[xp] [user_a#1]',
        '🟢 Buy more 2.7075 SOL',
        'Token: 1742503.54118  [Walter]',
        'Price: $0.0{3}130',
        'MCAP: $130K',
        `CA: ${SPLIT_FILL_TOKEN_ADDRESS}`,
      ].join('\n'),
      entities: [
        {
          type: 'text_link',
          url: `https://www.xxyy.io/sol/${SPLIT_FILL_TOKEN_ADDRESS}?wallet=${TRACKED_SOL_ADDRESS}&ref=`,
        },
      ],
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Solscan',
              url: `https://solscan.io/tx/${txHash}`,
            },
          ],
        ],
      },
    },
  };
}

function buildBscMultiFillTelegramUpdate(params: {
  messageId: number;
  txHash?: string;
  quoteAmount: string;
  tokenAmount: string;
  priceUsd: string;
  platform: string;
}) {
  return {
    update_id: 930_000 + params.messageId,
    message: {
      message_id: params.messageId,
      date: Math.floor(BSC_MULTI_FILL_EVENT_TIME_MS / 1000),
      chat: { id: -100123456 },
      text: [
        '[User_D#1]',
        `🟢 New buy ${params.quoteAmount} BNB`,
        `Token: ${params.tokenAmount}  [4]`,
        `Price: $${params.priceUsd}`,
        'MCAP: $14.7M',
        `Platform: ${params.platform}`,
        `CA: ${BSC_MULTI_FILL_TOKEN_ADDRESS}`,
        '#e14444',
      ].join('\n'),
      entities: [
        {
          type: 'text_link',
          url: `https://www.xxyy.io/bsc/${BSC_MULTI_FILL_TOKEN_ADDRESS}?wallet=${TRACKED_BSC_ADDRESS}&ref=`,
        },
      ],
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Bscscan',
              url: `https://bscscan.com/tx/${params.txHash || BSC_MULTI_FILL_TX_HASH}`,
            },
          ],
        ],
      },
    },
  };
}

function buildBscSameTxDualTokenTelegramUpdate(params: {
  messageId: number;
  action: 'buy' | 'sell';
  tokenAddress: string;
  tokenSymbol: string;
  tokenAmount: string;
  quoteAmount: string;
  priceText: string;
  marketCapText: string;
  platform: string;
}) {
  const isBuy = params.action === 'buy';
  return {
    update_id: 940_000 + params.messageId,
    message: {
      message_id: params.messageId,
      date: Math.floor(BSC_SAME_TX_DUAL_TOKEN_EVENT_TIME_MS / 1000),
      chat: { id: -100123456 },
      text: [
        '[User_D#1]',
        isBuy ? `🟢 New buy ${params.quoteAmount} BNB` : `🔴 Sell All ${params.quoteAmount} BNB`,
        `Token: ${params.tokenAmount}  [${params.tokenSymbol}]`,
        `Price: ${params.priceText}`,
        `MCAP: ${params.marketCapText}`,
        `Platform: ${params.platform}`,
        `CA: ${params.tokenAddress}`,
      ].join('\n'),
      entities: [
        {
          type: 'text_link',
          url: `https://www.xxyy.io/bsc/${params.tokenAddress}?wallet=${TRACKED_BSC_ADDRESS}&ref=`,
        },
      ],
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Bscscan',
              url: `https://bscscan.com/tx/${BSC_SAME_TX_DUAL_TOKEN_TX_HASH}`,
            },
          ],
        ],
      },
    },
  };
}

function createSuccessfulFetch() {
  return async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('/transactions-by-address?')) {
      return createJsonResponse({
        code: '0',
        data: [
          {
            transactionList: [
              {
                chainIndex: '501',
                txHash: TX_HASH,
                itype: '0',
                txTime: String(TX_TIME_MS),
                from: [{ address: TRACKED_SOL_ADDRESS, amount: '' }],
                to: [{ address: '91Ht2gq1CMPcLySuq8NjHaA1rXysm8zzoiiyfT4uSE7u', amount: '' }],
                tokenContractAddress: '',
                amount: '0.0002',
                symbol: 'SOL',
                txStatus: 'success',
              },
              {
                chainIndex: '501',
                txHash: TX_HASH,
                itype: '0',
                txTime: String(TX_TIME_MS),
                from: [{ address: TRACKED_SOL_ADDRESS, amount: '' }],
                to: [{ address: '8ckLnP69xhSeoNbZCUrbJZ8aYSR86QNjRVZdpHmFfigk', amount: '' }],
                tokenContractAddress: '',
                amount: '0.0017',
                symbol: 'SOL',
                txStatus: 'success',
              },
              {
                chainIndex: '501',
                txHash: TX_HASH,
                itype: '2',
                txTime: String(TX_TIME_MS),
                from: [{ address: TRACKED_SOL_ADDRESS, amount: '' }],
                to: [{ address: 'ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn', amount: '' }],
                tokenContractAddress: 'So11111111111111111111111111111111111111112',
                amount: '0.2483',
                symbol: 'SOL',
                txStatus: 'success',
              },
              {
                chainIndex: '501',
                txHash: TX_HASH,
                itype: '2',
                txTime: String(TX_TIME_MS),
                from: [{ address: 'ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn', amount: '' }],
                to: [{ address: TRACKED_SOL_ADDRESS, amount: '' }],
                tokenContractAddress: TOKEN_ADDRESS,
                amount: '94464.94413',
                symbol: 'HENRY',
                txStatus: 'success',
              },
            ],
          },
        ],
      });
    }

    if (url.includes('/transaction-detail-by-txhash?')) {
      return createJsonResponse({
        code: '0',
        data: [
          {
            chainIndex: '501',
            txhash: TX_HASH,
            txStatus: 'success',
            tokenTransferDetails: [
              {
                from: TRACKED_SOL_ADDRESS,
                to: 'ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn',
                tokenContractAddress: 'So11111111111111111111111111111111111111112',
                symbol: 'SOL',
                amount: '0.2483',
              },
              {
                from: 'ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn',
                to: TRACKED_SOL_ADDRESS,
                tokenContractAddress: TOKEN_ADDRESS,
                symbol: 'HENRY',
                amount: '94464.94413',
              },
            ],
          },
        ],
      });
    }

    if (url.includes('/api/v6/dex/market/historical-candles?')) {
      return createJsonResponse({
        code: '0',
        data: [[String(TX_TIME_MS), '0', '0', '0', '150', '0', '0', '0']],
      });
    }

    if (url.includes('/api/v5/market/ticker?')) {
      return createJsonResponse({
        code: '0',
        data: [
          {
            instId: 'SOL-USDT',
            last: '150',
          },
        ],
      });
    }

    throw new Error(`Unhandled fetch: ${url}`);
  };
}

function createDetailFallbackFetch() {
  return async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('/transactions-by-address?')) {
      return createJsonResponse({
        code: '0',
        data: [
          {
            transactionList: [],
          },
        ],
      });
    }

    return createSuccessfulFetch()(input);
  };
}

function createFailingFetch() {
  return async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/api/v6/dex/market/historical-candles?')) {
      return createJsonResponse({
        code: '0',
        data: [[String(TX_TIME_MS), '0', '0', '0', '150', '0', '0', '0']],
      });
    }
    throw new Error(`forced failure for ${url}`);
  };
}

function createSplitFillFetch() {
  return async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('/transactions-by-address?')) {
      return createJsonResponse({
        code: '0',
        data: [
          {
            transactionList: [
              {
                chainIndex: '501',
                txHash: SPLIT_FILL_TX_HASH,
                itype: '2',
                txTime: String(TX_TIME_MS + 100_000),
                from: [{ address: TRACKED_SOL_ADDRESS, amount: '' }],
                to: [{ address: '6JgFeRD4epm867UBStZCbeFM5bDw9xs31jjzAE5MfQfo', amount: '' }],
                tokenContractAddress: 'So11111111111111111111111111111111111111112',
                amount: '2.707593205',
                symbol: 'SOL',
                txStatus: 'success',
              },
              {
                chainIndex: '501',
                txHash: SPLIT_FILL_TX_HASH,
                itype: '2',
                txTime: String(TX_TIME_MS + 100_000),
                from: [{ address: '6JgFeRD4epm867UBStZCbeFM5bDw9xs31jjzAE5MfQfo', amount: '' }],
                to: [{ address: TRACKED_SOL_ADDRESS, amount: '' }],
                tokenContractAddress: SPLIT_FILL_TOKEN_ADDRESS,
                amount: '1742503.54118',
                symbol: 'Walter',
                txStatus: 'success',
              },
            ],
          },
        ],
      });
    }

    if (url.includes('/transaction-detail-by-txhash?')) {
      return createJsonResponse({
        code: '0',
        data: [
          {
            chainIndex: '501',
            txhash: SPLIT_FILL_TX_HASH,
            txStatus: 'success',
            tokenTransferDetails: [
              {
                from: TRACKED_SOL_ADDRESS,
                to: TRACKED_SOL_ADDRESS,
                tokenContractAddress: 'So11111111111111111111111111111111111111111',
                symbol: '',
                amount: '3.80203928',
              },
              {
                from: TRACKED_SOL_ADDRESS,
                to: TRACKED_SOL_ADDRESS,
                tokenContractAddress: 'So11111111111111111111111111111111111111111',
                symbol: '',
                amount: '0.00203928',
              },
              {
                from: '6JgFeRD4epm867UBStZCbeFM5bDw9xs31jjzAE5MfQfo',
                to: TRACKED_SOL_ADDRESS,
                tokenContractAddress: SPLIT_FILL_TOKEN_ADDRESS,
                symbol: 'Walter',
                amount: '1742503.54118',
              },
              {
                from: TRACKED_SOL_ADDRESS,
                to: '6JgFeRD4epm867UBStZCbeFM5bDw9xs31jjzAE5MfQfo',
                tokenContractAddress: 'So11111111111111111111111111111111111111112',
                symbol: 'SOL',
                amount: '2.707593205',
              },
              {
                from: TRACKED_SOL_ADDRESS,
                to: 'AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY',
                tokenContractAddress: 'So11111111111111111111111111111111111111112',
                symbol: 'SOL',
                amount: '0.000675548',
              },
              {
                from: TRACKED_SOL_ADDRESS,
                to: '5icPeMi4TK2g4aV62kcMfDSCX4ir2w5WHHeywphsAGhX',
                tokenContractAddress: 'So11111111111111111111111111111111111111112',
                symbol: 'SOL',
                amount: '0.0243197',
              },
              {
                from: TRACKED_SOL_ADDRESS,
                to: 'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL',
                tokenContractAddress: 'So11111111111111111111111111111111111111112',
                symbol: 'SOL',
                amount: '0.000675547',
              },
              {
                from: TRACKED_SOL_ADDRESS,
                to: 'EdveCrEyXppx98vssgUSoSruXuJVEH8NYp7xq65aVBW3',
                tokenContractAddress: 'So11111111111111111111111111111111111111112',
                symbol: 'SOL',
                amount: '1.062936',
              },
              {
                from: 'EdveCrEyXppx98vssgUSoSruXuJVEH8NYp7xq65aVBW3',
                to: TRACKED_SOL_ADDRESS,
                tokenContractAddress: SPLIT_FILL_TOKEN_ADDRESS,
                symbol: 'Walter',
                amount: '683831.629908',
              },
              {
                from: TRACKED_SOL_ADDRESS,
                to: '3CgvbiM3op4vjrrjH2zcrQUwsqh5veNVRjFCB9N6sRoD',
                tokenContractAddress: 'So11111111111111111111111111111111111111112',
                symbol: 'SOL',
                amount: '0.0038',
              },
            ],
          },
        ],
      });
    }

    if (url.includes('/api/v6/dex/market/historical-candles?')) {
      return createJsonResponse({
        code: '0',
        data: [[String(TX_TIME_MS + 100_000), '0', '0', '0', '150', '0', '0', '0']],
      });
    }

    if (url.includes('/api/v5/market/ticker?')) {
      return createJsonResponse({
        code: '0',
        data: [
          {
            instId: 'SOL-USDT',
            last: '150',
          },
        ],
      });
    }

    throw new Error(`Unhandled split-fill fetch: ${url}`);
  };
}

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-telegram-monitor-reconcile-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  const previousFetch = globalThis.fetch;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { saveSystemConfig } = await import('../lib/server/systemConfigRepo');
    const { createTrackedUser } = await import('../lib/server/trackedUsersRepo');
    const { ingestTelegramMonitorUpdate } = await import('../lib/server/telegramMonitorIngest');
    const { readTelegramMonitorFeed } = await import('../lib/server/telegramMonitorFeed');
    const { readEventsFeed } = await import('../lib/server/eventsRepo');
    const { getDb } = await import('../lib/server/sqlite');
    const { reconcileTelegramMonitorTxState } = await import('../lib/server/telegramMonitorReconciler');
    const {
      claimTelegramMonitorTxStatesForRepair,
      getTelegramMonitorTxState,
      listTelegramMonitorTxStatesByKeys,
      markTelegramMonitorTxStateReconciled,
    } = await import('../lib/server/telegramMonitorTxStateRepo');
    const { upsertEventsFromFeedRows } = await import('../lib/server/eventsRepo');
    const { upsertTelegramMonitorEvent } = await import('../lib/server/telegramMonitorRepo');

    saveSystemConfig({
      telegramTradeMonitorSourceChatId: '-100123456',
    });

    const trackedUser = createTrackedUser({
      name: 'henry',
      handle: 'henry',
      avatar: 'henry.png',
      twitter: undefined,
      telegram: undefined,
      addresses: [
        {
          address: TRACKED_SOL_ADDRESS,
          name: '#1',
          chain: 'solana',
          totalAssetUsd: null,
          assetUpdatedAt: null,
        },
      ],
      totalAssetUsd: 0,
      historicalMaxAssetUsd: 0,
      assetUpdatedAt: null,
      tags: [],
    });
    const bscTrackedUser = createTrackedUser({
      name: '弘哥',
      handle: 'hongge',
      avatar: 'hongge.png',
      twitter: undefined,
      telegram: undefined,
      addresses: [
        {
          address: TRACKED_BSC_ADDRESS,
          name: '#2',
          chain: 'bsc',
          totalAssetUsd: null,
          assetUpdatedAt: null,
        },
      ],
      totalAssetUsd: 0,
      historicalMaxAssetUsd: 0,
      assetUpdatedAt: null,
      tags: [],
    });

    globalThis.fetch = createSuccessfulFetch() as typeof fetch;
    const provisionalResult = await ingestTelegramMonitorUpdate(buildTelegramUpdate(501));
    assert.equal(provisionalResult.ok, true, 'ingest should accept the telegram update');
    const txStateAfterIngest = getTelegramMonitorTxState({
      chain: 'solana',
      trackedWalletAddress: TRACKED_SOL_ADDRESS,
      txHash: TX_HASH,
    });
    assert.ok(txStateAfterIngest?.canonicalActivity?.metadata.importance?.score !== undefined);

    const provisionalFeed = await readTelegramMonitorFeed(20);
    assert.equal(provisionalFeed.length, 1, 'provisional monitor feed should have one row');
    assert.equal(provisionalFeed[0]?.activity.metadata.quoteAmount, '0.1181');
    assert.equal(provisionalFeed[0]?.activity.metadata.monitorReconciliationStatus, 'pending');

    const replayedProvisional = await ingestTelegramMonitorUpdate(buildLegacyOnlyTelegramUpdate(598, TX_HASH, '0.2222'));
    assert.equal(replayedProvisional.ok, true, 'replayed provisional ingest should still be accepted');
    const replayedFeed = await readTelegramMonitorFeed(20);
    const replayedPrimaryRow = replayedFeed.find((item) => item.activity.metadata.txHash === TX_HASH);
    assert.equal(
      replayedPrimaryRow?.activity.metadata.quoteAmount,
      '0.2222',
      'pending tx-state projection should reflect latest provisional payload rather than stale canonical cache'
    );
    assert.equal(replayedPrimaryRow?.activity.metadata.monitorReconciliationStatus, 'pending');

    const firstBscMultiFill = await ingestTelegramMonitorUpdate(
      buildBscMultiFillTelegramUpdate({
        messageId: 650,
        quoteAmount: '0.0292',
        tokenAmount: '1247.09',
        priceUsd: '0.0148',
        platform: 'Pancake V2',
      })
    );
    assert.equal(firstBscMultiFill.ok, true, 'first BSC multi-fill leg should ingest');
    const secondBscMultiFill = await ingestTelegramMonitorUpdate(
      buildBscMultiFillTelegramUpdate({
        messageId: 651,
        quoteAmount: '0.022',
        tokenAmount: '940.87',
        priceUsd: '0.0147',
        platform: 'Pancake V3',
      })
    );
    assert.equal(secondBscMultiFill.ok, true, 'second BSC multi-fill leg should ingest');

    // XXYY phantom opposite-side: real buy 0.0588 + fake sell 0.0005 (~1%) on same token/tx.
    const PHANTOM_TX_HASH = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccddddddddd';
    const phantomBuy = await ingestTelegramMonitorUpdate(
      buildBscMultiFillTelegramUpdate({
        messageId: 652,
        txHash: PHANTOM_TX_HASH,
        quoteAmount: '0.0588',
        tokenAmount: '3975.1',
        priceUsd: '0.0275',
        platform: 'UniSwap V4',
      })
    );
    assert.equal(phantomBuy.ok, true, 'phantom-pair real buy should ingest');
    const phantomSell = await ingestTelegramMonitorUpdate({
      update_id: 930_653,
      message: {
        message_id: 653,
        date: Math.floor(BSC_MULTI_FILL_EVENT_TIME_MS / 1000),
        chat: { id: -100123456 },
        text: [
          '[User_D#1]',
          '🔴 Sell Part 0.0005 BNB',
          'Token: 39.75  [4]',
          'Price: $0.0275',
          'MCAP: $27.5M',
          'Platform: UniSwap V4',
          `CA: ${BSC_MULTI_FILL_TOKEN_ADDRESS}`,
        ].join('\n'),
        entities: [
          {
            type: 'text_link',
            url: `https://www.xxyy.io/bsc/${BSC_MULTI_FILL_TOKEN_ADDRESS}?wallet=${TRACKED_BSC_ADDRESS}&ref=`,
          },
        ],
        reply_markup: {
          inline_keyboard: [[{ text: 'Bscscan', url: `https://bscscan.com/tx/${PHANTOM_TX_HASH}` }]],
        },
      },
    });
    assert.equal(phantomSell.ok, true, 'phantom-pair fake sell should ingest');
    const phantomState = getTelegramMonitorTxState({
      chain: 'bsc',
      trackedWalletAddress: TRACKED_BSC_ADDRESS,
      txHash: PHANTOM_TX_HASH,
      tokenAddress: BSC_MULTI_FILL_TOKEN_ADDRESS,
    });
    assert.equal(phantomState?.provisionalAction, 'buy', 'phantom opposite sell must not flip dominant action');
    assert.equal(
      phantomState?.provisionalQuoteAmount,
      0.0588,
      'phantom opposite sell must not be summed into quote'
    );
    assert.equal(
      phantomState?.provisionalTokenAmount,
      3975.1,
      'phantom opposite sell must not be summed into token amount'
    );
    const phantomEvent = readEventsFeed({ limit: 50, userId: bscTrackedUser.id }).feed.find(
      (item) => item.activity.metadata.txHash === PHANTOM_TX_HASH
    );
    assert.equal(phantomEvent?.activity.metadata.txAction, 'buy', 'feed row must stay buy after phantom sell');
    assert.equal(
      phantomEvent?.activity.metadata.quoteAmount,
      '0.0588',
      'feed quote must ignore phantom sell amount'
    );

    const aggregatedBscState = getTelegramMonitorTxState({
      chain: 'bsc',
      trackedWalletAddress: TRACKED_BSC_ADDRESS,
      txHash: BSC_MULTI_FILL_TX_HASH,
    });
    assert.equal(
      aggregatedBscState?.provisionalQuoteAmount,
      0.0512,
      'multi-leg provisional tx state should sum quote amounts across distinct XXYY fills'
    );
    assert.equal(
      aggregatedBscState?.provisionalTokenAmount,
      2187.96,
      'multi-leg provisional tx state should sum token amounts across distinct XXYY fills'
    );

    const aggregatedBscFeed = await readTelegramMonitorFeed(50);
    const aggregatedBscRow = aggregatedBscFeed.find(
      (item) => item.activity.metadata.txHash === BSC_MULTI_FILL_TX_HASH
    );
    assert.equal(
      aggregatedBscRow?.activity.metadata.quoteAmount,
      '0.0512',
      'multi-leg provisional feed should expose the summed quote amount'
    );
    assert.equal(
      aggregatedBscRow?.activity.metadata.value,
      '2187.96',
      'multi-leg provisional feed should expose the summed token amount'
    );
    assert.equal(
      aggregatedBscRow?.activity.metadata.displayTradeAmountText,
      '0.051 BNB',
      'multi-leg provisional feed should render the aggregated display amount instead of a single raw leg'
    );
    const aggregatedBscEvents = readEventsFeed({
      limit: 50,
      userId: bscTrackedUser.id,
    });
    const aggregatedBscEvent = aggregatedBscEvents.feed.find(
      (item) => item.activity.metadata.txHash === BSC_MULTI_FILL_TX_HASH
    );
    assert.equal(
      aggregatedBscEvent?.activity.metadata.quoteAmount,
      '0.0512',
      'multi-leg provisional main feed should persist the summed quote amount'
    );
    assert.equal(
      aggregatedBscEvent?.activity.metadata.value,
      '2187.96',
      'multi-leg provisional main feed should persist the summed token amount'
    );
    assert.equal(
      aggregatedBscEvent?.activity.metadata.displayTradeAmountText,
      '0.051 BNB',
      'multi-leg provisional main feed should not fall back to a stale single-leg rawText display'
    );

    const sameTxSell = await ingestTelegramMonitorUpdate(
      buildBscSameTxDualTokenTelegramUpdate({
        messageId: 660,
        action: 'sell',
        tokenAddress: BSC_SAME_TX_DUAL_TOKEN_SELL_ADDRESS,
        tokenSymbol: 'BTW',
        tokenAmount: '150000',
        quoteAmount: '2.7223',
        priceText: '$0.0124',
        marketCapText: '$124.2M',
        platform: 'Pancake V4',
      })
    );
    assert.equal(sameTxSell.ok, true, 'same-tx sell leg should ingest');
    const sameTxBuy = await ingestTelegramMonitorUpdate(
      buildBscSameTxDualTokenTelegramUpdate({
        messageId: 661,
        action: 'buy',
        tokenAddress: BSC_SAME_TX_DUAL_TOKEN_BUY_ADDRESS,
        tokenSymbol: '美股人生',
        tokenAmount: '13853945.66',
        quoteAmount: '2.7313',
        priceText: '$0.0{3}134',
        marketCapText: '$134.9K',
        platform: 'Pancake V2',
      })
    );
    assert.equal(sameTxBuy.ok, true, 'same-tx buy leg should ingest');

    const sameTxEvents = readEventsFeed({
      limit: 50,
      userId: bscTrackedUser.id,
    }).feed.filter((item) => item.activity.metadata.txHash === BSC_SAME_TX_DUAL_TOKEN_TX_HASH);
    assert.equal(
      sameTxEvents.length,
      2,
      'same-wallet same-tx monitor rows for different token addresses should remain separate feed events'
    );
    assert.deepEqual(
      sameTxEvents.map((item) => item.activity.metadata.tokenAddress).sort(),
      [BSC_SAME_TX_DUAL_TOKEN_BUY_ADDRESS, BSC_SAME_TX_DUAL_TOKEN_SELL_ADDRESS].sort()
    );
    assert.deepEqual(
      sameTxEvents.map((item) => item.activity.metadata.txAction).sort(),
      ['buy', 'sell']
    );

    const legacyOnlyTxHash = '5KjD4n9hB2dMRY3oM4pX1oKZEFZ9cL5qUT8R76v9kqebCzK84j7zW8nW2vxx3G7Yd1Ny8KkG5X5hKw4mPoGdYq1V';
    const legacyOnlyUpdate = buildLegacyOnlyTelegramUpdate(599, legacyOnlyTxHash, '0.3333');
    const legacyOnlyMessage = legacyOnlyUpdate.message;
    assert.ok(legacyOnlyMessage, 'legacy-only fixture should include a message');
    const legacyOnlyEvent = upsertTelegramMonitorEvent({
      provider: 'xxyy',
      sourceChatId: String(legacyOnlyMessage.chat?.id || ''),
      sourceMessageId: legacyOnlyMessage.message_id || null,
      updateId: legacyOnlyUpdate.update_id,
      chain: 'solana',
      tokenAddress: TOKEN_ADDRESS,
      tokenSymbol: 'HENRY',
      txHash: legacyOnlyTxHash,
      marketCapUsd: 239_000,
      priceUsd: 0.000239,
      quoteAmount: 0.3333,
      quoteSymbol: 'SOL',
      action: 'buy',
      actionLabel: '建仓',
      actionVariant: 'open',
      walletLabel: 'henry',
      walletGroupLabel: 'xp',
      walletAliasLabel: 'user_a#1',
      trackedWalletAddress: TRACKED_SOL_ADDRESS,
      eventTimeMs: TX_TIME_MS - 60_000,
      rawText: legacyOnlyMessage.text,
      messageLinks: [
        `https://solscan.io/tx/${legacyOnlyTxHash}`,
        `https://www.xxyy.io/sol/${TOKEN_ADDRESS}?wallet=${TRACKED_SOL_ADDRESS}&ref=`,
      ],
      payload: legacyOnlyUpdate as Record<string, unknown>,
    });
    assert.equal(legacyOnlyEvent.ok, true, 'legacy-only monitor event should be inserted');
    const legacyOnlyDuplicateEvent = upsertTelegramMonitorEvent({
      provider: 'xxyy',
      sourceChatId: String(legacyOnlyMessage.chat?.id || ''),
      sourceMessageId: (legacyOnlyMessage.message_id || 0) + 1_000,
      updateId: legacyOnlyUpdate.update_id + 1_000,
      chain: 'solana',
      tokenAddress: TOKEN_ADDRESS,
      tokenSymbol: 'HENRY',
      txHash: legacyOnlyTxHash,
      marketCapUsd: 239_000,
      priceUsd: 0.000239,
      quoteAmount: 0.3344,
      quoteSymbol: 'SOL',
      action: 'buy',
      actionLabel: '建仓',
      actionVariant: 'open',
      walletLabel: 'henry',
      walletGroupLabel: 'xp',
      walletAliasLabel: 'user_a#1',
      trackedWalletAddress: TRACKED_SOL_ADDRESS,
      eventTimeMs: TX_TIME_MS - 59_000,
      rawText: legacyOnlyMessage.text,
      messageLinks: [
        `https://solscan.io/tx/${legacyOnlyTxHash}`,
        `https://www.xxyy.io/sol/${TOKEN_ADDRESS}?wallet=${TRACKED_SOL_ADDRESS}&ref=`,
      ],
      payload: { duplicateLegacyOnly: true, txHash: legacyOnlyTxHash },
    });
    assert.equal(legacyOnlyDuplicateEvent.ok, true, 'duplicate legacy-only monitor event should be inserted');
    assert.equal(
      getTelegramMonitorTxState({
        chain: 'solana',
        trackedWalletAddress: TRACKED_SOL_ADDRESS,
        txHash: legacyOnlyTxHash,
      }),
      null,
      'legacy-only fixture should not create a tx-state row'
    );
    const reparsedFallback = await readTelegramMonitorFeed(20);
    const fallbackActivity = reparsedFallback.find((item) => item.activity.metadata.txHash === legacyOnlyTxHash);
    assert.ok(fallbackActivity?.activity.metadata.importance?.score !== undefined);
    const fallbackRows = getDb()
      .prepare(
        `SELECT projected_activity_json
         FROM telegram_monitor_events
         WHERE tx_hash = ?`
      )
      .all(legacyOnlyTxHash) as Array<{ projected_activity_json: string | null }>;
    assert.ok(fallbackRows[0]?.projected_activity_json, 'fallback monitor row should persist projected activity json');

    const feedWithLegacyFallback = await readTelegramMonitorFeed(20);
    const legacyFallbackRows = feedWithLegacyFallback.filter(
      (item) => item.activity.metadata.txHash === legacyOnlyTxHash
    );
    assert.equal(
      legacyFallbackRows.length,
      1,
      'legacy-only fallback rows should still collapse to one logical row per tx'
    );
    assert.equal(legacyFallbackRows[0]?.activity.metadata.quoteAmount, '0.3344');

    const provisionalEvents = readEventsFeed({
      limit: 20,
      userId: trackedUser.id,
    });
    assert.equal(provisionalEvents.total, 1, 'provisional ingest should create one logical event');

    const db = getDb();
    const provisionalEventRow = db
      .prepare(
        `SELECT event_id, metadata_json
         FROM events
         WHERE user_id = ?
         ORDER BY timestamp DESC, rowid DESC
         LIMIT 1`
      )
      .get(trackedUser.id) as { event_id: string; metadata_json: string } | undefined;
    assert.equal(
      provisionalEventRow?.event_id,
      buildExpectedMonitorEventId('solana', TRACKED_SOL_ADDRESS, TX_HASH, TOKEN_ADDRESS),
      'monitor events should use stable token-aware tx identity'
    );

    const reconciled = await reconcileTelegramMonitorTxState({
      chain: 'solana',
      trackedWalletAddress: TRACKED_SOL_ADDRESS,
      txHash: TX_HASH,
    });
    assert.equal(reconciled.status, 'reconciled', 'address reconciliation should succeed');
    assert.equal(reconciled.source, 'okx-detail');
    const reconciledState = getTelegramMonitorTxState({
      chain: 'solana',
      trackedWalletAddress: TRACKED_SOL_ADDRESS,
      txHash: TX_HASH,
    });
    assert.ok(reconciledState?.canonicalActivity?.metadata.importance?.score !== undefined);

    const reconciledFeed = await readTelegramMonitorFeed(20);
    const reconciledPrimaryRow = reconciledFeed.find((item) => item.activity.metadata.txHash === TX_HASH);
    assert.equal(
      reconciledFeed.filter((item) => item.activity.metadata.txHash === TX_HASH).length,
      1,
      'reconciled feed should keep one logical row for the corrected tx'
    );
    assert.equal(reconciledPrimaryRow?.activity.metadata.quoteAmount, '0.2483');
    assert.equal(reconciledPrimaryRow?.activity.metadata.value, '94464.94413');
    assert.equal(reconciledPrimaryRow?.activity.metadata.monitorReconciliationStatus, 'reconciled');
    assert.equal(reconciledPrimaryRow?.activity.metadata.monitorReconciledSource, 'okx-detail');

    const reconciledEvents = readEventsFeed({
      limit: 20,
      userId: trackedUser.id,
    });
    assert.equal(reconciledEvents.total, 1, 'reconciliation should overwrite the existing event in place');
    assert.equal(reconciledEvents.feed[0]?.activity.metadata.quoteAmount, '0.2483');

    globalThis.fetch = createDetailFallbackFetch() as typeof fetch;
    const detailFallback = await reconcileTelegramMonitorTxState({
      chain: 'solana',
      trackedWalletAddress: TRACKED_SOL_ADDRESS,
      txHash: TX_HASH,
      force: true,
    });
    assert.equal(detailFallback.status, 'reconciled', 'detail fallback should still reconcile');
    assert.equal(detailFallback.source, 'okx-detail');

    globalThis.fetch = createSplitFillFetch() as typeof fetch;
    const splitFillIngest = await ingestTelegramMonitorUpdate(buildSplitFillTelegramUpdate(700));
    assert.equal(splitFillIngest.ok, true, 'split fill fixture should ingest provisionally');
    const splitFillResult = await reconcileTelegramMonitorTxState({
      chain: 'solana',
      trackedWalletAddress: TRACKED_SOL_ADDRESS,
      txHash: SPLIT_FILL_TX_HASH,
      force: true,
    });
    assert.equal(splitFillResult.status, 'reconciled', 'split fill fixture should reconcile');
    assert.equal(splitFillResult.source, 'okx-detail', 'split fill fixture should prefer tx detail');

    const splitFillFeed = await readTelegramMonitorFeed(20);
    const splitFillRow = splitFillFeed.find((item) => item.activity.metadata.txHash === SPLIT_FILL_TX_HASH);
    assert.equal(splitFillRow?.activity.metadata.token, 'Walter');
    assert.equal(splitFillRow?.activity.metadata.value, '2426335.171088');
    assert.equal(splitFillRow?.activity.metadata.quoteAmount, '3.8');
    assert.equal(splitFillRow?.activity.metadata.displayTradeAmountText, '3.8 SOL');
    assert.equal(splitFillRow?.activity.metadata.monitorReconciledSource, 'okx-detail');

    const splitFillEvents = readEventsFeed({
      limit: 50,
      userId: trackedUser.id,
    });
    const splitFillEvent = splitFillEvents.feed.find((item) => item.activity.metadata.txHash === SPLIT_FILL_TX_HASH);
    assert.equal(splitFillEvent?.activity.metadata.value, '2426335.171088');
    assert.equal(splitFillEvent?.activity.metadata.quoteAmount, '3.8');
    assert.equal(splitFillEvent?.activity.metadata.displayTradeAmountText, '3.8 SOL');
    assert.equal(splitFillEvent?.activity.metadata.monitorReconciledSource, 'okx-detail');

    const failingTxHash = '3u5q6YVho2rAWhRSDv8KaJ2cbzgYXJpS3M6vN8uB8RMpwFKLyxj9pAPf6GoyJ7xaqS8J8VdyaTiT5hgs4P4h7qvT';
    const failingIngest = await ingestTelegramMonitorUpdate(buildTelegramUpdate(502, failingTxHash));
    assert.equal(failingIngest.ok, true, 'failing fixture should still ingest provisionally');

    globalThis.fetch = createFailingFetch() as typeof fetch;
    const failureResult = await reconcileTelegramMonitorTxState({
      chain: 'solana',
      trackedWalletAddress: TRACKED_SOL_ADDRESS,
      txHash: failingTxHash,
      force: true,
    });
    assert.equal(failureResult.status, 'failed', 'network failures should surface as failed reconciliations');
    const failedFeed = await readTelegramMonitorFeed(20);
    const failedRow = failedFeed.find((item) => item.activity.metadata.txHash === failingTxHash);
    assert.equal(
      failedRow?.activity.metadata.monitorReconciliationStatus,
      'failed',
      'failed reconciliation status should be visible in projected feed activity metadata'
    );

    globalThis.fetch = createSuccessfulFetch() as typeof fetch;
    const retryResult = await reconcileTelegramMonitorTxState({
      chain: 'solana',
      trackedWalletAddress: TRACKED_SOL_ADDRESS,
      txHash: TX_HASH,
      force: true,
    });
    assert.equal(retryResult.status, 'reconciled', 'a later retry should be able to recover');

    const { upsertTelegramMonitorTxStateProvisional } = await import('../lib/server/telegramMonitorTxStateRepo');
    const collapsedCanonicalState = upsertTelegramMonitorTxStateProvisional({
      userId: bscTrackedUser.id,
      chain: 'bsc',
      trackedWalletAddress: TRACKED_BSC_ADDRESS,
      txHash: BSC_TX_HASH,
      tokenAddress: BSC_TOKEN_ADDRESS,
      tokenSymbol: '阿生',
      provisionalAction: 'buy',
      provisionalActionLabel: '建仓',
      provisionalActionVariant: 'open',
      provisionalQuoteAmount: 0.2911,
      provisionalQuoteSymbol: 'BNB',
      provisionalTokenAmount: 32226211.41,
      provisionalTokenSymbol: '阿生',
      provisionalPriceUsd: 0.00000564,
      provisionalMarketCapUsd: 5600,
      provisionalRawText: [
        '[弘哥#2]',
        '🟢 New buy 0.2911 BNB',
        'Token: 32226211.41  [阿生]',
        'Price: $0.0{5}564',
        'MCAP: $5.6K',
        `CA: ${BSC_TOKEN_ADDRESS}`,
      ].join('\n'),
      provisionalWalletLabel: '弘哥#2',
      provisionalWalletAliasLabel: '弘哥#2',
      eventTimeMs: BSC_EVENT_TIME_MS,
    });
    assert.ok(collapsedCanonicalState, 'collapsed canonical fixture should create a tx-state');
    const collapsedCanonicalActivity = {
      id: buildExpectedMonitorEventId('bsc', TRACKED_BSC_ADDRESS, BSC_TX_HASH, BSC_TOKEN_ADDRESS),
      userId: bscTrackedUser.id,
      source: 'blockchain' as const,
      type: 'transfer' as const,
      title: '买入资产',
      content: '买入 0.000000000000000006 BNB',
      timestamp: BSC_EVENT_TIME_MS - 1000,
      metadata: {
        txHash: BSC_TX_HASH,
        value: '0.000000000000000006',
        token: 'BNB',
        tokenAddress: '',
        chain: 'bsc',
        fromAddress: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf07',
        toAddress: TRACKED_BSC_ADDRESS,
        txStatus: 'success',
        txAction: 'buy' as const,
        trackedAddress: TRACKED_BSC_ADDRESS,
        uncertainFrom: true,
      },
    };
    markTelegramMonitorTxStateReconciled({
      chain: 'bsc',
      trackedWalletAddress: TRACKED_BSC_ADDRESS,
      txHash: BSC_TX_HASH,
      source: 'okx-address',
      activity: collapsedCanonicalActivity,
    });
    upsertEventsFromFeedRows([{ user: bscTrackedUser, activity: collapsedCanonicalActivity }], 'telegram-monitor-reconcile');
    const healedCollapsedCanonicalFeed = await readTelegramMonitorFeed(50);
    const healedCollapsedCanonicalRow = healedCollapsedCanonicalFeed.find(
      (item) => item.activity.metadata.txHash === BSC_TX_HASH
    );
    assert.equal(
      healedCollapsedCanonicalRow?.activity.metadata.token,
      '阿生',
      'feed should prefer provisional non-native token when canonical token collapses to the native asset'
    );
    assert.equal(healedCollapsedCanonicalRow?.activity.metadata.tokenAddress, BSC_TOKEN_ADDRESS);
    assert.equal(healedCollapsedCanonicalRow?.activity.metadata.quoteAmount, '0.2911');
    assert.equal(healedCollapsedCanonicalRow?.activity.metadata.displayTokenSymbol, '阿生');
    const healedCollapsedCanonicalEvents = readEventsFeed({
      limit: 50,
      userId: bscTrackedUser.id,
    });
    const healedCollapsedCanonicalEvent = healedCollapsedCanonicalEvents.feed.find(
      (item) => item.activity.metadata.txHash === BSC_TX_HASH
    );
    assert.equal(
      healedCollapsedCanonicalEvent?.activity.metadata.token,
      '阿生',
      'events feed should also self-heal collapsed canonical monitor tokens from provisional tx-state data'
    );
    assert.equal(healedCollapsedCanonicalEvent?.activity.metadata.tokenAddress, BSC_TOKEN_ADDRESS);
    assert.equal(healedCollapsedCanonicalEvent?.activity.metadata.displayTokenSymbol, '阿生');
    const persistedCollapsedCanonicalState = db
      .prepare(
        `SELECT canonical_activity_json
         FROM telegram_monitor_tx_states
         WHERE chain = ?
           AND tracked_wallet_address_lower = ?
           AND tx_hash_lower = ?`
      )
      .get('bsc', TRACKED_BSC_ADDRESS.toLowerCase(), BSC_TX_HASH.toLowerCase()) as
      | { canonical_activity_json: string | null }
      | undefined;
    const persistedCollapsedCanonicalActivity = persistedCollapsedCanonicalState?.canonical_activity_json
      ? (JSON.parse(persistedCollapsedCanonicalState.canonical_activity_json) as { metadata?: Record<string, unknown> })
      : null;
    assert.equal(
      persistedCollapsedCanonicalActivity?.metadata?.token,
      '阿生',
      'collapsed canonical tx-state rows should be healed in storage so non-healing consumers do not keep seeing the native token'
    );
    assert.equal(
      persistedCollapsedCanonicalActivity?.metadata?.tokenAddress,
      BSC_TOKEN_ADDRESS,
      'collapsed canonical tx-state rows should persist the provisional token address after healing'
    );
    const persistedCollapsedCanonicalEventRow = db
      .prepare(
        `SELECT activity_json
         FROM events
         WHERE event_id = ?`
      )
      .get(buildExpectedMonitorEventId('bsc', TRACKED_BSC_ADDRESS, BSC_TX_HASH, BSC_TOKEN_ADDRESS)) as
      | { activity_json: string | null }
      | undefined;
    const persistedCollapsedCanonicalEventActivity = persistedCollapsedCanonicalEventRow?.activity_json
      ? (JSON.parse(persistedCollapsedCanonicalEventRow.activity_json) as { metadata?: Record<string, unknown> })
      : null;
    assert.equal(
      persistedCollapsedCanonicalEventActivity?.metadata?.token,
      '阿生',
      'collapsed canonical event rows should also be healed in storage for downstream readers outside readEventsFeed'
    );
    assert.equal(
      persistedCollapsedCanonicalEventActivity?.metadata?.tokenAddress,
      BSC_TOKEN_ADDRESS,
      'collapsed canonical event rows should persist the provisional token address after healing'
    );

    // Solana path: OKX detail often labels WSOL mint as symbol=UNKNOWN (not SOL/WSOL).
    // Collapse repair must treat UNKNOWN + So1111… as collapsed, not leave Jimothy as UNKNOWN.
    const unknownCollapsedState = upsertTelegramMonitorTxStateProvisional({
      userId: trackedUser.id,
      chain: 'solana',
      trackedWalletAddress: TRACKED_SOL_ADDRESS,
      txHash: SOL_UNKNOWN_COLLAPSE_TX_HASH,
      tokenAddress: SOL_UNKNOWN_COLLAPSE_TOKEN_ADDRESS,
      tokenSymbol: 'Jimothy',
      provisionalAction: 'buy',
      provisionalActionLabel: '加仓',
      provisionalActionVariant: 'add',
      provisionalQuoteAmount: 1.99,
      provisionalQuoteSymbol: 'SOL',
      provisionalTokenAmount: 14590.72,
      provisionalTokenSymbol: 'Jimothy',
      provisionalPriceUsd: 0.0104,
      provisionalMarketCapUsd: 10_300_000,
      provisionalRawText: [
        '[Finn#1]',
        '🟢 Buy more 1.99 SOL',
        'Token: 14590.72  [Jimothy]',
        'Price: $0.0104',
        'MCAP: $10.3M',
        `CA: ${SOL_UNKNOWN_COLLAPSE_TOKEN_ADDRESS}`,
      ].join('\n'),
      provisionalWalletLabel: 'Finn#1',
      provisionalWalletAliasLabel: 'Finn#1',
      eventTimeMs: SOL_UNKNOWN_COLLAPSE_EVENT_TIME_MS,
    });
    assert.ok(unknownCollapsedState, 'UNKNOWN collapse fixture should create a tx-state');
    const unknownCollapsedActivity = {
      id: buildExpectedMonitorEventId(
        'solana',
        TRACKED_SOL_ADDRESS,
        SOL_UNKNOWN_COLLAPSE_TX_HASH,
        SOL_LEGACY_WSOL_MINT
      ),
      userId: trackedUser.id,
      source: 'blockchain' as const,
      type: 'transfer' as const,
      title: '收到转账 (Token)',
      content: '收到 0.008 UNKNOWN',
      timestamp: SOL_UNKNOWN_COLLAPSE_EVENT_TIME_MS,
      metadata: {
        txHash: SOL_UNKNOWN_COLLAPSE_TX_HASH,
        value: '0.008',
        token: 'UNKNOWN',
        tokenAddress: SOL_LEGACY_WSOL_MINT,
        chain: 'solana',
        fromAddress: TRACKED_SOL_ADDRESS,
        toAddress: '8ckLnP69xhSeoNbZCUrbJZ8aYSR86QNjRVZdpHmFfigk',
        txStatus: 'success',
        txAction: 'receive' as const,
        trackedAddress: TRACKED_SOL_ADDRESS,
        uncertainFrom: false,
        displayTokenSymbol: 'UNKNOWN',
        displayTokenAvatarTokenAddress: SOL_LEGACY_WSOL_MINT,
        displayTradeAmountText: '0.008 UNKNOWN',
      },
    };
    markTelegramMonitorTxStateReconciled({
      chain: 'solana',
      trackedWalletAddress: TRACKED_SOL_ADDRESS,
      txHash: SOL_UNKNOWN_COLLAPSE_TX_HASH,
      tokenAddress: SOL_UNKNOWN_COLLAPSE_TOKEN_ADDRESS,
      source: 'okx-detail',
      activity: unknownCollapsedActivity,
    });
    upsertEventsFromFeedRows(
      [{ user: trackedUser, activity: unknownCollapsedActivity }],
      'telegram-monitor-reconcile'
    );

    const healedUnknownCollapseFeed = await readTelegramMonitorFeed(50);
    const healedUnknownCollapseRow = healedUnknownCollapseFeed.find(
      (item) => item.activity.metadata.txHash === SOL_UNKNOWN_COLLAPSE_TX_HASH
    );
    assert.equal(
      healedUnknownCollapseRow?.activity.metadata.token,
      'Jimothy',
      'feed should heal UNKNOWN + native mint collapse back to provisional Jimothy'
    );
    assert.equal(
      healedUnknownCollapseRow?.activity.metadata.tokenAddress,
      SOL_UNKNOWN_COLLAPSE_TOKEN_ADDRESS,
      'feed should restore provisional mint when canonical collapsed to So1111…'
    );
    assert.equal(healedUnknownCollapseRow?.activity.metadata.displayTokenSymbol, 'JIMOTHY');

    const healedUnknownCollapseEvents = readEventsFeed({
      limit: 50,
      userId: trackedUser.id,
    });
    const healedUnknownCollapseEvent = healedUnknownCollapseEvents.feed.find(
      (item) => item.activity.metadata.txHash === SOL_UNKNOWN_COLLAPSE_TX_HASH
    );
    assert.equal(
      healedUnknownCollapseEvent?.activity.metadata.token,
      'Jimothy',
      'events feed should heal UNKNOWN collapse from provisional tx-state data'
    );
    assert.equal(
      healedUnknownCollapseEvent?.activity.metadata.tokenAddress,
      SOL_UNKNOWN_COLLAPSE_TOKEN_ADDRESS
    );

    const persistedUnknownCollapseState = db
      .prepare(
        `SELECT canonical_activity_json
         FROM telegram_monitor_tx_states
         WHERE chain = ?
           AND tracked_wallet_address_lower = ?
           AND tx_hash_lower = ?`
      )
      .get('solana', TRACKED_SOL_ADDRESS.toLowerCase(), SOL_UNKNOWN_COLLAPSE_TX_HASH.toLowerCase()) as
      | { canonical_activity_json: string | null }
      | undefined;
    const persistedUnknownCollapseActivity = persistedUnknownCollapseState?.canonical_activity_json
      ? (JSON.parse(persistedUnknownCollapseState.canonical_activity_json) as {
          metadata?: Record<string, unknown>;
        })
      : null;
    assert.equal(
      persistedUnknownCollapseActivity?.metadata?.token,
      'Jimothy',
      'UNKNOWN-collapsed canonical tx-state rows should be healed in storage'
    );
    assert.equal(
      persistedUnknownCollapseActivity?.metadata?.tokenAddress,
      SOL_UNKNOWN_COLLAPSE_TOKEN_ADDRESS,
      'UNKNOWN-collapsed canonical tx-state rows should persist the provisional mint after healing'
    );

    const missingQuoteCanonicalState = upsertTelegramMonitorTxStateProvisional({
      userId: bscTrackedUser.id,
      chain: 'bsc',
      trackedWalletAddress: TRACKED_BSC_ADDRESS,
      txHash: BSC_MISSING_QUOTE_TX_HASH,
      tokenAddress: BSC_MISSING_QUOTE_TOKEN_ADDRESS,
      tokenSymbol: '中本聪',
      provisionalAction: 'sell',
      provisionalActionLabel: '减仓',
      provisionalActionVariant: 'reduce',
      provisionalQuoteAmount: 0.0362,
      provisionalQuoteSymbol: 'BNB',
      provisionalTokenAmount: 4264.52,
      provisionalTokenSymbol: '中本聪',
      provisionalPriceUsd: 0.00000849,
      provisionalMarketCapUsd: 90900,
      provisionalRawText: [
        '[User_D#1]',
        '🔴 Sell Part 0.0362 BNB',
        'Token: 4264.52  [中本聪]',
        'Price: $0.0{5}849',
        'MCAP: $90.9K',
        `CA: ${BSC_MISSING_QUOTE_TOKEN_ADDRESS}`,
      ].join('\n'),
      provisionalWalletLabel: 'Finn',
      provisionalWalletAliasLabel: 'User_D#1',
      eventTimeMs: BSC_MISSING_QUOTE_EVENT_TIME_MS,
    });
    assert.ok(missingQuoteCanonicalState, 'missing quote canonical fixture should create a tx-state');
    const missingQuoteCanonicalActivity = {
      id: buildExpectedMonitorEventId(
        'bsc',
        TRACKED_BSC_ADDRESS,
        BSC_MISSING_QUOTE_TX_HASH,
        BSC_MISSING_QUOTE_TOKEN_ADDRESS
      ),
      userId: bscTrackedUser.id,
      source: 'blockchain' as const,
      type: 'transfer' as const,
      title: '卖出资产',
      content: '卖出 4264.520655854 中本聪',
      timestamp: BSC_MISSING_QUOTE_EVENT_TIME_MS - 1000,
      metadata: {
        txHash: BSC_MISSING_QUOTE_TX_HASH,
        value: '4264.520655854',
        token: '中本聪',
        tokenAddress: BSC_MISSING_QUOTE_TOKEN_ADDRESS,
        chain: 'bsc',
        fromAddress: TRACKED_BSC_ADDRESS,
        toAddress: '0xrouter000000000000000000000000000000000001',
        txStatus: 'success',
        txAction: 'sell' as const,
        trackedAddress: TRACKED_BSC_ADDRESS,
        rawText: [
          '[User_D#1]',
          '🔴 Sell Part 0.0362 BNB',
          'Token: 4264.52  [中本聪]',
          'Price: $0.0{5}849',
          'MCAP: $90.9K',
          `CA: ${BSC_MISSING_QUOTE_TOKEN_ADDRESS}`,
        ].join('\n'),
        uncertainFrom: false,
        monitorReconciliationStatus: 'reconciled' as const,
        monitorReconciledSource: 'okx-address' as const,
      },
    };
    markTelegramMonitorTxStateReconciled({
      chain: 'bsc',
      trackedWalletAddress: TRACKED_BSC_ADDRESS,
      txHash: BSC_MISSING_QUOTE_TX_HASH,
      source: 'okx-address',
      activity: missingQuoteCanonicalActivity,
    });
    upsertEventsFromFeedRows([{ user: bscTrackedUser, activity: missingQuoteCanonicalActivity }], 'telegram-monitor-reconcile');
    const healedMissingQuoteFeed = await readTelegramMonitorFeed(50);
    const healedMissingQuoteRow = healedMissingQuoteFeed.find(
      (item) => item.activity.metadata.txHash === BSC_MISSING_QUOTE_TX_HASH
    );
    assert.equal(
      healedMissingQuoteRow?.activity.title,
      '卖出资产',
      'quote repair should preserve canonical titles while filling missing trade quote metadata'
    );
    assert.equal(healedMissingQuoteRow?.activity.metadata.quoteAmount, '0.0362');
    assert.equal(healedMissingQuoteRow?.activity.metadata.quoteToken, 'BNB');
    assert.equal(healedMissingQuoteRow?.activity.metadata.displayTradeAmountText, '0.036 BNB');
    assert.equal(healedMissingQuoteRow?.activity.metadata.displayActionVariantLabel, '减仓');
    const healedMissingQuoteEvents = readEventsFeed({
      limit: 50,
      userId: bscTrackedUser.id,
    });
    const healedMissingQuoteEvent = healedMissingQuoteEvents.feed.find(
      (item) => item.activity.metadata.txHash === BSC_MISSING_QUOTE_TX_HASH
    );
    assert.equal(healedMissingQuoteEvent?.activity.title, '卖出资产');
    assert.equal(healedMissingQuoteEvent?.activity.metadata.quoteAmount, '0.0362');
    assert.equal(healedMissingQuoteEvent?.activity.metadata.quoteToken, 'BNB');
    assert.equal(healedMissingQuoteEvent?.activity.metadata.displayTradeAmountText, '0.036 BNB');
    assert.equal(healedMissingQuoteEvent?.activity.metadata.displayActionVariantLabel, '减仓');

    const batchLoadedStates = listTelegramMonitorTxStatesByKeys([
      { chain: 'bsc', trackedWalletAddress: TRACKED_BSC_ADDRESS, txHash: BSC_TX_HASH },
      { chain: 'solana', trackedWalletAddress: TRACKED_SOL_ADDRESS, txHash: TX_HASH },
      { chain: 'bsc', trackedWalletAddress: TRACKED_BSC_ADDRESS, txHash: BSC_TX_HASH },
    ]);
    assert.equal(batchLoadedStates.size, 2, 'batch tx-state lookup should de-duplicate repeated monitor keys');
    assert.equal(batchLoadedStates.get(`bsc|${TRACKED_BSC_ADDRESS.toLowerCase()}|${BSC_TX_HASH.toLowerCase()}`)?.tokenSymbol, '阿生');
    assert.equal(
      batchLoadedStates.get(`solana|${TRACKED_SOL_ADDRESS.toLowerCase()}|${TX_HASH.toLowerCase()}`)?.provisionalTokenSymbol,
      'HENRY'
    );

    for (let index = 0; index < 30; index += 1) {
      const txHash = `crowded-backed-${index.toString().padStart(2, '0')}`;
      const eventTimeMs = TX_TIME_MS + 100_000 + index * 1_000;
      const crowdedEvent = upsertTelegramMonitorEvent({
        provider: 'xxyy',
        sourceChatId: '-100123456',
        sourceMessageId: 2_000 + index,
        updateId: 820_000 + index,
        chain: 'solana',
        tokenAddress: TOKEN_ADDRESS,
        tokenSymbol: 'HENRY',
        txHash,
        marketCapUsd: 239_000,
        priceUsd: 0.000239,
        quoteAmount: 0.11 + index / 1000,
        quoteSymbol: 'SOL',
        action: 'buy',
        actionLabel: '建仓',
        actionVariant: 'open',
        walletLabel: 'henry',
        walletGroupLabel: 'xp',
        walletAliasLabel: 'user_a#1',
        trackedWalletAddress: TRACKED_SOL_ADDRESS,
        eventTimeMs,
        rawText: `[xp] [user_a#1]\n🟢 New buy ${(0.11 + index / 1000).toFixed(4)} SOL`,
        messageLinks: [`https://solscan.io/tx/${txHash}`],
        payload: { crowded: true, txHash },
      });
      assert.equal(crowdedEvent.ok, true, `crowded backed raw event ${index + 1} should insert`);
      const crowdedDuplicateEvent = upsertTelegramMonitorEvent({
        provider: 'xxyy',
        sourceChatId: '-100123456',
        sourceMessageId: 2_500 + index,
        updateId: 825_000 + index,
        chain: 'solana',
        tokenAddress: TOKEN_ADDRESS,
        tokenSymbol: 'HENRY',
        txHash,
        marketCapUsd: 239_000,
        priceUsd: 0.000239,
        quoteAmount: 0.21 + index / 1000,
        quoteSymbol: 'SOL',
        action: 'buy',
        actionLabel: '建仓',
        actionVariant: 'open',
        walletLabel: 'henry',
        walletGroupLabel: 'xp',
        walletAliasLabel: 'user_a#1',
        trackedWalletAddress: TRACKED_SOL_ADDRESS,
        eventTimeMs: eventTimeMs + 100,
        rawText: `[xp] [user_a#1]\n🟢 New buy ${(0.21 + index / 1000).toFixed(4)} SOL`,
        messageLinks: [`https://solscan.io/tx/${txHash}`],
        payload: { crowdedDuplicate: true, txHash },
      });
      assert.equal(
        crowdedDuplicateEvent.ok,
        true,
        `crowded backed duplicate raw event ${index + 1} should insert`
      );

      const crowdedTxState = upsertTelegramMonitorTxStateProvisional({
        userId: trackedUser.id,
        chain: 'solana',
        trackedWalletAddress: TRACKED_SOL_ADDRESS,
        txHash,
        tokenAddress: TOKEN_ADDRESS,
        tokenSymbol: 'HENRY',
        provisionalAction: 'buy',
        provisionalActionLabel: '建仓',
        provisionalActionVariant: 'open',
        provisionalQuoteAmount: 0.11 + index / 1000,
        provisionalQuoteSymbol: 'SOL',
        provisionalTokenAmount: 45_000 + index,
        provisionalTokenSymbol: 'HENRY',
        provisionalPriceUsd: 0.000239,
        provisionalMarketCapUsd: 239_000,
        provisionalRawText: `[xp] [user_a#1]\n🟢 New buy ${(0.11 + index / 1000).toFixed(4)} SOL`,
        provisionalWalletLabel: 'henry',
        provisionalWalletGroupLabel: 'xp',
        provisionalWalletAliasLabel: 'user_a#1',
        eventTimeMs,
      });
      assert.ok(crowdedTxState, `crowded tx-state ${index + 1} should insert`);
    }

    const crowdedLegacyHashes: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const txHash = `crowded-legacy-${index.toString().padStart(2, '0')}`;
      crowdedLegacyHashes.push(txHash);
      const crowdedLegacyEvent = upsertTelegramMonitorEvent({
        provider: 'xxyy',
        sourceChatId: '-100123456',
        sourceMessageId: 3_000 + index,
        updateId: 830_000 + index,
        chain: 'solana',
        tokenAddress: TOKEN_ADDRESS,
        tokenSymbol: 'HENRY',
        txHash,
        marketCapUsd: 239_000,
        priceUsd: 0.000239,
        quoteAmount: 0.5 + index / 1000,
        quoteSymbol: 'SOL',
        action: 'buy',
        actionLabel: '建仓',
        actionVariant: 'open',
        walletLabel: 'henry',
        walletGroupLabel: 'xp',
        walletAliasLabel: 'user_a#1',
        trackedWalletAddress: TRACKED_SOL_ADDRESS,
        eventTimeMs: TX_TIME_MS - 200_000 - index * 1_000,
        rawText: `[xp] [user_a#1]\n🟢 New buy ${(0.5 + index / 1000).toFixed(4)} SOL`,
        messageLinks: [`https://solscan.io/tx/${txHash}`],
        payload: { crowdedLegacy: true, txHash },
      });
      assert.equal(crowdedLegacyEvent.ok, true, `crowded legacy raw event ${index + 1} should insert`);
    }

    const crowdedFeed = await readTelegramMonitorFeed(50);
    assert.equal(crowdedFeed.length, 50, 'monitor feed should fill the requested page size under crowded fallback');
    const crowdedLegacyRows = crowdedFeed.filter((item) =>
      crowdedLegacyHashes.includes(item.activity.metadata.txHash || '')
    );
    assert.ok(
      crowdedLegacyRows.length > 0,
      'monitor feed should still surface legacy-only rows when newer backed raw rows crowd the window'
    );

    const repairTxHashes = [
      '6eKxTv5L7v8rjv8L22oNgmop3WECrNBo6mQjK6D5k1dYH8WwLr1U65GmNQYmK4WJH2efv2vgQJpQmYv8TtS5ePv1',
      '7cNrJ2vJ5rLxS4FeM9qn8b8yjaTNhvS8cfsNwVwb7mCF98V7R6X5JQY2r5D9oJm5vh4udv89bF3yVqW9Amn2rGm2',
      '8pQxW5vTd7LkN1mQ4hVuB2rPx3cZjJ9fLs7mN2dR6vYqW8nCb4rT5uKp1mG6xYv3cL8qNf1dS7mR4tV9pBx2wHm3',
    ];
    for (const [index, repairTxHash] of repairTxHashes.entries()) {
      const repairIngest = await ingestTelegramMonitorUpdate(buildTelegramUpdate(700 + index, repairTxHash));
      assert.equal(repairIngest.ok, true, `repair fixture ${index + 1} should ingest`);
    }

    const claimBaseMs = Date.now() - 10_000;
    db.prepare(
      `UPDATE telegram_monitor_tx_states
       SET reconciliation_status = 'failed',
           next_retry_at = ?,
           retry_count = 1,
           last_error = 'fixture-failed',
           repair_claimed_at = NULL`
    ).run(claimBaseMs + 5_000);
    db.prepare(
      `UPDATE telegram_monitor_tx_states
       SET next_retry_at = ?
       WHERE tx_hash_lower = ?`
    ).run(claimBaseMs + 1_000, repairTxHashes[0].toLowerCase());
    db.prepare(
      `UPDATE telegram_monitor_tx_states
       SET next_retry_at = ?
       WHERE tx_hash_lower = ?`
    ).run(claimBaseMs + 2_000, repairTxHashes[1].toLowerCase());
    db.prepare(
      `UPDATE telegram_monitor_tx_states
       SET next_retry_at = ?
       WHERE tx_hash_lower = ?`
    ).run(claimBaseMs + 3_000, repairTxHashes[2].toLowerCase());

    const firstRepairClaim = claimTelegramMonitorTxStatesForRepair({
      limit: 2,
      nowMs: claimBaseMs + 10_000,
    });
    assert.deepEqual(
      firstRepairClaim.map((item) => item.txHash),
      repairTxHashes.slice(0, 2),
      'repair queue should claim oldest-due monitor txs first'
    );

    const secondRepairClaim = claimTelegramMonitorTxStatesForRepair({
      limit: 2,
      nowMs: claimBaseMs + 10_500,
    });
    assert.deepEqual(
      secondRepairClaim.map((item) => item.txHash),
      [],
      'active repair claims should suppress duplicate reclaims during the lease window'
    );

    console.log('telegram monitor reconciliation tests: ok');
  } finally {
    globalThis.fetch = previousFetch;
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
