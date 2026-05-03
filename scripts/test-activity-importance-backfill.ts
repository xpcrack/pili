import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Activity, User } from '@/types';

import './server-only-shim.cjs';

function makeUser(): User {
  return {
    id: 'backfill-user',
    name: 'backfill-user',
    handle: 'backfill-user',
    avatar: '',
    addresses: [{ address: 'backfill-wallet', name: '#1', chain: 'solana', totalAssetUsd: null, assetUpdatedAt: null }],
    totalAssetUsd: 120_000,
    historicalMaxAssetUsd: 120_000,
    assetUpdatedAt: null,
    tags: [],
  };
}

function makeActivity(id: string, timestamp: number, source: Activity['source']): Activity {
  return {
    id,
    userId: 'backfill-user',
    source,
    type: source === 'blockchain' ? 'transfer' : 'post',
    title: id,
    content: id,
    timestamp,
    metadata:
      source === 'blockchain'
        ? { txHash: `${id}-tx`, chain: 'solana', trackedAddress: 'backfill-wallet', txAction: 'buy', token: 'AAA', value: '1' }
        : { tweetId: `${id}-tweet` },
  };
}

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-importance-backfill-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { getDb } = await import('@/lib/server/sqlite');
    const { backfillActivityImportance } = await import('@/lib/server/activityImportanceBackfill');

    const db = getDb();
    const user = makeUser();
    const older = makeActivity('older-social', 1_700_000_000_000, 'twitter');
    const newer = makeActivity('newer-chain', 1_700_000_100_000, 'blockchain');
    const feedSame2 = makeActivity('feed-same-2', 1_700_000_200_000, 'twitter');
    const feedSame10 = makeActivity('feed-same-10', 1_700_000_200_000, 'twitter');
    const txStateEarly = makeActivity('state-early', 1_700_000_300_000, 'blockchain');
    const txStateLate = makeActivity('state-late', 1_700_000_301_000, 'blockchain');
    const fallbackEarly = makeActivity('fallback-early', 1_700_000_400_000, 'twitter');
    const fallbackLate = makeActivity('fallback-late', 1_700_000_401_000, 'twitter');
    const now = Date.now();

    db.prepare(
      `INSERT INTO tracked_users (
        id, name, handle, avatar, twitter, twitter_user_id, twitter_avatar_url, telegram, tags_json, total_asset_usd, historical_max_asset_usd, asset_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, '[]', ?, ?, NULL, ?, ?)`
    ).run(
      user.id,
      user.name,
      user.handle,
      user.avatar,
      user.totalAssetUsd,
      user.historicalMaxAssetUsd,
      now,
      now
    );
    db.prepare(
      `INSERT INTO tracked_addresses (
        id, user_id, address, address_lower, name, chain, total_asset_usd, asset_updated_at, last_synced_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`
    ).run(
      `${user.id}:solana:0`,
      user.id,
      'backfill-wallet',
      'backfill-wallet',
      '#1',
      'solana',
      now,
      now
    );

    db.prepare(
      `INSERT INTO events (
        event_id, source, kind, timestamp, user_id, user_name, chain, address, content, url, action, token, tweet_id, tx_hash, ingest_source, dedup_key, metadata_json, payload_json, user_json, activity_json, indexed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'twitter:older-social-tweet',
      older.source,
      older.type,
      older.timestamp,
      user.id,
      user.name,
      null,
      null,
      older.content,
      null,
      null,
      null,
      older.metadata.tweetId,
      null,
      'seed',
      'twitter:older-social-tweet',
      JSON.stringify(older.metadata),
      JSON.stringify({}),
      JSON.stringify(user),
      JSON.stringify(older),
      Date.now(),
      Date.now(),
      Date.now()
    );

    db.prepare(
      `INSERT INTO activity_feed (
        user_id, activity_key, timestamp, tx_hash_lower, chain, tracked_address_lower, source, type, user_json, activity_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      user.id,
      'newer-chain',
      newer.timestamp,
      'newer-chain-tx',
      'solana',
      'backfill-wallet',
      newer.source,
      newer.type,
      JSON.stringify(user),
      JSON.stringify(newer),
      Date.now()
    );
    db.prepare(
      `INSERT INTO activity_feed (
        id, user_id, activity_key, timestamp, tx_hash_lower, chain, tracked_address_lower, source, type, user_json, activity_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      2,
      user.id,
      'feed-same-2-key',
      feedSame2.timestamp,
      null,
      null,
      null,
      feedSame2.source,
      feedSame2.type,
      JSON.stringify(user),
      JSON.stringify(feedSame2),
      Date.now()
    );
    db.prepare(
      `INSERT INTO activity_feed (
        id, user_id, activity_key, timestamp, tx_hash_lower, chain, tracked_address_lower, source, type, user_json, activity_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      10,
      user.id,
      'feed-same-10-key',
      feedSame10.timestamp,
      null,
      null,
      null,
      feedSame10.source,
      feedSame10.type,
      JSON.stringify(user),
      JSON.stringify(feedSame10),
      Date.now()
    );

    db.prepare(
      `INSERT INTO telegram_monitor_tx_states (
        user_id, chain, tracked_wallet_address, tracked_wallet_address_lower, tx_hash, tx_hash_lower, event_time_ms, canonical_activity_json, reconciliation_status, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).run(
      user.id,
      'solana',
      'backfill-wallet',
      'backfill-wallet',
      'monitor-tx',
      'monitor-tx',
      newer.timestamp,
      JSON.stringify(newer),
      Date.now(),
      Date.now(),
      Date.now()
    );
    db.prepare(
      `INSERT INTO telegram_monitor_tx_states (
        user_id, chain, tracked_wallet_address, tracked_wallet_address_lower, tx_hash, tx_hash_lower, event_time_ms, canonical_activity_json, reconciliation_status, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).run(
      user.id,
      'solana',
      'backfill-wallet',
      'backfill-wallet',
      'state-early-tx',
      'state-early-tx',
      txStateEarly.timestamp,
      JSON.stringify(txStateEarly),
      Date.now(),
      Date.now(),
      Date.now()
    );
    db.prepare(
      `INSERT INTO telegram_monitor_tx_states (
        user_id, chain, tracked_wallet_address, tracked_wallet_address_lower, tx_hash, tx_hash_lower, event_time_ms, canonical_activity_json, reconciliation_status, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).run(
      user.id,
      'solana',
      'backfill-wallet',
      'backfill-wallet',
      'state-late-tx',
      'state-late-tx',
      txStateLate.timestamp,
      JSON.stringify(txStateLate),
      Date.now(),
      Date.now(),
      Date.now()
    );

    db.prepare(
      `INSERT INTO telegram_monitor_events (
        provider, source_chat_id, source_message_id, chain, token_address, token_address_lower, tx_hash, tx_hash_lower, event_time_ms, raw_text, message_links_json, payload_json, projected_activity_json, created_at, updated_at
      ) VALUES ('xxyy', '-1001', 1, 'solana', 'token-1', 'token-1', 'fallback-tx', 'fallback-tx', ?, '', '[]', '{}', ?, ?, ?)`
    ).run(
      newer.timestamp,
      JSON.stringify(older),
      Date.now(),
      Date.now()
    );
    db.prepare(
      `INSERT INTO telegram_monitor_events (
        provider, source_chat_id, source_message_id, chain, token_address, token_address_lower, tx_hash, tx_hash_lower, event_time_ms, raw_text, message_links_json, payload_json, projected_activity_json, created_at, updated_at
      ) VALUES ('xxyy', '-1001', 2, 'solana', 'token-1', 'token-1', 'fallback-early-tx', 'fallback-early-tx', ?, '', '[]', '{}', ?, ?, ?)`
    ).run(
      fallbackEarly.timestamp,
      JSON.stringify(fallbackEarly),
      Date.now(),
      Date.now()
    );
    db.prepare(
      `INSERT INTO telegram_monitor_events (
        provider, source_chat_id, source_message_id, chain, token_address, token_address_lower, tx_hash, tx_hash_lower, event_time_ms, raw_text, message_links_json, payload_json, projected_activity_json, created_at, updated_at
      ) VALUES ('xxyy', '-1001', 3, 'solana', 'token-1', 'token-1', 'fallback-late-tx', 'fallback-late-tx', ?, '', '[]', '{}', ?, ?, ?)`
    ).run(
      fallbackLate.timestamp,
      JSON.stringify(fallbackLate),
      Date.now(),
      Date.now()
    );

    await backfillActivityImportance();

    const eventJson = db.prepare("SELECT activity_json FROM events WHERE event_id = 'twitter:older-social-tweet'").get() as { activity_json: string };
    const feedJson = db.prepare("SELECT activity_json FROM activity_feed WHERE activity_key = 'newer-chain'").get() as { activity_json: string };
    const txStateJson = db.prepare("SELECT canonical_activity_json FROM telegram_monitor_tx_states WHERE tx_hash = 'monitor-tx'").get() as { canonical_activity_json: string };
    const fallbackJson = db.prepare("SELECT projected_activity_json FROM telegram_monitor_events WHERE tx_hash = 'fallback-tx'").get() as { projected_activity_json: string };

    assert.ok(JSON.parse(eventJson.activity_json).metadata.importance.score !== undefined);
    assert.ok(JSON.parse(feedJson.activity_json).metadata.importance.score !== undefined);
    assert.ok(JSON.parse(txStateJson.canonical_activity_json).metadata.importance.score !== undefined);
    assert.ok(JSON.parse(fallbackJson.projected_activity_json).metadata.importance.score !== undefined);

    const sameTimestampFeedRows = db
      .prepare("SELECT id, activity_json FROM activity_feed WHERE id IN (2, 10) ORDER BY id ASC")
      .all() as Array<{ id: number; activity_json: string }>;
    assert.equal((JSON.parse(sameTimestampFeedRows[0]!.activity_json) as Activity).id, 'feed-same-2');
    assert.equal((JSON.parse(sameTimestampFeedRows[1]!.activity_json) as Activity).id, 'feed-same-10');

    const txStateScoredRows = db
      .prepare(
        "SELECT tx_hash, canonical_activity_json, updated_at FROM telegram_monitor_tx_states WHERE tx_hash IN ('state-early-tx', 'state-late-tx') ORDER BY tx_hash ASC"
      )
      .all() as Array<{ tx_hash: string; canonical_activity_json: string; updated_at: number }>;
    const txStateEarlyScored = JSON.parse(txStateScoredRows[0]!.canonical_activity_json) as Activity;
    const txStateLateScored = JSON.parse(txStateScoredRows[1]!.canonical_activity_json) as Activity;
    assert.ok(
      (txStateLateScored.metadata.importance?.sourceCount7d || 0) > (txStateEarlyScored.metadata.importance?.sourceCount7d || 0),
      'later tx-state rows should reflect higher chronological source frequency'
    );

    const fallbackScoredRows = db
      .prepare(
        "SELECT tx_hash, projected_activity_json, updated_at FROM telegram_monitor_events WHERE tx_hash IN ('fallback-early-tx', 'fallback-late-tx') ORDER BY tx_hash ASC"
      )
      .all() as Array<{ tx_hash: string; projected_activity_json: string; updated_at: number }>;
    const fallbackEarlyScored = JSON.parse(fallbackScoredRows[0]!.projected_activity_json) as Activity;
    const fallbackLateScored = JSON.parse(fallbackScoredRows[1]!.projected_activity_json) as Activity;
    assert.ok(
      (fallbackLateScored.metadata.importance?.sourceCount7d || 0) > (fallbackEarlyScored.metadata.importance?.sourceCount7d || 0),
      'later fallback rows should reflect higher chronological source frequency'
    );

    const firstUpdatedAt = {
      event: (db.prepare("SELECT updated_at FROM events WHERE event_id = 'twitter:older-social-tweet'").get() as { updated_at: number }).updated_at,
      txStateEarly: txStateScoredRows[0]!.updated_at,
      txStateLate: txStateScoredRows[1]!.updated_at,
      fallbackEarly: fallbackScoredRows[0]!.updated_at,
      fallbackLate: fallbackScoredRows[1]!.updated_at,
    };

    await backfillActivityImportance();

    const secondUpdatedAt = {
      event: (db.prepare("SELECT updated_at FROM events WHERE event_id = 'twitter:older-social-tweet'").get() as { updated_at: number }).updated_at,
      txStateEarly: (db.prepare("SELECT updated_at FROM telegram_monitor_tx_states WHERE tx_hash = 'state-early-tx'").get() as { updated_at: number }).updated_at,
      txStateLate: (db.prepare("SELECT updated_at FROM telegram_monitor_tx_states WHERE tx_hash = 'state-late-tx'").get() as { updated_at: number }).updated_at,
      fallbackEarly: (db.prepare("SELECT updated_at FROM telegram_monitor_events WHERE tx_hash = 'fallback-early-tx'").get() as { updated_at: number }).updated_at,
      fallbackLate: (db.prepare("SELECT updated_at FROM telegram_monitor_events WHERE tx_hash = 'fallback-late-tx'").get() as { updated_at: number }).updated_at,
    };
    assert.deepEqual(secondUpdatedAt, firstUpdatedAt, 'second backfill run should be a no-op for unchanged rows');

    console.log('activity importance backfill tests: ok');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
