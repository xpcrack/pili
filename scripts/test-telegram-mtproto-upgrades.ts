import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-telegram-mtproto-upgrades-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');
  process.env.TELEGRAM_MTPROTO_REQUEST_DELAY_MS = '1234';
  process.env.TELEGRAM_MTPROTO_FLOOD_SLEEP_THRESHOLD_SEC = '77';
  process.env.TELEGRAM_MTPROTO_BRIDGE_BACKFILL_LIMIT = '33';
  process.env.TELEGRAM_CHANNEL_SYNC_INTERVAL_MS = '45000';
  process.env.TELEGRAM_CHANNEL_SYNC_LEASE_TTL_MS = '91000';
  delete process.env.TELEGRAM_SESSION_STRING;

  try {
    const { getDb } = await import('../lib/server/sqlite');
    const { readTelegramMtprotoPolicy, classifyTelegramMtprotoError } = await import(
      '../lib/server/telegramMtprotoPolicy'
    );
    const { saveSystemConfig } = await import('../lib/server/systemConfigRepo');
    const { backfillTelegramBridgeHistory } = await import('../lib/server/telegramBridgeMtprotoBackfill');
    const { getTelegramChannelSourceById, upsertTelegramChannelSource, updateTelegramChannelSourceState } = await import(
      '../lib/server/telegramChannelSourceRepo'
    );
    const { syncAllTelegramChannelSources, syncTelegramChannelSource } = await import('../lib/server/telegramChannelSync');
    const { listTwitterTweetsByIds } = await import('../lib/server/twitterRepo');
    const { runTelegramChannelWorkerCycle, runTelegramChannelWorkerCycleWithDeps } = await import(
      '../lib/server/telegramChannelWorkerRuntime'
    );
    const { touchWorkerHeartbeat, upsertWorkerStatus } = await import('../lib/server/workerStateRepo');

    const policy = readTelegramMtprotoPolicy();
    assert.equal(policy.requestDelayMs, 1234);
    assert.equal(policy.floodSleepThresholdSec, 77);
    assert.equal(policy.bridgeBackfillLimit, 33);
    assert.equal(policy.channelSyncIntervalMs, 45000);
    assert.equal(policy.channelSyncLeaseTtlMs, 91000);

    const classified = classifyTelegramMtprotoError(new Error('FLOOD_WAIT_12'));
    assert.equal(classified.kind, 'flood_wait');
    assert.equal(classified.waitMs, 12_000);

    const db = getDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO tracked_users (
        id, name, handle, avatar, twitter, telegram, tags_json, total_asset_usd, historical_max_asset_usd, asset_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, '', ?, ?, '[]', 0, 0, null, ?, ?)`
    ).run('user-bridge-1', 'finn', 'finn', 'monitorhandle', '@finncall', now, now);
    db.prepare(
      `INSERT INTO tracked_addresses (
        id, user_id, address, address_lower, name, chain, total_asset_usd, asset_updated_at, last_synced_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'bsc', null, null, null, ?, ?)`
    ).run(
      'addr-bridge-1',
      'user-bridge-1',
      '0x1111111111111111111111111111111111111111',
      '0x1111111111111111111111111111111111111111',
      '#2',
      now,
      now
    );

    saveSystemConfig({
      telegramTradeMonitorSourceChatId: '-100123456',
      telegramTwitterMonitorSourceChatId: '-5299035575',
    });
    process.env.TELEGRAM_MONITOR_INGEST_TOKEN = 'secret';

    const backfillResult = await backfillTelegramBridgeHistory({
      client: {
        async resolveChannel() {
          throw new Error('unused');
        },
        async listChannelMessages() {
          return [];
        },
        async listBridgeChatMessages(params) {
          if (params.chatId === '-100123456') {
            return [
              {
                message_id: 100,
                date: Math.floor(now / 1000),
                chat: { id: '-100123456' },
                text:
                  '[xp] [user_d#1]\n🟢 New buy 0.1336 BNB\nToken: 23423.53  [共建]\nPrice: $0.0036\nMCAP: $3.6M\nPlatform: Pancake V2\nCA: 0xb2acf3ae051c7f0b0b8de90cbb4ed99312574444\n#574444',
              },
            ];
          }
          return [
            {
              message_id: 101,
              date: Math.floor(now / 1000),
              chat: { id: '-5299035575' },
              text: ['✨监控到新推文', '你关注的用户: monitorhandle(备注:monitorhandle)', '用户所属分组: 实盘', '推文内容: GM'].join('\n'),
              reply_markup: {
                inline_keyboard: [[{ text: 'View Details', url: 'https://x.com/monitorhandle/status/1912345678901234567' }]],
              },
            },
          ];
        },
      },
    });

    assert.equal(backfillResult.chatCount, 2);
    assert.equal(backfillResult.fetchedCount, 2);
    assert.equal(backfillResult.ingestedCount, 2);
    assert.equal(backfillResult.chatResults.length, 2);
    assert.equal(backfillResult.chatResults[0]?.reachedHistoryBoundary, false);
    assert.equal(listTwitterTweetsByIds(['1912345678901234567']).length, 1);
    const monitorCountRow = db
      .prepare('SELECT count(*) AS c FROM telegram_monitor_events WHERE source_chat_id = ?')
      .get('-100123456') as { c: number };
    assert.equal(
      monitorCountRow.c,
      1
    );

    const source = upsertTelegramChannelSource({
      userId: 'user-bridge-1',
      channelRef: '@finncall',
    });
    assert.equal(source.sourceKind, 'manual');
    updateTelegramChannelSourceState(source.id, {
      syncStatus: 'ready',
    });

    await assert.rejects(
      () =>
        syncTelegramChannelSource({
          sourceId: source.id,
          client: {
            async resolveChannel() {
              throw new Error('FLOOD_WAIT_12');
            },
            async listChannelMessages() {
              return [];
            },
          },
          fetchTweetsByIds: async () => ({ provider: 'fixture', tweets: [] }),
        }),
      /FLOOD_WAIT_12/
    );

    const updated = db
      .prepare('SELECT sync_status, last_error FROM telegram_channel_sources WHERE id = ?')
      .get(source.id) as { sync_status: string; last_error: string | null };
    assert.equal(updated.sync_status, 'error');
    assert.match(updated.last_error || '', /FLOOD_WAIT_12/);

    const sourceTwo = upsertTelegramChannelSource({
      userId: 'user-bridge-1',
      channelRef: '@finncall-2',
    });
    assert.equal(sourceTwo.sourceKind, 'manual');
    updateTelegramChannelSourceState(sourceTwo.id, {
      syncStatus: 'ready',
    });

    const sleepCalls: number[] = [];
    const sweepResult = await syncAllTelegramChannelSources({
      client: {
        async resolveChannel(input) {
          if (input.channelRef === '@finncall-2') {
            throw new Error('FLOOD_WAIT_12');
          }
          return {
            channelChatId: '-100500',
            channelUsername: 'finncall',
            channelTitle: 'finn call',
            accessHash: 'hash-2',
          };
        },
        async listChannelMessages() {
          return [];
        },
      },
      fetchTweetsByIds: async () => ({ provider: 'fixture', tweets: [] }),
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    assert.equal(sweepResult.backoffMs, 12_000);
    assert.equal(sleepCalls.includes(1234), true, 'multi-source sweep should pace requests between sources');
    assert.equal(
      getTelegramChannelSourceById(source.id)?.sourceKind,
      'manual',
      'bootstrap should not convert manual sources into auto sources'
    );

    delete process.env.TELEGRAM_API_ID;
    delete process.env.TELEGRAM_API_HASH;
    await runTelegramChannelWorkerCycle();
    const workerRow = db
      .prepare(`SELECT status, last_error FROM worker_status WHERE worker_key = 'telegram-channel-sync'`)
      .get() as { status: string; last_error: string | null } | undefined;
    assert.equal(workerRow?.status, 'missing-credentials');
    assert.match(workerRow?.last_error || '', /TELEGRAM_API_ID/);

    const startupFailure = await runTelegramChannelWorkerCycleWithDeps({
      readConfig: () => ({
        apiId: 12345,
        apiHash: 'hash',
        sessionString: 'session',
        status: 'ready',
      }),
      createClient: async () => {
        throw new Error('Telegram session is not authorized.');
      },
    });
    assert.equal(startupFailure.status, 'auth-required');
    assert.match(startupFailure.lastError || '', /not authorized/i);

    upsertWorkerStatus({
      workerKey: 'telegram-channel-sync',
      workerType: 'telegram-channel-sync',
      status: 'partial',
      lastError: '1 source error(s)',
    });
    touchWorkerHeartbeat('telegram-channel-sync');
    const heartbeatRow = db
      .prepare(`SELECT status, last_error FROM worker_status WHERE worker_key = 'telegram-channel-sync'`)
      .get() as { status: string; last_error: string | null } | undefined;
    assert.equal(heartbeatRow?.status, 'partial');
    assert.equal(heartbeatRow?.last_error, '1 source error(s)');

    console.log('PASS telegram mtproto upgrades');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
