import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-twitter-linked-ingest-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');
  process.env.TWITTER_FETCH_PROVIDER = 'fixture';

  const fixtureDir = path.join(process.cwd(), '.data', 'twitter-fixtures');
  const fixtureFile = path.join(fixtureDir, 'by-id.json');
  const fixtureExisted = existsSync(fixtureFile);
  const previousFixture = fixtureExisted ? readFileSync(fixtureFile, 'utf8') : null;

  try {
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      fixtureFile,
      JSON.stringify(
        [
          {
            tweetId: '1912345678901234567',
            authorHandle: 'monitorhandle',
            fullText: 'fixture linked tweet',
            createdAtMs: Date.now() - 1_000,
            lane: 'timeline',
          },
        ],
        null,
        2
      )
    );

    const { getDb } = await import('../lib/server/sqlite');
    const { ingestTelegramMonitorUpdate } = await import('../lib/server/telegramMonitorIngest');
    const { listTwitterTweetsByIds } = await import('../lib/server/twitterRepo');
    const { listEventTweetRefsByTweetId } = await import('../lib/server/twitterEnrichmentRepo');
    const { saveSystemConfig } = await import('../lib/server/systemConfigRepo');

    const db = getDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO tracked_users (
        id, name, handle, avatar, twitter, telegram, tags_json, total_asset_usd, historical_max_asset_usd, asset_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, '', ?, null, '[]', 0, 0, null, ?, ?)`
    ).run('user-1', 'finn', 'finn', 'monitorhandle', now, now);
    db.prepare(
      `INSERT INTO tracked_addresses (
        id, user_id, address, address_lower, name, chain, total_asset_usd, asset_updated_at, last_synced_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'bsc', null, null, null, ?, ?)`
    ).run(
      'addr-1',
      'user-1',
      '0x1111111111111111111111111111111111111111',
      '0x1111111111111111111111111111111111111111',
      '#2',
      now,
      now
    );

process.env.TELEGRAM_MONITOR_INGEST_TOKEN ??= 'fixture-telegram-ingest-token';
    saveSystemConfig({
      telegramTradeMonitorSourceChatId: '-100123456',
    });

    const result = await ingestTelegramMonitorUpdate({
      update_id: 1,
      message: {
        message_id: 100,
        date: Math.floor(now / 1000),
        chat: { id: '-100123456' },
        text: '[xp] [user_d#1]\n🟢 New buy 0.1336 BNB\nToken: 23423.53  [共建]\nPrice: $0.0036\nMCAP: $3.6M\nPlatform: Pancake V2\nCA: 0xb2acf3ae051c7f0b0b8de90cbb4ed99312574444\n#574444',
        reply_markup: {
          inline_keyboard: [[{ text: 'tweet', url: 'https://x.com/alpha/status/1912345678901234567' }]],
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(listTwitterTweetsByIds(['1912345678901234567']).length, 1);
    assert.equal(listEventTweetRefsByTweetId('1912345678901234567').length, 1);
    console.log('PASS telegram monitor tweet ref ingest');
  } finally {
    if (fixtureExisted && previousFixture !== null) {
      writeFileSync(fixtureFile, previousFixture);
    } else if (existsSync(fixtureFile)) {
      rmSync(fixtureFile, { force: true });
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
