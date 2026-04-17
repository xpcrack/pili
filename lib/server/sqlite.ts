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

CREATE TABLE IF NOT EXISTS activity_judgments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL,
  tracked_address TEXT NOT NULL,
  tracked_address_lower TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  tx_hash_lower TEXT NOT NULL,
  tx_action TEXT NOT NULL,
  token TEXT,
  value TEXT,
  token_address TEXT,
  from_address TEXT,
  to_address TEXT,
  uncertain_from INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
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
  migrateLegacyJudgments(db);
  initialized = true;
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
