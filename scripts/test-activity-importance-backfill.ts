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
      `INSERT INTO telegram_monitor_events (
        provider, source_chat_id, source_message_id, chain, token_address, token_address_lower, tx_hash, tx_hash_lower, event_time_ms, raw_text, message_links_json, payload_json, projected_activity_json, created_at, updated_at
      ) VALUES ('xxyy', '-1001', 1, 'solana', 'token-1', 'token-1', 'fallback-tx', 'fallback-tx', ?, '', '[]', '{}', ?, ?, ?)`
    ).run(
      newer.timestamp,
      JSON.stringify(older),
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

    console.log('activity importance backfill tests: ok');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
