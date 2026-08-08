import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';
import { telegramMonitorFixtureCases } from './fixtures/parser-fixtures';

const dataDir = mkdtempSync(path.join(tmpdir(), 'pili-fast-event-upsert-'));
process.env.PILIPILI_DATA_DIR = dataDir;
process.env.PILIPILI_DB_PATH = path.join(dataDir, 'test.sqlite');

async function main() {
  const fixture = telegramMonitorFixtureCases.find((item) => item.name === 'xxyy-bot-to-bot-buy');
  assert.ok(fixture);

  const { getDb } = await import('../lib/server/sqlite');
  const { createTrackedUser } = await import('../lib/server/trackedUsersRepo');
  const { buildActivityFromSnapshotSync } = await import('../lib/server/telegramMonitorActivity');
  const { upsertTelegramMonitorProvisionalEventFast } = await import('../lib/server/eventsRepo');

  const user = createTrackedUser({
    name: 'finn',
    handle: 'finn',
    avatar: 'finn.png',
    addresses: [{
      address: fixture.expected.trackedWalletAddress!,
      name: '#1',
      chain: 'bsc',
      totalAssetUsd: null,
      assetUpdatedAt: null,
    }],
    totalAssetUsd: 0,
    mainstreamAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: ['fixture'],
  });

  const activity = buildActivityFromSnapshotSync({
    user,
    chain: fixture.expected.chain!,
    tokenAddress: fixture.expected.tokenAddress!,
    tokenSymbol: fixture.expected.tokenSymbol!,
    txHash: fixture.expected.txHash!,
    marketCapUsd: fixture.expected.marketCapUsd!,
    quoteAmount: fixture.expected.quoteAmount!,
    quoteSymbol: fixture.expected.quoteSymbol!,
    tokenAmount: fixture.expected.tokenAmount!,
    explicitPriceUsd: 0.0036,
    rawText: fixture.text,
    action: 'buy',
    actionLabel: '建仓',
    actionVariant: 'open',
    walletLabel: fixture.expected.walletAliasLabel!,
    walletGroupLabel: fixture.expected.walletGroupLabel!,
    walletAliasLabel: fixture.expected.walletAliasLabel!,
    eventTimeMs: fixture.fallbackTimestampMs,
    trackedAddress: fixture.expected.trackedWalletAddress!,
  });

  const result = upsertTelegramMonitorProvisionalEventFast({ user, activity });
  assert.equal(result.upserted, true);

  const row = getDb()
    .prepare(`SELECT event_id, ingest_source, activity_json FROM events WHERE event_id = ?`)
    .get(activity.id) as { event_id: string; ingest_source: string; activity_json: string } | undefined;
  assert.ok(row);
  assert.equal(row.ingest_source, 'telegram-monitor-ingest');
  assert.equal(JSON.parse(row.activity_json).metadata.tradeAmountUsdAtTx, fixture.expected.tradeAmountUsdAtTx);

  console.log('telegram fast event upsert test: ok');
}

main()
  .finally(() => rmSync(dataDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
