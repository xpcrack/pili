import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

process.env.OKX_API_KEY ??= 'fixture-okx-key';
process.env.OKX_SECRET_KEY ??= 'fixture-okx-secret';
process.env.OKX_API_PASSPHRASE ??= 'fixture-okx-passphrase';
process.env.TELEGRAM_MONITOR_INGEST_TOKEN ??= 'fixture-telegram-ingest-token';

const TRACKED_SOL_ADDRESS = 'testuser_solana_placeholder_1111111111111111';
const TX_HASH = '2tLRE1WugGAJquDrSph5XMMySFBBDmnxRgEsKPgr1tRCjqiFmLoT345V3DfkQASSdc3BMUx2brt3xEauGLsQNJsQ';
const TOKEN_ADDRESS = 'CJUrENDAuSm4FxxziUgftnUJqqXjm4VL1zhJgwXupump';
const TX_TIME_MS = 1777178981000;
const TRACKED_BSC_ADDRESS = '0x7592ca1ad468ddac5a97a5625c1c55e36338f786';
const BSC_TX_HASH = '0x9e4de1b154b0664ab97aeadec2ceee38930360b786c8b36197793475441e0878';
const BSC_TOKEN_ADDRESS = '0x930809fb99dd10d404504d1603e8756eafd84444';
const BSC_EVENT_TIME_MS = 1777865833000;
const BSC_MISSING_QUOTE_TX_HASH = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const BSC_MISSING_QUOTE_TOKEN_ADDRESS = '0xe68bd56b99ab9a527375bd87bf03ee6344f68ca1';
const BSC_MISSING_QUOTE_EVENT_TIME_MS = 1777933730000;
const SPLIT_FILL_TX_HASH =
  'placeholder_private_key_111111111111111111111111111111111111111111111111111111111111111111111111111111';
const SPLIT_FILL_TOKEN_ADDRESS = '2CKp88BFyPzr7gEuQKXMJ9cqa24AFXUNC41FR7udpump';

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
      `xxyy-monitor:solana:${TRACKED_SOL_ADDRESS.toLowerCase()}:${TX_HASH.toLowerCase()}`,
      'monitor events should use stable tx identity'
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
      id: `xxyy-monitor:bsc:${TRACKED_BSC_ADDRESS.toLowerCase()}:${BSC_TX_HASH.toLowerCase()}`,
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
      id: `xxyy-monitor:bsc:${TRACKED_BSC_ADDRESS.toLowerCase()}:${BSC_MISSING_QUOTE_TX_HASH.toLowerCase()}`,
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
