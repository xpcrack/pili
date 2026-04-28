import 'server-only';

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

const DEFAULT_DATA_DIR = path.join(process.cwd(), '.data');

function getDataDir() {
  const customDataDir = (process.env.PILIPILI_DATA_DIR || '').trim();
  if (customDataDir) {
    return path.resolve(customDataDir);
  }
  return DEFAULT_DATA_DIR;
}

function getDbPath() {
  const customDbPath = (process.env.PILIPILI_DB_PATH || '').trim();
  if (customDbPath) {
    return path.resolve(customDbPath);
  }
  return path.join(getDataDir(), 'web3-feed.sqlite');
}

function getLegacyJudgmentFilePath() {
  const customDataDir = (process.env.PILIPILI_DATA_DIR || '').trim();
  if (customDataDir) {
    return path.join(path.resolve(customDataDir), 'tx-judgments.json');
  }
  const customDbPath = (process.env.PILIPILI_DB_PATH || '').trim();
  if (customDbPath) {
    return path.join(path.dirname(path.resolve(customDbPath)), 'tx-judgments.json');
  }
  return path.join(getDataDir(), 'tx-judgments.json');
}

let dbInstance: Database.Database | null = null;
let initialized = false;

function buildEventsFtsSafeJsonScalarExpr(activityJsonExpr: string, jsonPath: string) {
  return `CASE WHEN json_valid(${activityJsonExpr}) THEN coalesce(json_extract(${activityJsonExpr}, '${jsonPath}'), '') ELSE '' END`;
}

function buildEventsFtsSafeJsonTextArrayExpr(activityJsonExpr: string, jsonPath: string) {
  return `CASE WHEN json_valid(${activityJsonExpr}) THEN coalesce((SELECT group_concat(value, ' ') FROM json_each(${activityJsonExpr}, '${jsonPath}') WHERE typeof(value) = 'text'), '') ELSE '' END`;
}

function buildEventsFtsSafeJsonObjectArrayFieldExpr(
  activityJsonExpr: string,
  jsonPath: string,
  fieldPath: string
) {
  return `CASE WHEN json_valid(${activityJsonExpr}) THEN coalesce((SELECT group_concat(json_extract(json_each.value, '${fieldPath}'), ' ') FROM json_each(${activityJsonExpr}, '${jsonPath}') WHERE json_extract(json_each.value, '${fieldPath}') IS NOT NULL), '') ELSE '' END`;
}

function buildEventsFtsTokenExpr(record: string) {
  const activityJsonExpr = `${record}.activity_json`;
  return `trim(coalesce(${record}.token, '') || ' ' || ${buildEventsFtsSafeJsonScalarExpr(activityJsonExpr, '$.metadata.token')} || ' ' || ${buildEventsFtsSafeJsonTextArrayExpr(activityJsonExpr, '$.metadata.mentionedTickers')} || ' ' || ${buildEventsFtsSafeJsonObjectArrayFieldExpr(activityJsonExpr, '$.metadata.tokenSentiments', '$.tokenSymbol')})`;
}

function buildEventsFtsAddressExpr(record: string) {
  const activityJsonExpr = `${record}.activity_json`;
  return `trim(coalesce(${record}.address, '') || ' ' || ${buildEventsFtsSafeJsonScalarExpr(activityJsonExpr, '$.metadata.tokenAddress')} || ' ' || ${buildEventsFtsSafeJsonScalarExpr(activityJsonExpr, '$.metadata.trackedAddress')} || ' ' || ${buildEventsFtsSafeJsonScalarExpr(activityJsonExpr, '$.metadata.fromAddress')} || ' ' || ${buildEventsFtsSafeJsonScalarExpr(activityJsonExpr, '$.metadata.toAddress')} || ' ' || ${buildEventsFtsSafeJsonTextArrayExpr(activityJsonExpr, '$.metadata.mentionedTokenAddresses')} || ' ' || ${buildEventsFtsSafeJsonObjectArrayFieldExpr(activityJsonExpr, '$.metadata.tokenSentiments', '$.tokenAddress')})`;
}

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;

