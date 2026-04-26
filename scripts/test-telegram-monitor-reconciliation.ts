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
    } = await import('../lib/server/telegramMonitorTxStateRepo');
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

    globalThis.fetch = createSuccessfulFetch() as typeof fetch;
    const provisionalResult = await ingestTelegramMonitorUpdate(buildTelegramUpdate(501));
    assert.equal(provisionalResult.ok, true, 'ingest should accept the telegram update');

    const provisionalFeed = await readTelegramMonitorFeed(20);
    assert.equal(provisionalFeed.length, 1, 'provisional monitor feed should have one row');
    assert.equal(provisionalFeed[0]?.activity.metadata.quoteAmount, '0.1181');
    assert.equal(provisionalFeed[0]?.activity.metadata.monitorReconciliationStatus, 'pending');

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
    assert.equal(reconciled.source, 'okx-address');

    const reconciledFeed = await readTelegramMonitorFeed(20);
    const reconciledPrimaryRow = reconciledFeed.find((item) => item.activity.metadata.txHash === TX_HASH);
    assert.equal(
      reconciledFeed.filter((item) => item.activity.metadata.txHash === TX_HASH).length,
      1,
      'reconciled feed should keep one logical row for the corrected tx'
    );
    assert.equal(reconciledPrimaryRow?.activity.metadata.quoteAmount, '0.2502');
    assert.equal(reconciledPrimaryRow?.activity.metadata.value, '94464.94413');
    assert.equal(reconciledPrimaryRow?.activity.metadata.monitorReconciliationStatus, 'reconciled');
    assert.equal(reconciledPrimaryRow?.activity.metadata.monitorReconciledSource, 'okx-address');

    const reconciledEvents = readEventsFeed({
      limit: 20,
      userId: trackedUser.id,
    });
    assert.equal(reconciledEvents.total, 1, 'reconciliation should overwrite the existing event in place');
    assert.equal(reconciledEvents.feed[0]?.activity.metadata.quoteAmount, '0.2502');

    globalThis.fetch = createDetailFallbackFetch() as typeof fetch;
    const detailFallback = await reconcileTelegramMonitorTxState({
      chain: 'solana',
      trackedWalletAddress: TRACKED_SOL_ADDRESS,
      txHash: TX_HASH,
      force: true,
    });
    assert.equal(detailFallback.status, 'reconciled', 'detail fallback should still reconcile');
    assert.equal(detailFallback.source, 'okx-detail');

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

    globalThis.fetch = createSuccessfulFetch() as typeof fetch;
    const retryResult = await reconcileTelegramMonitorTxState({
      chain: 'solana',
      trackedWalletAddress: TRACKED_SOL_ADDRESS,
      txHash: TX_HASH,
      force: true,
    });
    assert.equal(retryResult.status, 'reconciled', 'a later retry should be able to recover');

    const { upsertTelegramMonitorTxStateProvisional } = await import('../lib/server/telegramMonitorTxStateRepo');
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
