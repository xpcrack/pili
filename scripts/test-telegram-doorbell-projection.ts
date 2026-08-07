import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';
import { telegramMonitorFixtureCases } from './fixtures/parser-fixtures';

const dataDir = mkdtempSync(path.join(tmpdir(), 'pili-doorbell-projection-'));
process.env.PILIPILI_DATA_DIR = dataDir;
process.env.PILIPILI_DB_PATH = path.join(dataDir, 'test.sqlite');
process.env.PILI_XXYY_FEED = 'doorbell';
process.env.PILI_LIVE_SOURCE = 'dual';
process.env.PILI_DISABLE_TELEGRAM_MONITOR_AUTO_RECONCILE = '1';

async function main() {
  const fixture = telegramMonitorFixtureCases.find((item) => item.name === 'xxyy-bot-to-bot-buy');
  assert.ok(fixture);

  const { getDb } = await import('../lib/server/sqlite');
  const { saveSystemConfig } = await import('../lib/server/systemConfigRepo');
  const { createTrackedUser } = await import('../lib/server/trackedUsersRepo');
  const { ingestTelegramMonitorUpdate } = await import('../lib/server/telegramMonitorIngest');
  const { upsertLiveMonitorTrades } = await import('../lib/server/liveMonitorIngest');

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

  const result = await ingestTelegramMonitorUpdate({
    update_id: 900101,
    message: {
      message_id: 601,
      date: Math.floor(fixture.fallbackTimestampMs / 1000),
      chat: { id: -100123456 },
      text: fixture.text,
      entities: [{ type: 'text_link', url: fixture.linkCandidates[0] }],
      reply_markup: {
        inline_keyboard: [[{ text: 'Bscscan', url: fixture.linkCandidates[1] }]],
      },
    },
  });

  const db = getDb();
  const rawCount = db
    .prepare(`SELECT COUNT(*) AS count FROM telegram_monitor_events WHERE tx_hash_lower = ?`)
    .get(fixture.expected.txHash!.toLowerCase()) as { count: number };
  const doorbellCount = db
    .prepare(`SELECT COUNT(*) AS count FROM live_doorbell_queue WHERE user_id = ?`)
    .get(user.id) as { count: number };
  const provisional = db
    .prepare(`SELECT event_id, ingest_source FROM events WHERE user_id = ? AND LOWER(COALESCE(tx_hash, '')) = ?`)
    .all(user.id, fixture.expected.txHash!.toLowerCase()) as Array<{
      event_id: string;
      ingest_source: string;
    }>;

  assert.equal(rawCount.count, 1, 'doorbell mode must retain the raw XXYY event');
  assert.equal(doorbellCount.count, 1, 'doorbell mode must enqueue GMGN follow-up work');
  assert.equal(result.projected, true, 'doorbell mode must immediately project a provisional Feed row');
  assert.equal(provisional.length, 1, 'the provisional transaction should be visible exactly once');
  assert.match(provisional[0]!.event_id, /^xxyy-monitor:/);

  upsertLiveMonitorTrades({
    user,
    trades: [
      {
        chain: fixture.expected.chain!,
        wallet: fixture.expected.trackedWalletAddress!,
        txHash: fixture.expected.txHash!,
        tokenAddress: fixture.expected.tokenAddress!,
        tokenSymbol: fixture.expected.tokenSymbol ?? null,
        side: fixture.expected.action as 'buy' | 'sell',
        tokenAmount: fixture.expected.tokenAmount ?? null,
        costUsd: fixture.expected.tradeAmountUsdAtTx ?? null,
        priceUsd: 0.0036,
        marketCapUsd: fixture.expected.marketCapUsd ?? null,
        isOpenOrClose: true,
        eventTimeMs: fixture.fallbackTimestampMs,
      },
    ],
  });

  const canonical = db
    .prepare(`SELECT event_id, ingest_source FROM events WHERE user_id = ? AND LOWER(COALESCE(tx_hash, '')) = ?`)
    .all(user.id, fixture.expected.txHash!.toLowerCase()) as Array<{
      event_id: string;
      ingest_source: string;
    }>;
  assert.equal(canonical.length, 1, 'GMGN enrichment must not duplicate the provisional transaction');
  assert.match(canonical[0]!.event_id, /^live-monitor:/);
  assert.equal(canonical[0]!.ingest_source, 'live-monitor-alchemy-gmgn');

  console.log('telegram doorbell projection tests: ok');
}

main()
  .finally(() => rmSync(dataDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