CREATE TABLE IF NOT EXISTS tracked_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  handle TEXT NOT NULL,
  avatar TEXT NOT NULL,
  twitter TEXT,
  telegram TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  total_asset_usd REAL NOT NULL DEFAULT 0,
  historical_max_asset_usd REAL NOT NULL DEFAULT 0,
  asset_updated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tracked_addresses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  address TEXT NOT NULL,
  address_lower TEXT NOT NULL,
  name TEXT NOT NULL,
  chain TEXT NOT NULL,
  total_asset_usd REAL,
  asset_updated_at INTEGER,
  last_synced_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES tracked_users(id) ON DELETE CASCADE,
  UNIQUE(user_id, chain, address_lower)
);

CREATE INDEX IF NOT EXISTS idx_tracked_addresses_chain_address
ON tracked_addresses(chain, address_lower);

CREATE TABLE IF NOT EXISTS raw_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL,
  tracked_address TEXT NOT NULL,
  tracked_address_lower TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  tx_hash_lower TEXT NOT NULL,
  tx_time INTEGER,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(chain, tracked_address_lower, tx_hash_lower)
);

CREATE INDEX IF NOT EXISTS idx_raw_transactions_address_time
ON raw_transactions(chain, tracked_address_lower, tx_time DESC);

CREATE TABLE IF NOT EXISTS telegram_monitor_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  source_chat_id TEXT,
  source_message_id INTEGER,
  update_id INTEGER,
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  token_address_lower TEXT NOT NULL,
  token_symbol TEXT,
  tx_hash TEXT,
  tx_hash_lower TEXT,
  market_cap_usd REAL,
  price_usd REAL,
  quote_amount REAL,
  quote_symbol TEXT,
  action TEXT,
  wallet_label TEXT,
  wallet_group_label TEXT,
  wallet_alias_label TEXT,
  tracked_wallet_address TEXT,
  tracked_wallet_address_lower TEXT,
  event_time_ms INTEGER,
  raw_text TEXT NOT NULL DEFAULT '',
  message_links_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(provider, source_chat_id, source_message_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_monitor_events_tx
ON telegram_monitor_events(chain, token_address_lower, tx_hash_lower, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_monitor_events_time
ON telegram_monitor_events(chain, token_address_lower, event_time_ms DESC);

CREATE TABLE IF NOT EXISTS telegram_monitor_tx_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  tracked_wallet_address TEXT NOT NULL,
  tracked_wallet_address_lower TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  tx_hash_lower TEXT NOT NULL,
  token_address TEXT,
  token_address_lower TEXT,
  token_symbol TEXT,
  provisional_action TEXT,
  provisional_action_label TEXT,
  provisional_action_variant TEXT,
  provisional_quote_amount REAL,
  provisional_quote_symbol TEXT,
  provisional_token_amount REAL,
  provisional_token_symbol TEXT,
  provisional_price_usd REAL,
  provisional_market_cap_usd REAL,
  provisional_raw_text TEXT NOT NULL DEFAULT '',
  provisional_message_links_json TEXT NOT NULL DEFAULT '[]',
  provisional_wallet_label TEXT,
  provisional_wallet_group_label TEXT,
  provisional_wallet_alias_label TEXT,
  event_time_ms INTEGER,
  canonical_activity_json TEXT,
  reconciliation_status TEXT NOT NULL DEFAULT 'pending',
  reconciled_source TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  reconciled_at INTEGER,
  next_retry_at INTEGER,
  repair_claimed_at INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(chain, tracked_wallet_address_lower, tx_hash_lower),
  FOREIGN KEY (user_id) REFERENCES tracked_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telegram_monitor_tx_states_recent
ON telegram_monitor_tx_states(event_time_ms DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_monitor_tx_states_repair
ON telegram_monitor_tx_states(reconciliation_status, next_retry_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS telegram_channel_sources (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel_ref TEXT NOT NULL,
  channel_ref_normalized TEXT NOT NULL,
  channel_title TEXT,
  channel_username TEXT,
  channel_chat_id TEXT,
  access_hash TEXT,
  source_kind TEXT NOT NULL DEFAULT 'auto',
  enabled INTEGER NOT NULL DEFAULT 1,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  last_message_id INTEGER,
  last_synced_at_ms INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, channel_ref_normalized),
  FOREIGN KEY (user_id) REFERENCES tracked_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telegram_channel_sources_enabled
ON telegram_channel_sources(enabled, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_channel_sources_chat_id
ON telegram_channel_sources(channel_chat_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS telegram_channel_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_chat_id TEXT NOT NULL,
  channel_username TEXT,
  channel_title TEXT,
  message_id INTEGER NOT NULL,
  grouped_id TEXT,
  posted_at_ms INTEGER NOT NULL,
  edit_date_ms INTEGER,
  text TEXT NOT NULL DEFAULT '',
  text_entities_json TEXT NOT NULL DEFAULT '[]',
  media_json TEXT NOT NULL DEFAULT '[]',
  link_urls_json TEXT NOT NULL DEFAULT '[]',
  forward_info_json TEXT,
  views INTEGER,
  forwards INTEGER,
  replies INTEGER,
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(channel_chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_channel_posts_recent
ON telegram_channel_posts(channel_chat_id, message_id DESC, posted_at_ms DESC);

CREATE TABLE IF NOT EXISTS telegram_agent_pending_grants (
  id TEXT PRIMARY KEY,
  approval_chat_id TEXT NOT NULL,
  requested_chat_id TEXT NOT NULL,
  requested_by_telegram_user_id TEXT NOT NULL,
  requested_by_telegram_username TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_agent_pending_grants_waiting_user
ON telegram_agent_pending_grants(requested_by_telegram_user_id)
WHERE status = 'waiting_agent_name';

CREATE TABLE IF NOT EXISTS telegram_agent_grants (
  id TEXT PRIMARY KEY,
  approval_chat_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '[]',
  token_hash TEXT NOT NULL,
  token_preview TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by_telegram_user_id TEXT NOT NULL,
  created_by_telegram_username TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by_telegram_user_id TEXT,
  last_used_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(agent_name, chat_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_agent_grants_token_hash
ON telegram_agent_grants(token_hash);

CREATE TABLE IF NOT EXISTS telegram_agent_grant_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  command TEXT NOT NULL,
  scope TEXT NOT NULL,
  query TEXT,
  limit_value INTEGER,
  result_count INTEGER,
  success INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  used_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_judgments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL,
  tracked_address TEXT NOT NULL,
  tracked_address_lower TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  tx_hash_lower TEXT NOT NULL,
  tx_time INTEGER,
  tx_action TEXT NOT NULL,
  token TEXT,
  value TEXT,
  token_address TEXT,
  quote_token TEXT,
  quote_amount TEXT,
  from_address TEXT,
  to_address TEXT,
  uncertain_from INTEGER NOT NULL DEFAULT 0,
  decision TEXT NOT NULL DEFAULT 'visible',
  reason_code TEXT,
  reason_text TEXT,
  computed_usd_value REAL,
  updated_at INTEGER NOT NULL,
  UNIQUE(chain, tracked_address_lower, tx_hash_lower)
);

CREATE INDEX IF NOT EXISTS idx_activity_judgments_address
ON activity_judgments(chain, tracked_address_lower, updated_at DESC);

CREATE TABLE IF NOT EXISTS activity_feed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  activity_key TEXT NOT NULL UNIQUE,
  timestamp INTEGER NOT NULL,
  tx_hash_lower TEXT,
  chain TEXT,
  tracked_address_lower TEXT,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  user_json TEXT NOT NULL,
  activity_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_feed_timestamp
ON activity_feed(timestamp DESC, id DESC);

CREATE TABLE IF NOT EXISTS twitter_tweets (
  tweet_id TEXT PRIMARY KEY,
  author_handle TEXT NOT NULL,
  author_name TEXT,
  full_text TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  lane TEXT NOT NULL,
  conversation_id TEXT,
  in_reply_to_tweet_id TEXT,
  quoted_tweet_id TEXT,
  metrics_reply_count INTEGER NOT NULL DEFAULT 0,
  metrics_retweet_count INTEGER NOT NULL DEFAULT 0,
  metrics_like_count INTEGER NOT NULL DEFAULT 0,
  metrics_view_count INTEGER NOT NULL DEFAULT 0,
  source_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_twitter_tweets_author_created
ON twitter_tweets(author_handle, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_twitter_tweets_created
ON twitter_tweets(created_at_ms DESC);

CREATE TABLE IF NOT EXISTS twitter_tweet_enrichments (
  tweet_id TEXT PRIMARY KEY,
  translation_zh TEXT,
  translation_status TEXT NOT NULL DEFAULT 'pending',
  extraction_status TEXT NOT NULL DEFAULT 'pending',
  extractor_version TEXT,
  translator_version TEXT,
  last_processed_at_ms INTEGER,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS twitter_tweet_token_mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tweet_id TEXT NOT NULL,
  token_address TEXT,
  token_address_lower TEXT,
  token_symbol TEXT,
  token_symbol_lower TEXT,
  chain TEXT,
  match_source TEXT NOT NULL,
  sentiment TEXT NOT NULL,
  confidence REAL,
  rank_in_tweet INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_twitter_tweet_token_mentions_identity
ON twitter_tweet_token_mentions(tweet_id, chain, token_address_lower, token_symbol_lower);

CREATE INDEX IF NOT EXISTS idx_twitter_tweet_token_mentions_tweet_id
ON twitter_tweet_token_mentions(tweet_id);

CREATE TABLE IF NOT EXISTS event_tweet_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  tweet_id TEXT NOT NULL,
  ref_source TEXT NOT NULL,
  discovered_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(event_id, tweet_id)
);

CREATE INDEX IF NOT EXISTS idx_event_tweet_refs_tweet_id
ON event_tweet_refs(tweet_id, discovered_at_ms DESC);

CREATE TABLE IF NOT EXISTS twitter_identity_cache (
  handle TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  user_id TEXT,
  username TEXT,
  resolved_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  last_error TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_twitter_identity_cache_expires
ON twitter_identity_cache(expires_at_ms);

CREATE TABLE IF NOT EXISTS twitter_provider_budget (
  provider TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  success_units_used INTEGER NOT NULL DEFAULT 0,
  daily_limit INTEGER NOT NULL,
  cooldown_until_ms INTEGER,
  last_success_at_ms INTEGER,
  last_failure_at_ms INTEGER,
  last_error TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(provider, credential_id, date_key)
);

CREATE TABLE IF NOT EXISTS twitter_tweet_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_tweet_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  target_tweet_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(source_tweet_id, relation_type, target_tweet_id)
);

CREATE INDEX IF NOT EXISTS idx_twitter_tweet_relations_target
ON twitter_tweet_relations(target_tweet_id, relation_type);

CREATE TABLE IF NOT EXISTS twitter_sync_cursor (
  user_id TEXT NOT NULL,
  lane TEXT NOT NULL,
  covered_since_ms INTEGER,
  watermark_created_at_ms INTEGER,
  watermark_tweet_id TEXT,
  last_success_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(user_id, lane),
  FOREIGN KEY (user_id) REFERENCES tracked_users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ingestion_leases (
  lock_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  heartbeat_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS twitter_sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  user_id TEXT,
  lane TEXT,
  status TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  duration_ms INTEGER,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  stored_count INTEGER NOT NULL DEFAULT 0,
  projected_count INTEGER NOT NULL DEFAULT 0,
  backfill_enqueued_count INTEGER NOT NULL DEFAULT 0,
  backfill_fetched_count INTEGER NOT NULL DEFAULT 0,
  budget_exhausted INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  summary_json TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_twitter_sync_runs_started
ON twitter_sync_runs(started_at_ms DESC);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL,
  reason TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER,
  total_addresses INTEGER NOT NULL DEFAULT 0,
  successful_addresses INTEGER NOT NULL DEFAULT 0,
  failed_addresses INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  summary_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at
ON sync_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_kind TEXT NOT NULL,
  run_id INTEGER,
  level TEXT NOT NULL,
  phase TEXT,
  message TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_run
ON sync_logs(run_kind, run_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_sync_logs_created
ON sync_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_ingest_cursors (
  worker_key TEXT PRIMARY KEY,
  last_update_id INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_status (
  worker_key TEXT PRIMARY KEY,
  worker_type TEXT NOT NULL,
  status TEXT NOT NULL,
  last_heartbeat_at_ms INTEGER NOT NULL,
  last_update_id INTEGER,
  last_error TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_leases (
  worker_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  lease_expires_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_processed_updates (
  worker_key TEXT NOT NULL,
  update_id INTEGER NOT NULL,
  processed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (worker_key, update_id)
);

CREATE TABLE IF NOT EXISTS events (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  user_id TEXT,
  user_name TEXT,
  chain TEXT,
  address TEXT,
  content TEXT NOT NULL,
  url TEXT,
  action TEXT,
  token TEXT,
  tweet_id TEXT,
  tx_hash TEXT,
  ingest_source TEXT,
  dedup_key TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  payload_json TEXT NOT NULL DEFAULT '{}',
  user_json TEXT NOT NULL,
  activity_json TEXT NOT NULL,
  indexed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_timestamp
ON events(timestamp DESC, event_id DESC);

CREATE INDEX IF NOT EXISTS idx_events_source_timestamp
ON events(source, timestamp DESC, event_id DESC);

CREATE INDEX IF NOT EXISTS idx_events_user_timestamp
ON events(user_id, timestamp DESC, event_id DESC);

CREATE INDEX IF NOT EXISTS idx_events_chain_address_timestamp
ON events(chain, address, timestamp DESC, event_id DESC);

CREATE INDEX IF NOT EXISTS idx_events_tweet_id
ON events(tweet_id);

CREATE INDEX IF NOT EXISTS idx_events_tx_hash
ON events(tx_hash);

CREATE TABLE IF NOT EXISTS feed_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conflict_key TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  event_key TEXT NOT NULL,
  winner TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feed_conflicts_created
ON feed_conflicts(created_at DESC);

CREATE TABLE IF NOT EXISTS feed_conflict_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conflict_id INTEGER NOT NULL,
  conflict_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  last_error TEXT,
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (conflict_id) REFERENCES feed_conflicts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_feed_conflict_notifications_pending
ON feed_conflict_notifications(status, next_retry_at, id);

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  event_id UNINDEXED,
  content,
  token,
  address,
  reference,
  user_name,
  tokenize='unicode61 remove_diacritics 2',
  content=''
);

CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, event_id, content, token, address, reference, user_name)
  VALUES (new.rowid, new.event_id, new.content, ${buildEventsFtsTokenExpr('new')}, ${buildEventsFtsAddressExpr('new')}, coalesce(new.tweet_id, coalesce(new.tx_hash, coalesce(new.url, ''))), coalesce(new.user_name, ''));
END;

CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, event_id, content, token, address, reference, user_name)
  VALUES ('delete', old.rowid, old.event_id, old.content, ${buildEventsFtsTokenExpr('old')}, ${buildEventsFtsAddressExpr('old')}, coalesce(old.tweet_id, coalesce(old.tx_hash, coalesce(old.url, ''))), coalesce(old.user_name, ''));
END;

CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, event_id, content, token, address, reference, user_name)
  VALUES ('delete', old.rowid, old.event_id, old.content, ${buildEventsFtsTokenExpr('old')}, ${buildEventsFtsAddressExpr('old')}, coalesce(old.tweet_id, coalesce(old.tx_hash, coalesce(old.url, ''))), coalesce(old.user_name, ''));
  INSERT INTO events_fts(rowid, event_id, content, token, address, reference, user_name)
  VALUES (new.rowid, new.event_id, new.content, ${buildEventsFtsTokenExpr('new')}, ${buildEventsFtsAddressExpr('new')}, coalesce(new.tweet_id, coalesce(new.tx_hash, coalesce(new.url, ''))), coalesce(new.user_name, ''));
END;
`;

function normalize(value: string | undefined) {
  return (value || '').trim().toLowerCase();
}

function parseJSON<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function getAppStateFlag(db: Database.Database, key: string) {
  const row = db
    .prepare('SELECT value_json FROM app_state WHERE key = ? LIMIT 1')
    .get(key) as { value_json: string } | undefined;
  if (!row) {
    return false;
  }
  const parsed = parseJSON<{ done?: boolean }>(row.value_json, {});
  return parsed.done === true;
}

function setAppStateFlag(db: Database.Database, key: string) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO app_state (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify({ done: true, at: now }), now);
}

function recreateEventsFtsTriggers(db: Database.Database) {
  db.exec(`
DROP TRIGGER IF EXISTS events_ai;
DROP TRIGGER IF EXISTS events_ad;
DROP TRIGGER IF EXISTS events_au;

CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, event_id, content, token, address, reference, user_name)
  VALUES (new.rowid, new.event_id, new.content, ${buildEventsFtsTokenExpr('new')}, ${buildEventsFtsAddressExpr('new')}, coalesce(new.tweet_id, coalesce(new.tx_hash, coalesce(new.url, ''))), coalesce(new.user_name, ''));
END;

CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, event_id, content, token, address, reference, user_name)
  VALUES ('delete', old.rowid, old.event_id, old.content, ${buildEventsFtsTokenExpr('old')}, ${buildEventsFtsAddressExpr('old')}, coalesce(old.tweet_id, coalesce(old.tx_hash, coalesce(old.url, ''))), coalesce(old.user_name, ''));
END;

CREATE TRIGGER events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, event_id, content, token, address, reference, user_name)
  VALUES ('delete', old.rowid, old.event_id, old.content, ${buildEventsFtsTokenExpr('old')}, ${buildEventsFtsAddressExpr('old')}, coalesce(old.tweet_id, coalesce(old.tx_hash, coalesce(old.url, ''))), coalesce(old.user_name, ''));
  INSERT INTO events_fts(rowid, event_id, content, token, address, reference, user_name)
  VALUES (new.rowid, new.event_id, new.content, ${buildEventsFtsTokenExpr('new')}, ${buildEventsFtsAddressExpr('new')}, coalesce(new.tweet_id, coalesce(new.tx_hash, coalesce(new.url, ''))), coalesce(new.user_name, ''));
END;
`);
}

function rebuildEventsFtsIndex(db: Database.Database) {
  db.prepare(`INSERT INTO events_fts(events_fts) VALUES ('delete-all')`).run();
  db.prepare(
    `INSERT INTO events_fts(rowid, event_id, content, token, address, reference, user_name)
     SELECT rowid,
            event_id,
            content,
            ${buildEventsFtsTokenExpr('events')},
            ${buildEventsFtsAddressExpr('events')},
            coalesce(tweet_id, coalesce(tx_hash, coalesce(url, ''))),
            coalesce(user_name, '')
     FROM events`
  ).run();
}

function ensureEventsFtsIndexing(db: Database.Database) {
  recreateEventsFtsTriggers(db);

  const rebuilt = getAppStateFlag(db, 'events_fts_metadata_index_v3');
  if (rebuilt) {
    return;
  }

  rebuildEventsFtsIndex(db);
  setAppStateFlag(db, 'events_fts_metadata_index_v3');
}

function migrateLegacyJudgments(db: Database.Database) {
  const legacyJudgmentFile = getLegacyJudgmentFilePath();
  const migrated = getAppStateFlag(db, 'legacy_tx_judgments_migrated_v1');
  if (migrated) {
    return;
  }

  if (!existsSync(legacyJudgmentFile)) {
    setAppStateFlag(db, 'legacy_tx_judgments_migrated_v1');
    return;
  }

  const raw = readFileSync(legacyJudgmentFile, 'utf8');
  const parsed = parseJSON<{ records?: Array<Record<string, unknown>> }>(raw, {});
  const records = Array.isArray(parsed.records) ? parsed.records : [];

  const insertStmt = db.prepare(
    `INSERT INTO activity_judgments (
      chain,
      tracked_address,
      tracked_address_lower,
      tx_hash,
      tx_hash_lower,
      tx_action,
      token,
      value,
      token_address,
      from_address,
      to_address,
      uncertain_from,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chain, tracked_address_lower, tx_hash_lower)
    DO UPDATE SET
      tx_action = excluded.tx_action,
      token = excluded.token,
      value = excluded.value,
      token_address = excluded.token_address,
      from_address = excluded.from_address,
      to_address = excluded.to_address,
      uncertain_from = excluded.uncertain_from,
      updated_at = excluded.updated_at`
  );

  const tx = db.transaction((items: Array<Record<string, unknown>>) => {
    for (const item of items) {
      const chain = normalize(typeof item.chain === 'string' ? item.chain : '');
      const address = typeof item.address === 'string' ? item.address.trim() : '';
      const addressLower = normalize(address);
      const txHash = typeof item.txHash === 'string' ? item.txHash.trim() : '';
      const txHashLower = normalize(txHash);
      const txAction = typeof item.txAction === 'string' ? item.txAction.trim() : '';
      if (!chain || !addressLower || !txHashLower || !txAction) {
        continue;
      }

      const updatedAt = typeof item.updatedAt === 'number' ? item.updatedAt : Date.now();
      insertStmt.run(
        chain,
        address,
        addressLower,
        txHash,
        txHashLower,
        txAction,
        typeof item.token === 'string' ? item.token : null,
        typeof item.value === 'string' ? item.value : null,
        typeof item.tokenAddress === 'string' ? item.tokenAddress : null,
        typeof item.fromAddress === 'string' ? item.fromAddress : null,
        typeof item.toAddress === 'string' ? item.toAddress : null,
        item.uncertainFrom ? 1 : 0,
        updatedAt
      );
    }
  });

  tx(records);
  setAppStateFlag(db, 'legacy_tx_judgments_migrated_v1');
}

function initializeDb(db: Database.Database) {
  if (initialized) {
    return;
  }

  db.exec(SCHEMA_SQL);
  ensureTelegramChannelSourceColumns(db);
  ensureTelegramChannelPostSchema(db);
  ensureTelegramMonitorEventColumns(db);
  ensureActivityJudgmentColumns(db);
  ensureTwitterSyncCursorColumns(db);
  ensureEventsFtsIndexing(db);
  migrateLegacyJudgments(db);
  initialized = true;
}

function hasColumn(db: Database.Database, tableName: string, columnName: string) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === columnName);
}

function ensureColumn(
  db: Database.Database,
  tableName: string,
  columnName: string,
  sqlType: string,
  defaultClause?: string
) {
  if (hasColumn(db, tableName, columnName)) {
    return;
  }

  const defaultSql = defaultClause ? ` DEFAULT ${defaultClause}` : '';
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${sqlType}${defaultSql}`);
}

function ensureTelegramMonitorEventColumns(db: Database.Database) {
  ensureColumn(db, 'telegram_monitor_events', 'wallet_group_label', 'TEXT');
  ensureColumn(db, 'telegram_monitor_events', 'wallet_alias_label', 'TEXT');
  ensureColumn(db, 'telegram_monitor_events', 'tracked_wallet_address', 'TEXT');
  ensureColumn(db, 'telegram_monitor_events', 'tracked_wallet_address_lower', 'TEXT');
  ensureColumn(db, 'telegram_monitor_events', 'action_label', 'TEXT');
  ensureColumn(db, 'telegram_monitor_events', 'action_variant', 'TEXT');
  ensureColumn(db, 'telegram_monitor_events', 'message_links_json', 'TEXT', "'[]'");
  ensureColumn(db, 'telegram_monitor_tx_states', 'repair_claimed_at', 'INTEGER');
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_telegram_monitor_tx_states_repair_claim
     ON telegram_monitor_tx_states(reconciliation_status, repair_claimed_at, next_retry_at)`
  );
}

function ensureTelegramChannelSourceColumns(db: Database.Database) {
  ensureColumn(db, 'telegram_channel_sources', 'source_kind', 'TEXT', "'auto'");
}

function ensureTelegramChannelPostSchema(db: Database.Database) {
  if (!hasColumn(db, 'telegram_channel_posts', 'source_id') && !hasColumn(db, 'telegram_channel_posts', 'user_id')) {
    db.exec('DROP INDEX IF EXISTS idx_telegram_channel_posts_source_recent');
    db.exec('DROP INDEX IF EXISTS idx_telegram_channel_posts_user_recent');
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_telegram_channel_posts_recent
       ON telegram_channel_posts(channel_chat_id, message_id DESC, posted_at_ms DESC)`
    );
    return;
  }

  const migrate = db.transaction(() => {
    db.exec('DROP INDEX IF EXISTS idx_telegram_channel_posts_source_recent');
    db.exec('DROP INDEX IF EXISTS idx_telegram_channel_posts_user_recent');
    db.exec('DROP INDEX IF EXISTS idx_telegram_channel_posts_recent');
    db.exec('ALTER TABLE telegram_channel_posts RENAME TO telegram_channel_posts_legacy_v1');
    db.exec(`
CREATE TABLE telegram_channel_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_chat_id TEXT NOT NULL,
  channel_username TEXT,
  channel_title TEXT,
  message_id INTEGER NOT NULL,
  grouped_id TEXT,
  posted_at_ms INTEGER NOT NULL,
  edit_date_ms INTEGER,
  text TEXT NOT NULL DEFAULT '',
  text_entities_json TEXT NOT NULL DEFAULT '[]',
  media_json TEXT NOT NULL DEFAULT '[]',
  link_urls_json TEXT NOT NULL DEFAULT '[]',
  forward_info_json TEXT,
  views INTEGER,
  forwards INTEGER,
  replies INTEGER,
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(channel_chat_id, message_id)
);
CREATE INDEX idx_telegram_channel_posts_recent
ON telegram_channel_posts(channel_chat_id, message_id DESC, posted_at_ms DESC);
    `);
    db.exec(`
INSERT INTO telegram_channel_posts (
  id,
  channel_chat_id,
  channel_username,
  channel_title,
  message_id,
  grouped_id,
  posted_at_ms,
  edit_date_ms,
  text,
  text_entities_json,
  media_json,
  link_urls_json,
  forward_info_json,
  views,
  forwards,
  replies,
  raw_json,
  created_at,
  updated_at
)
SELECT
  ranked.id,
  ranked.channel_chat_id,
  ranked.channel_username,
  ranked.channel_title,
  ranked.message_id,
  ranked.grouped_id,
  ranked.posted_at_ms,
  ranked.edit_date_ms,
  ranked.text,
  ranked.text_entities_json,
  ranked.media_json,
  ranked.link_urls_json,
  ranked.forward_info_json,
  ranked.views,
  ranked.forwards,
  ranked.replies,
  ranked.raw_json,
  ranked.created_at,
  ranked.updated_at
FROM (
  SELECT
    legacy.*,
    ROW_NUMBER() OVER (
      PARTITION BY legacy.channel_chat_id, legacy.message_id
      ORDER BY legacy.updated_at DESC, legacy.created_at DESC, legacy.id DESC
    ) AS row_rank
  FROM telegram_channel_posts_legacy_v1 AS legacy
) AS ranked
WHERE ranked.row_rank = 1;
    `);
    db.exec('DROP TABLE telegram_channel_posts_legacy_v1');
  });
  migrate();
}

function ensureActivityJudgmentColumns(db: Database.Database) {
  ensureColumn(db, 'activity_judgments', 'tx_time', 'INTEGER');
  ensureColumn(db, 'activity_judgments', 'quote_token', 'TEXT');
  ensureColumn(db, 'activity_judgments', 'quote_amount', 'TEXT');
  ensureColumn(db, 'activity_judgments', 'decision', 'TEXT', "'visible'");
  ensureColumn(db, 'activity_judgments', 'reason_code', 'TEXT');
  ensureColumn(db, 'activity_judgments', 'reason_text', 'TEXT');
  ensureColumn(db, 'activity_judgments', 'computed_usd_value', 'REAL');
}

function ensureTwitterSyncCursorColumns(db: Database.Database) {
  ensureColumn(db, 'twitter_sync_cursor', 'covered_since_ms', 'INTEGER');
}

export function getDb() {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = getDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  initializeDb(db);
  dbInstance = db;
  return db;
}

export function withTransaction<T>(fn: (db: Database.Database) => T): T {
  const db = getDb();
  const wrapped = db.transaction(() => fn(db));
  return wrapped();
}
