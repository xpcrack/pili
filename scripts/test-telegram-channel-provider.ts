import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-telegram-channel-provider-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');
  process.env.TELEGRAM_API_ID = '12345';
  process.env.TELEGRAM_API_HASH = 'test-hash';
  delete process.env.TELEGRAM_SESSION_STRING;

  try {
    const { getDb } = await import('../lib/server/sqlite');
    const {
      bootstrapTelegramChannelSourcesFromTrackedUsers,
      getTelegramChannelSourceById,
      listTelegramChannelSources,
      upsertTelegramChannelSource,
      updateTelegramChannelSourceState,
    } = await import('../lib/server/telegramChannelSourceRepo');
    const {
      getTelegramChannelPostByMessage,
      upsertTelegramChannelPost,
    } = await import('../lib/server/telegramChannelPostRepo');
    const { projectTelegramChannelPostToFeed } = await import('../lib/server/telegramChannelProjector');
    const { ingestTelegramChannelPost } = await import('../lib/server/telegramChannelIngest');
    const { readTelegramClientConfig } = await import('../lib/server/telegramClientConfig');
    const { buildTelegramChannelEntityRef, mapTelegramMessageToRemoteMessage } = await import(
      '../lib/server/telegramGramjsClient'
    );
    const { listEventTweetRefsByTweetId } = await import('../lib/server/twitterEnrichmentRepo');
    const { backfillTelegramChannelSourceHistory, syncAllTelegramChannelSources, syncTelegramChannelSource } = await import(
      '../lib/server/telegramChannelSync'
    );

    const db = getDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO tracked_users (
        id, name, handle, avatar, twitter, telegram, tags_json, total_asset_usd, historical_max_asset_usd, asset_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, '', ?, ?, '[]', 0, 0, null, ?, ?)`
    ).run('user-telegram-1', '旧亿', '旧亿', 'cryptojiuyi', '@jiuyicall', now, now);

    const bootstrappedCount = bootstrapTelegramChannelSourcesFromTrackedUsers();
    assert.equal(bootstrappedCount, 1, 'should bootstrap one telegram channel source from tracked user profile');

    const [source] = listTelegramChannelSources();
    assert.ok(source, 'should persist telegram channel source');
    assert.equal(source.userId, 'user-telegram-1');
    assert.equal(source.channelRef, '@jiuyicall');
    assert.equal(source.channelRefNormalized, 'jiuyicall');
    assert.equal(source.sourceKind, 'auto');
    assert.equal(source.channelType, 'social');
    assert.equal(source.syncStatus, 'pending');

    const readySource = updateTelegramChannelSourceState(source.id, {
      channelChatId: '-100123',
      channelUsername: 'jiuyicall',
      channelTitle: '旧亿 call',
      accessHash: 'hash-1',
      lastMessageId: 42,
      syncStatus: 'ready',
      lastSyncedAtMs: now,
      lastError: null,
    });
    assert.equal(readySource.lastMessageId, 42);
    assert.equal(readySource.syncStatus, 'ready');

    const post = upsertTelegramChannelPost({
      channelChatId: '-100123',
      channelUsername: 'jiuyicall',
      channelTitle: '旧亿 call',
      messageId: 99,
      groupedId: null,
      postedAtMs: now,
      editDateMs: null,
      text: 'Sol 的这个有更多的不确定和惊喜，https://x.com/cryptojiuyi/status/1234567890123456789',
      textEntities: [],
      media: [],
      linkUrls: ['https://x.com/cryptojiuyi/status/1234567890123456789'],
      forwardInfo: null,
      views: 971,
      forwards: 10,
      replies: 2,
      raw: {
        id: 99,
        message: 'fixture telegram post',
      },
    });
    assert.equal(post.messageId, 99);

    const storedPost = getTelegramChannelPostByMessage('-100123', 99);
    assert.ok(storedPost, 'should upsert telegram raw post');
    assert.equal(storedPost?.channelUsername, 'jiuyicall');

    const mappedRemote = mapTelegramMessageToRemoteMessage({
      id: 77,
      message: 'mapped text',
      date: new Date(now),
      editDate: new Date(now + 500),
      groupedId: BigInt(999),
      entities: [{ className: 'MessageEntityUrl', offset: 0, length: 11 }],
      replyMarkup: {
        rows: [{ buttons: [{ text: 'View', url: 'https://x.com/demo/status/1' }] }],
      },
      fwdFrom: {
        date: 123,
        fromName: 'forward-source',
        savedFromMsgId: 456,
      },
      photo: { _: 'photo' },
      views: 12,
      forwards: 3,
      replies: { replies: 4 },
    });
    assert.ok(mappedRemote, 'should map gramjs message into remote message shape');
    const mappedRaw = mappedRemote.raw as {
      id?: unknown;
      groupedId?: unknown;
      entities?: unknown[];
      replyMarkup?: { rows?: unknown[] };
      forwardInfo?: { fromName?: unknown };
      media?: string[];
    };
    assert.equal(mappedRaw.id, 77);
    assert.equal(mappedRaw.groupedId, '999');
    assert.equal(mappedRaw.entities?.length, 1);
    assert.equal(mappedRaw.replyMarkup?.rows?.length, 1);
    assert.equal(mappedRaw.forwardInfo?.fromName, 'forward-source');
    assert.equal(mappedRaw.media?.includes('photo'), true);
    const channelEntityRef = buildTelegramChannelEntityRef({
      channelRef: '@jiuyicall',
      channelChatId: '-100123',
      accessHash: '456',
      channelUsername: 'jiuyicall',
    });
    assert.notEqual(typeof channelEntityRef, 'string');
    assert.equal((channelEntityRef as { className?: string } | null)?.className, 'InputPeerChannel');

    const projected = projectTelegramChannelPostToFeed({
      source: readySource,
      post,
    });
    assert.equal(projected.user.name, '旧亿');
    assert.equal(projected.activity.source, 'telegram');
    assert.equal(projected.activity.type, 'post');
    assert.equal(projected.activity.metadata.telegramMessageId, 99);
    assert.equal(projected.activity.metadata.telegramChannelUsername, 'jiuyicall');
    assert.equal(projected.activity.metadata.telegramPostUrl, 'https://t.me/jiuyicall/99');

    const ingestResult = await ingestTelegramChannelPost({
      source: readySource,
      post,
      fetchTweetsByIds: async () => ({ provider: 'fixture', tweets: [] }),
    });
    assert.equal(ingestResult.eventId, 'user-telegram-1:telegram:-100123:99');

    const eventRow = db
      .prepare(
        `SELECT event_id, source, kind, ingest_source, content
         FROM events
         WHERE event_id = ?`
      )
      .get(ingestResult.eventId) as
      | {
          event_id: string;
          source: string;
          kind: string;
          ingest_source: string;
          content: string;
        }
      | undefined;
    assert.ok(eventRow, 'should persist projected telegram event');
    assert.equal(eventRow?.source, 'telegram');
    assert.equal(eventRow?.kind, 'post');
    assert.equal(eventRow?.ingest_source, 'telegram-channel');
    assert.match(eventRow?.content || '', /Sol 的这个/);

    const refs = listEventTweetRefsByTweetId('1234567890123456789');
    assert.equal(refs.length, 1, 'should create tweet ref for x links found in telegram post');
    assert.equal(refs[0]?.eventId, ingestResult.eventId);

    const authRequiredConfig = readTelegramClientConfig();
    assert.equal(authRequiredConfig.apiId, 12345);
    assert.equal(authRequiredConfig.apiHash, 'test-hash');
    assert.equal(authRequiredConfig.sessionString, null);
    assert.equal(authRequiredConfig.status, 'auth_required');

    process.env.TELEGRAM_SESSION_STRING = 'session-string';
    const readyConfig = readTelegramClientConfig();
    assert.equal(readyConfig.status, 'ready');

    const syncSource = getTelegramChannelSourceById(source.id);
    assert.ok(syncSource, 'source should still exist before sync');

    const syncResult = await syncTelegramChannelSource({
      sourceId: source.id,
      client: {
        async resolveChannel(input) {
          assert.equal(input.channelRef, '@jiuyicall');
          assert.equal(input.channelChatId, '-100123');
          assert.equal(input.accessHash, 'hash-1');
          return {
            channelChatId: '-100123',
            channelUsername: 'jiuyicall',
            channelTitle: '旧亿 call',
            accessHash: 'hash-1',
          };
        },
        async listChannelMessages() {
          return [
            {
              messageId: 101,
              groupedId: null,
              postedAtMs: now + 1_000,
              editDateMs: null,
              text: '新消息 https://x.com/cryptojiuyi/status/2234567890123456789',
              textEntities: [],
              media: [],
              linkUrls: ['https://x.com/cryptojiuyi/status/2234567890123456789'],
              forwardInfo: null,
              views: 358,
              forwards: 4,
              replies: 2,
              raw: { id: 101 },
            },
          ];
        },
      },
      fetchTweetsByIds: async () => ({ provider: 'fixture', tweets: [] }),
    });

    assert.equal(syncResult.storedCount, 1);
    assert.equal(syncResult.projectedCount, 1);
    assert.equal(syncResult.lastMessageId, 101);

    const syncedSource = getTelegramChannelSourceById(source.id);
    assert.equal(syncedSource?.lastMessageId, 101);
    assert.equal(getTelegramChannelPostByMessage('-100123', 101)?.messageId, 101);
    assert.equal(listEventTweetRefsByTweetId('2234567890123456789').length, 1);

    const historyResult = await backfillTelegramChannelSourceHistory({
      sourceId: source.id,
      beforeMessageId: 101,
      startMs: now - 7 * 24 * 60 * 60 * 1000,
      client: {
        async resolveChannel() {
          return {
            channelChatId: '-100123',
            channelUsername: 'jiuyicall',
            channelTitle: '旧亿 call',
            accessHash: 'hash-1',
          };
        },
        async listChannelMessages() {
          return [];
        },
        async listChannelHistoryPage() {
          return {
            messages: [
              {
                messageId: 100,
                groupedId: null,
                postedAtMs: now - 1_000,
                editDateMs: null,
                text: '历史消息',
                textEntities: [],
                media: [],
                linkUrls: [],
                forwardInfo: null,
                views: 88,
                forwards: 0,
                replies: 0,
                raw: { id: 100 },
              },
            ],
            oldestScannedMessageId: 100,
            oldestScannedMessageTimeMs: now - 1_000,
            reachedHistoryBoundary: false,
            nextBeforeMessageId: 100,
          };
        },
      },
      fetchTweetsByIds: async () => ({ provider: 'fixture', tweets: [] }),
    });
    assert.equal(historyResult.storedCount, 1);
    assert.equal(historyResult.lastMessageIdAfterRun, 101);
    assert.equal(getTelegramChannelSourceById(source.id)?.lastMessageId, 101);
    assert.equal(getTelegramChannelPostByMessage('-100123', 100)?.messageId, 100);

    db.prepare(
      `INSERT INTO tracked_users (
        id, name, handle, avatar, twitter, telegram, tags_json, total_asset_usd, historical_max_asset_usd, asset_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, '', ?, ?, '[]', 0, 0, null, ?, ?)`
    ).run('user-telegram-disabled', '停用源', '停用源', null, '@disabledcall', now, now);
    const disabledSource = upsertTelegramChannelSource({
      userId: 'user-telegram-disabled',
      channelRef: '@disabledcall',
      sourceKind: 'manual',
    });
    updateTelegramChannelSourceState(disabledSource.id, {
      enabled: false,
      syncStatus: 'unavailable',
      lastError: 'manually disabled',
    });
    bootstrapTelegramChannelSourcesFromTrackedUsers();
    assert.equal(getTelegramChannelSourceById(disabledSource.id)?.enabled, false, 'bootstrap should not re-enable disabled source');

    db.prepare(
      `INSERT INTO tracked_users (
        id, name, handle, avatar, twitter, telegram, tags_json, total_asset_usd, historical_max_asset_usd, asset_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, '', ?, ?, '[]', 0, 0, null, ?, ?)`
    ).run('user-telegram-2', '坏源', '坏源', null, '@brokencall', now, now);

    const brokenSource = upsertTelegramChannelSource({
      userId: 'user-telegram-2',
      channelRef: '@brokencall',
      sourceKind: 'manual',
    });

    const sweepResult = await syncAllTelegramChannelSources({
      client: {
        async resolveChannel(input) {
          if (input.channelRef === '@brokencall') {
            throw new Error('CHANNEL_INVALID');
          }
          assert.equal(input.channelRef, '@jiuyicall');
          return {
            channelChatId: '-100123',
            channelUsername: 'jiuyicall',
            channelTitle: '旧亿 call',
            accessHash: 'hash-1',
          };
        },
        async listChannelMessages(params) {
          assert.equal(params.source.channelRef, '@jiuyicall');
          assert.equal(params.minMessageId, 101);
          return [
            {
              messageId: 102,
              groupedId: null,
              postedAtMs: now + 2_000,
              editDateMs: null,
              text: '频道 sweep 新消息',
              textEntities: [],
              media: [],
              linkUrls: [],
              forwardInfo: null,
              views: 99,
              forwards: 1,
              replies: 0,
              raw: { id: 102 },
            },
          ];
        },
      },
      fetchTweetsByIds: async () => ({ provider: 'fixture', tweets: [] }),
    });

    assert.equal(sweepResult.sourceCount, 2);
    assert.equal(sweepResult.syncedCount, 1);
    assert.equal(sweepResult.errorCount, 1);
    assert.equal(sweepResult.storedCount, 1);
    assert.equal(sweepResult.projectedCount, 1);
    assert.equal(getTelegramChannelPostByMessage('-100123', 102)?.messageId, 102);
    assert.equal(getTelegramChannelSourceById(source.id)?.lastMessageId, 102);
    assert.equal(getTelegramChannelSourceById(brokenSource.id)?.syncStatus, 'unavailable');

    db.prepare(
      `INSERT INTO tracked_users (
        id, name, handle, avatar, twitter, telegram, tags_json, total_asset_usd, historical_max_asset_usd, asset_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, '', ?, ?, '[]', 0, 0, null, ?, ?)`
    ).run('user-telegram-3', '同源二号', '同源二号', null, '@jiuyicall', now, now);
    const duplicateSource = upsertTelegramChannelSource({
      userId: 'user-telegram-3',
      channelRef: '@jiuyicall',
      sourceKind: 'manual',
    });
    upsertTelegramChannelPost({
      channelChatId: '-100123',
      channelUsername: 'jiuyicall',
      channelTitle: '旧亿 call',
      messageId: 600,
      groupedId: null,
      postedAtMs: now + 3_000,
      editDateMs: null,
      text: 'shared channel raw post',
      textEntities: [],
      media: [],
      linkUrls: [],
      forwardInfo: null,
      views: 1,
      forwards: 0,
      replies: 0,
      raw: { id: 600, source: 'first-insert' },
    });
    db.prepare('DELETE FROM telegram_channel_sources WHERE id = ?').run(source.id);
    assert.ok(
      getTelegramChannelPostByMessage('-100123', 600),
      'shared raw post should survive deleting one source that tracks the same channel'
    );
    assert.ok(duplicateSource, 'duplicate source should still exist');

    db.prepare(
      `INSERT INTO tracked_users (
        id, name, handle, avatar, twitter, telegram, tags_json, total_asset_usd, historical_max_asset_usd, asset_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, '', ?, ?, '[]', 0, 0, null, ?, ?)`
    ).run('user-telegram-4', '改频道', '改频道', null, '@oldcall', now, now);
    bootstrapTelegramChannelSourcesFromTrackedUsers();
    const oldAutoSource = listTelegramChannelSources().find((item) => item.userId === 'user-telegram-4' && item.sourceKind === 'auto');
    assert.ok(oldAutoSource, 'should create auto source from tracked user telegram');
    updateTelegramChannelSourceState(oldAutoSource!.id, {
      channelChatId: '-100777',
      channelUsername: 'oldcall',
      channelTitle: 'Old Call',
      accessHash: '999',
      syncStatus: 'ready',
      lastMessageId: 321,
      lastSyncedAtMs: now,
    });
    const manualCompanionSource = upsertTelegramChannelSource({
      userId: 'user-telegram-4',
      channelRef: '@manualcall',
      sourceKind: 'manual',
    });
    db.prepare(`UPDATE tracked_users SET telegram = ? WHERE id = ?`).run('@newcall', 'user-telegram-4');
    bootstrapTelegramChannelSourcesFromTrackedUsers();
    const userFourSources = listTelegramChannelSources().filter((item) => item.userId === 'user-telegram-4');
    const staleAutoSource = userFourSources.find((item) => item.id === oldAutoSource!.id)!;
    const freshAutoSource = userFourSources.find((item) => item.sourceKind === 'auto' && item.channelRef === '@newcall');
    assert.equal(staleAutoSource.enabled, false, 'stale auto source should be disabled after tracked user telegram changes');
    assert.equal(staleAutoSource.channelChatId, null, 'stale auto source should clear persisted stable identifiers');
    assert.equal(staleAutoSource.accessHash, null, 'stale auto source should clear persisted access hash');
    assert.equal(staleAutoSource.lastMessageId, null, 'stale auto source should clear stale cursor');
    assert.ok(freshAutoSource, 'new tracked user telegram should create a fresh auto source');
    assert.equal(
      userFourSources.find((item) => item.id === manualCompanionSource.id)?.enabled,
      true,
      'manual source should not be touched by auto-source bootstrap reconciliation'
    );

    db.prepare(
      `INSERT INTO tracked_users (
        id, name, handle, avatar, twitter, telegram, tags_json, total_asset_usd, historical_max_asset_usd, asset_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, '', ?, ?, ?, 0, 0, null, ?, ?)`
    ).run('user-telegram-news', '方程式', '方程式', null, '@bwetradfi', JSON.stringify(['news']), now, now);
    bootstrapTelegramChannelSourcesFromTrackedUsers();
    const newsAutoSource = listTelegramChannelSources().find((item) => item.userId === 'user-telegram-news');
    assert.ok(newsAutoSource, 'news user should create telegram source');
    assert.equal(newsAutoSource?.channelType, 'news', 'news-tagged user auto sources should default to news');

    const newsManualSource = upsertTelegramChannelSource({
      userId: 'user-telegram-news',
      channelRef: '@bwe_reserved1',
      sourceKind: 'manual',
    });
    assert.equal(newsManualSource.channelType, 'news', 'news-tagged user manual sources should default to news');

    console.log('PASS telegram channel provider');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
