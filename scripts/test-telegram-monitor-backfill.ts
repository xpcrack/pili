import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';
import { telegramMonitorFixtureCases } from './fixtures/parser-fixtures';

const dataDir = mkdtempSync(path.join(tmpdir(), 'pili-telegram-monitor-backfill-'));
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
  const { parseXxyyTelegramText } = await import('../lib/server/xxyyTelegramParser');
  const { upsertTelegramMonitorEvent } = await import('../lib/server/telegramMonitorRepo');
  const { backfillTelegramMonitorEventByTxHash } = await import('../lib/server/telegramMonitorBackfill');

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

  const parsed = parseXxyyTelegramText(fixture.text, fixture.fallbackTimestampMs, fixture.linkCandidates);
  const saved = upsertTelegramMonitorEvent({
    provider: 'xxyy',
    sourceChatId: '-100123456',
    sourceMessageId: 7001,
    updateId: 970001,
    chain: parsed.chain!,
    tokenAddress: parsed.tokenAddress!,
    tokenSymbol: parsed.tokenSymbol,
    txHash: parsed.txHash,
    marketCapUsd: parsed.marketCapUsd,
    priceUsd: parsed.priceUsd,
    quoteAmount: parsed.quoteAmount,
    quoteSymbol: parsed.quoteSymbol,
    action: parsed.action,
    actionLabel: parsed.actionLabel,
    actionVariant: parsed.actionVariant,
    walletLabel: parsed.walletLabel,
    walletGroupLabel: parsed.walletGroupLabel,
    walletAliasLabel: parsed.walletAliasLabel,
    trackedWalletAddress: parsed.trackedWalletAddress,
    eventTimeMs: fixture.fallbackTimestampMs,
    rawText: fixture.text,
    messageLinks: fixture.linkCandidates,
    payload: {},
  });
  assert.equal(saved.ok, true);

  const before = getDb()
    .prepare(`SELECT COUNT(*) AS count FROM events WHERE user_id = ? AND LOWER(COALESCE(tx_hash, '')) = ?`)
    .get(user.id, fixture.expected.txHash!.toLowerCase()) as { count: number };
  assert.equal(before.count, 0, 'fixture must start without a visible Feed row');

  const result = await backfillTelegramMonitorEventByTxHash(fixture.expected.txHash!);

  assert.equal(result.status, 'projected');
  assert.equal(result.userId, user.id);
  const after = getDb()
    .prepare(`SELECT COUNT(*) AS count FROM events WHERE user_id = ? AND LOWER(COALESCE(tx_hash, '')) = ?`)
    .get(user.id, fixture.expected.txHash!.toLowerCase()) as { count: number };
  const txState = getDb()
    .prepare(`SELECT COUNT(*) AS count FROM telegram_monitor_tx_states WHERE tx_hash_lower = ?`)
    .get(fixture.expected.txHash!.toLowerCase()) as { count: number };

  assert.equal(after.count, 1, 'backfill must create exactly one visible Feed row');
  assert.equal(txState.count, 1, 'backfill must create the provisional tx state');

  console.log('telegram monitor backfill tests: ok');
}

main()
  .finally(() => rmSync(dataDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
