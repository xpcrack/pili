import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';
import { telegramMonitorFixtureCases } from './fixtures/parser-fixtures';

const dataDir = mkdtempSync(path.join(tmpdir(), 'pili-telegram-projection-service-'));
process.env.PILIPILI_DATA_DIR = dataDir;
process.env.PILIPILI_DB_PATH = path.join(dataDir, 'test.sqlite');
process.env.PILI_XXYY_FEED = 'doorbell';
process.env.PILI_LIVE_SOURCE = 'dual';
process.env.PILI_DISABLE_TELEGRAM_MONITOR_AUTO_RECONCILE = '1';

async function main() {
  const fixture = telegramMonitorFixtureCases.find((item) => item.name === 'xxyy-bot-to-bot-buy');
  assert.ok(fixture);

  const { saveSystemConfig } = await import('../lib/server/systemConfigRepo');
  const { createTrackedUser } = await import('../lib/server/trackedUsersRepo');
  const { parseXxyyTelegramText } = await import('../lib/server/xxyyTelegramParser');
  const { upsertTelegramMonitorEvent } = await import('../lib/server/telegramMonitorRepo');
  const { projectAndPersistTelegramMonitorUpdate } = await import('../lib/server/telegramMonitorProjectionService');

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
  upsertTelegramMonitorEvent({
    provider: 'xxyy',
    sourceChatId: '-100123456',
    sourceMessageId: 611,
    updateId: 910101,
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
  const result = await projectAndPersistTelegramMonitorUpdate({
    parsed: {
      ...parsed,
      chain: parsed.chain!,
      tokenAddress: parsed.tokenAddress!,
      action: parsed.action!,
    },
    user,
    sourceChatId: '-100123456',
    sourceMessageId: 611,
    eventTimeMs: fixture.fallbackTimestampMs,
    rawText: fixture.text,
    messageLinks: fixture.linkCandidates,
    feedMode: 'doorbell',
    autoReconcile: false,
  });

  assert.equal(result.projected, true);
  assert.equal(result.txState?.txHash, fixture.expected.txHash);
  assert.equal(result.txState?.provisionalQuoteSymbol, fixture.expected.quoteSymbol);
  assert.equal(result.txState?.provisionalQuoteAmount, fixture.expected.quoteAmount);

  console.log('telegram projection service tests: ok');
}

main()
  .finally(() => rmSync(dataDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
