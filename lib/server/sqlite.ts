import 'server-only';

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

const DATA_DIR = path.join(process.cwd(), '.data');
const DB_PATH = path.join(DATA_DIR, 'web3-feed.sqlite');
// Compatibility import only; live feed semantics now come from parser-built snapshots.
const LEGACY_JUDGMENT_FILE = path.join(DATA_DIR, 'tx-judgments.json');

let dbInstance: Database.Database | null = null;
let initialized = false;

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
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(provider, source_chat_id, source_message_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_monitor_events_tx
ON telegram_monitor_events(chain, token_address_lower, tx_hash_lower, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_monitor_events_time
ON telegram_monitor_events(chain, token_address_lower, event_time_ms DESC);

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
  VALUES (new.rowid, new.event_id, new.content, coalesce(new.token, ''), coalesce(new.address, ''), coalesce(new.tweet_id, coalesce(new.tx_hash, coalesce(new.url, ''))), coalesce(new.user_name, ''));
END;

CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, event_id, content, token, address, reference, user_name)
  VALUES ('delete', old.rowid, old.event_id, old.content, coalesce(old.token, ''), coalesce(old.address, ''), coalesce(old.tweet_id, coalesce(old.tx_hash, coalesce(old.url, ''))), coalesce(old.user_name, ''));
END;

CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, event_id, content, token, address, reference, user_name)
  VALUES ('delete', old.rowid, old.event_id, old.content, coalesce(old.token, ''), coalesce(old.address, ''), coalesce(old.tweet_id, coalesce(old.tx_hash, coalesce(old.url, ''))), coalesce(old.user_name, ''));
  INSERT INTO events_fts(rowid, event_id, content, token, address, reference, user_name)
  VALUES (new.rowid, new.event_id, new.content, coalesce(new.token, ''), coalesce(new.address, ''), coalesce(new.tweet_id, coalesce(new.tx_hash, coalesce(new.url, ''))), coalesce(new.user_name, ''));
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

function migrateLegacyJudgments(db: Database.Database) {
  const migrated = getAppStateFlag(db, 'legacy_tx_judgments_migrated_v1');
  if (migrated) {
    return;
  }

  if (!existsSync(LEGACY_JUDGMENT_FILE)) {
    setAppStateFlag(db, 'legacy_tx_judgments_migrated_v1');
    return;
  }

  const raw = readFileSync(LEGACY_JUDGMENT_FILE, 'utf8');
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
  ensureTelegramMonitorEventColumns(db);
  ensureActivityJudgmentColumns(db);
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

export function getDb() {
  if (dbInstance) {
    return dbInstance;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  initializeDb(db);
  dbInstance = db;
  return db;
}

export function withTransaction<T>(fn: (db: Database.Database) => T): T {
  const db = getDb();
  const wrapped = db.transaction(() => fn(db));
  return wrapped();
}
