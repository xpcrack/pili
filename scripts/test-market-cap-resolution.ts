import assert from 'node:assert/strict';

import { getDb } from '@/lib/server/sqlite';
import { resolveTransactionTimeMarketCap } from '@/lib/tokenLogo';
import { findTelegramMonitorMarketCapAtTx, upsertTelegramMonitorEvent } from '@/lib/server/telegramMonitorRepo';

const CHAIN = 'bsc';
const TOKEN = '0x000000000000000000000000000000000000cafe';
const TX_EXACT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TX_OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TX_TIME = 1710000000000;

process.env.XXYY_API_KEY = 'fixture_xxyy_key';

function createJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function seedTelegramRows() {
  upsertTelegramMonitorEvent({
    provider: 'xxyy',
    sourceChatId: '-100900001',
    sourceMessageId: 1,
    chain: CHAIN,
    tokenAddress: TOKEN,
    txHash: TX_EXACT,
    marketCapUsd: 123456,
    eventTimeMs: TX_TIME,
    rawText: 'fixture exact',
  });

  upsertTelegramMonitorEvent({
    provider: 'xxyy',
    sourceChatId: '-100900001',
    sourceMessageId: 2,
    chain: CHAIN,
    tokenAddress: TOKEN,
    txHash: null,
    marketCapUsd: 777777,
    eventTimeMs: TX_TIME + 30 * 60 * 1000,
    rawText: 'fixture nearby',
  });
}

function resetTelegramRows() {
  const db = getDb();
  db.prepare('DELETE FROM telegram_monitor_events WHERE provider = ? AND token_address_lower = ?').run(
    'xxyy',
    TOKEN.toLowerCase()
  );
}

async function run() {
  const originalFetch = globalThis.fetch;

  resetTelegramRows();
  seedTelegramRows();

  try {
    const exact = findTelegramMonitorMarketCapAtTx({
      chain: CHAIN,
      tokenAddress: TOKEN,
      txHash: TX_EXACT,
    });
    assert.equal(exact?.marketCapUsd, 123456, 'exact tx should match telegram exact row');

    const noNearest = findTelegramMonitorMarketCapAtTx({
      chain: CHAIN,
      tokenAddress: TOKEN,
      txHash: TX_OTHER,
    });
    assert.equal(noNearest, null, 'non-matching tx must not use nearest fallback');

    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('/api/trade/open/api/query?')) {
        return createJsonResponse({
          code: 200,
          success: true,
          data: {
            tradeInfo: {
              marketCapUsd: 100000,
              price: 0.01,
            },
          },
        });
      }

      if (url.includes('/api/v6/dex/market/historical-candles?')) {
        return createJsonResponse({
          code: '0',
          data: [[String(TX_TIME), '0', '0', '0', '0.005', '0', '0', '1']],
        });
      }

      if (url.includes('/token-pairs/v1/')) {
        return createJsonResponse([]);
      }

      throw new Error(`Unhandled fetch in test-market-cap-resolution: ${url}`);
    };

    const exactResolution = await resolveTransactionTimeMarketCap({
      chain: CHAIN,
      tokenAddress: TOKEN,
      txHash: TX_EXACT,
      txTimestampMs: TX_TIME,
    });
    assert.equal(exactResolution.marketCapAtTxUsd, 123456, 'exact resolution should win over estimation');
    assert.equal(exactResolution.marketCapAtTxEstimated, false, 'exact resolution should not be estimated');
    assert.equal(
      exactResolution.marketCapAtTxSource,
      'telegram-monitor-exact',
      'exact resolution source should be telegram-monitor-exact'
    );

    const estimatedResolution = await resolveTransactionTimeMarketCap({
      chain: CHAIN,
      tokenAddress: TOKEN,
      txHash: TX_OTHER,
      txTimestampMs: TX_TIME,
    });
    assert.equal(estimatedResolution.marketCapAtTxUsd, 50000, 'estimated resolution should use price-derived market cap');
    assert.equal(estimatedResolution.marketCapAtTxEstimated, true, 'estimated resolution should be marked estimated');
    assert.equal(estimatedResolution.marketCapAtTxSource, 'estimated', 'estimated source should be marked estimated');

    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/trade/open/api/query?')) {
        return createJsonResponse({
          code: 200,
          success: true,
          data: {
            tradeInfo: {
              marketCapUsd: 100000,
              price: 0.01,
            },
          },
        });
      }
      if (url.includes('/token-pairs/v1/')) {
        return createJsonResponse([]);
      }
      if (url.includes('/api/v6/dex/market/historical-candles?')) {
        return createJsonResponse({ code: '0', data: [] });
      }
      throw new Error(`Unhandled fetch in missing-price branch: ${url}`);
    };

    const missingHistory = await resolveTransactionTimeMarketCap({
      chain: CHAIN,
      tokenAddress: TOKEN,
      txHash: TX_OTHER,
      txTimestampMs: TX_TIME,
    });
    assert.equal(missingHistory.marketCapAtTxUsd, null, 'missing tx history price should return null');
    assert.equal(missingHistory.marketCapAtTxEstimated, false, 'missing tx history price should not be estimated');

    console.log('PASS market-cap-resolution');
  } finally {
    globalThis.fetch = originalFetch;
    resetTelegramRows();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

