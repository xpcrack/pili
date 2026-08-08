import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';
import { telegramMonitorFixtureCases } from './fixtures/parser-fixtures';

const dataDir = mkdtempSync(path.join(tmpdir(), 'pili-fast-ingest-'));
process.env.PILIPILI_DATA_DIR = dataDir;
process.env.PILIPILI_DB_PATH = path.join(dataDir, 'test.sqlite');
process.env.PILI_XXYY_FEED = 'doorbell';
process.env.PILI_LIVE_SOURCE = 'dual';
process.env.PILI_DISABLE_TELEGRAM_MONITOR_AUTO_RECONCILE = '1';
process.env.OKX_API_KEY = 'test-key';
process.env.OKX_SECRET_KEY = 'test-secret';
process.env.OKX_API_PASSPHRASE = 'test-passphrase';

const originalFetch = globalThis.fetch;

async function main() {
  const fixture = telegramMonitorFixtureCases.find((item) => item.name === 'xxyy-bot-to-bot-buy');
  assert.ok(fixture);

  const { getDb } = await import('../lib/server/sqlite');
  const { saveSystemConfig } = await import('../lib/server/systemConfigRepo');
  const { createTrackedUser } = await import('../lib/server/trackedUsersRepo');
  const { ingestTelegramMonitorUpdate } = await import('../lib/server/telegramMonitorIngest');

  saveSystemConfig({ telegramTradeMonitorSourceChatId: '-100123456' });
  const user = createTrackedUser({
    name: 'finn',
    handle: 'finn',
    avatar: 'finn.png',
    twitter: undefined,
    telegram: undefined,
    addresses: [
      {
        address: fixture.expected.trackedWalletAddress!,
        name: '#1',
        chain: 'bsc',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
    ],
    totalAssetUsd: 0,
    mainstreamAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: ['fixture'],
  });

  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('network must not be used by fast XXYY ingest');
  }) as typeof fetch;

  const result = await ingestTelegramMonitorUpdate({
    update_id: 910101,
    message: {
      message_id: 611,
      date: Math.floor(fixture.fallbackTimestampMs / 1000),
      chat: { id: -100123456 },
      text: fixture.text,
      entities: [{ type: 'text_link', url: fixture.linkCandidates[0] }],
      reply_markup: {
        inline_keyboard: [[{ text: 'Bscscan', url: fixture.linkCandidates[1] }]],
      },
    },
  });

  const provisional = getDb()
    .prepare(`SELECT event_id, activity_json FROM events WHERE user_id = ? AND LOWER(COALESCE(tx_hash, '')) = ?`)
    .all(user.id, fixture.expected.txHash!.toLowerCase()) as Array<{
      event_id: string;
      activity_json: string;
    }>;

  assert.equal(fetchCalls, 0, 'fast XXYY ingest must not call the network');
  assert.equal(result.projected, true, 'fast XXYY ingest should still project a provisional Feed row');
  assert.equal(result.feedMode, 'doorbell');
  assert.equal(provisional.length, 1, 'the provisional transaction should be visible exactly once');
  assert.match(provisional[0]!.event_id, /^xxyy-monitor:/);
  const provisionalActivity = JSON.parse(provisional[0]!.activity_json) as {
    metadata?: { quoteAmount?: string; quoteToken?: string; tradeAmountUsdAtTx?: number };
  };
  assert.equal(provisionalActivity.metadata?.quoteAmount, String(fixture.expected.quoteAmount));
  assert.equal(provisionalActivity.metadata?.quoteToken, fixture.expected.quoteSymbol);
  assert.equal(
    provisionalActivity.metadata?.tradeAmountUsdAtTx,
    fixture.expected.tradeAmountUsdAtTx,
    'XXYY price and token quantity should provide a local USD amount without network access'
  );
}

main()
  .finally(() => {
    globalThis.fetch = originalFetch;
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
