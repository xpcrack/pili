import 'server-only';

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
// 必须 < 前端 feed 超时(25s)。30s 时请求会先被浏览器/前端掐死，只剩“超时”，看不到 locked。
const SQLITE_BUSY_TIMEOUT_MS = 8_000;
const SQLITE_INIT_BUSY_ATTEMPTS = 8;
/** Bump when events_fts trigger SQL changes; gates DROP/CREATE on startup. */
const EVENTS_FTS_TRIGGERS_FLAG = 'events_fts_triggers_v3';
const EVENTS_FTS_METADATA_FLAG = 'events_fts_metadata_index_v3';

export interface SqlRunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

export interface SqlStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): SqlRunResult;
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult;
  pragma?(value: string): unknown;
}

const DEFAULT_DATA_DIR = path.join(process.cwd(), '.data');
const COMPLETENESS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS completeness_global_state (
  singleton_key TEXT PRIMARY KEY,
  configured_start_ms INTEGER,
  global_proven_start_ms INTEGER,
  status TEXT NOT NULL,
  active_run_id INTEGER,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS completeness_source_state (
  source TEXT PRIMARY KEY,
  requested_start_ms INTEGER,
  proven_start_ms INTEGER,
  proven_end_ms INTEGER,
  status TEXT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  blocked_reason TEXT,
  checkpoint_json TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS completeness_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reason TEXT,
  trigger TEXT NOT NULL,
  configured_start_ms INTEGER,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  global_proven_start_ms INTEGER,
  summary_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS completeness_run_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  requested_start_ms INTEGER,
  proven_start_ms INTEGER,
  proven_end_ms INTEGER,
  status TEXT NOT NULL,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  stored_count INTEGER NOT NULL DEFAULT 0,
  projected_count INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  checkpoint_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(run_id, source),
  FOREIGN KEY (run_id) REFERENCES completeness_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS completeness_pokes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL,
  source_hint TEXT,
  reason TEXT,
  claimed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_completeness_pokes_claimed
ON completeness_pokes(claimed_at, created_at ASC);
`;

export function resolveDataDir() {
  const customDataDir = (process.env.PILIPILI_DATA_DIR || '').trim();
  if (customDataDir) {
    return path.resolve(customDataDir);
  }

  const fallbackDataDir = path.resolve(process.cwd(), '..', '..', '.data');
  if (existsSync(fallbackDataDir)) {
    return fallbackDataDir;
  }

  return DEFAULT_DATA_DIR;
}

function getDataDir() {
  return resolveDataDir();
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

let dbInstance: SqlDatabase | null = null;
let initialized = false;

/**
 * 独立的「快失败」写连接，busy_timeout = 0。
 *
 * 仅供可丢弃的非关键写（当前唯一用途：sync 的租约心跳 heartbeatIngestionLease）。
 * 这些写撞到别人持有的写锁时，立即收到 SQLITE_BUSY 并在调用方被 catch 掉放弃本轮，
 * 而**不在主事件循环上同步自旋阻塞**。反例：主连接 busy_timeout=8s，撞锁会同步自旋
 * 最多 8s（再叠 withSqliteBusyRetry 的 sleepSync 退避可冻死单 Bun 进程的事件循环
 * 近 20s），把同一进程里所有 GET /api/feed 读取瞬时堵成超时 → 手机端「网络错误」。
 *
 * WAL 下多写连接合法，SQLite 仍同一时刻只允许一个写者，本连接只是不等待锁而已。
 * 新连接不需要重新建表（主连接已初始化 schema），只开库 + 设 PRAGMA。
 */
let fastFailWriteDbInstance: SqlDatabase | null = null;

export function getFastFailWriteDb(): SqlDatabase {
  if (fastFailWriteDbInstance) {
    return fastFailWriteDbInstance;
  }
  const db = createDatabase(getDbPath());
  db.exec('PRAGMA busy_timeout = 0');
  fastFailWriteDbInstance = db;
  return db;
}

function isBunRuntime() {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

export function isSqliteBusyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const maybe = error as { code?: unknown; message?: unknown };
  const code = typeof maybe.code === 'string' ? maybe.code : '';
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_BUSY_RECOVERY') {
    return true;
  }
  const message = typeof maybe.message === 'string' ? maybe.message : String(error);
  return /database is locked|SQLITE_BUSY/i.test(message);
}

function sleepSync(ms: number) {
  const delay = Math.max(0, Math.floor(ms));
  if (delay <= 0) {
    return;
  }
  const bunSleep = (globalThis as { Bun?: { sleepSync?: (value: number) => void } }).Bun?.sleepSync;
  if (typeof bunSleep === 'function') {
    bunSleep(delay);
    return;
  }
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, delay);
  } catch {
    const end = Date.now() + delay;
    while (Date.now() < end) {
      // spin for short backoff when Atomics.wait is unavailable
    }
  }
}

/**
 * Retry a synchronous SQLite call while the DB reports SQLITE_BUSY.
 *
 * `busy_timeout` alone does not cover write-write upgrade conflicts
 * (SQLITE_BUSY_SNAPSHOT) in WAL mode, and this repo runs 4+ writer processes
 * against one file — so every write outside a transaction should go through
 * here. Backoff is exponential with jitter, capped at 8s per attempt.
 */
export function withSqliteBusyRetry<T>(fn: () => T, opts?: { attempts?: number; label?: string }): T {
  const attempts = Math.max(1, opts?.attempts ?? SQLITE_INIT_BUSY_ATTEMPTS);
  const label = opts?.label || 'sqlite';
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (!isSqliteBusyError(error) || attempt >= attempts) {
        throw error;
      }
      const delayMs = Math.min(8_000, 200 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 150);
      console.warn(
        `[sqlite] ${label} busy (attempt ${attempt}/${attempts}), retry in ${delayMs}ms:`,
        error instanceof Error ? error.message : error
      );
      sleepSync(delayMs);
    }
  }
  throw lastError;
}

function createDatabase(dbPath: string): SqlDatabase {
  if (isBunRuntime()) {
    const { Database: BunDatabase } = require('bun:sqlite') as {
      Database: new (filename: string) => {
        exec(sql: string): void;
        prepare(sql: string): SqlStatement;
        transaction<TArgs extends unknown[], TResult>(
          fn: (...args: TArgs) => TResult
        ): (...args: TArgs) => TResult;
      };
    };

    const db = new BunDatabase(dbPath);
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    return {
      exec(sql) {
        db.exec(sql);
      },
      prepare(sql) {
        return db.prepare(sql);
      },
      transaction(fn) {
        return db.transaction(fn);
      },
      pragma(value) {
        db.exec(`PRAGMA ${value}`);
        return undefined;
      },
    };
  }

  const BetterSqlite3 = require('better-sqlite3') as new (filename: string) => SqlDatabase;
  const db = new BetterSqlite3(dbPath);
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  return db;
}

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
PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
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
  twitter_user_id TEXT,
  twitter_avatar_url TEXT,
  telegram TEXT,
  telegrams_json TEXT NOT NULL DEFAULT '[]',
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

CREATE TABLE IF NOT EXISTS current_holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tracked_address TEXT NOT NULL,
  tracked_address_lower TEXT NOT NULL,
  user_id TEXT,
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  token_address_lower TEXT NOT NULL,
  symbol TEXT,
  name TEXT,
  balance REAL,
  price_usd REAL,
  value_usd REAL,
  refreshed_at INTEGER NOT NULL,
  UNIQUE(tracked_address_lower, chain, token_address_lower)
);

CREATE INDEX IF NOT EXISTS idx_holdings_token
ON current_holdings(chain, token_address_lower);

CREATE INDEX IF NOT EXISTS idx_holdings_user
ON current_holdings(user_id);

-- Per-wallet holdings refresh bookkeeping. Was created lazily inside a GET
-- handler (userHoldingsDetails), which meant a fresh DB did not have it until
-- someone happened to read holdings. Declared here so every process can rely on
-- it — the asset-peak guard needs it to tell "all junk" from "never fetched".
CREATE TABLE IF NOT EXISTS current_holdings_wallet_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tracked_address TEXT NOT NULL,
  tracked_address_lower TEXT NOT NULL,
  user_id TEXT,
  chain TEXT NOT NULL,
  status TEXT NOT NULL,
  refreshed_at INTEGER NOT NULL,
  UNIQUE(tracked_address_lower, chain)
);

CREATE INDEX IF NOT EXISTS idx_holdings_wallet_status_user
ON current_holdings_wallet_status(user_id);

CREATE INDEX IF NOT EXISTS idx_holdings_value
ON current_holdings(value_usd);

CREATE TABLE IF NOT EXISTS holder_snapshot_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  token_address_lower TEXT NOT NULL,
  token_symbol TEXT,
  tracked_wallet_address TEXT NOT NULL,
  tracked_wallet_address_lower TEXT NOT NULL,
  user_id TEXT,
  trigger_type TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  trade_action TEXT,
  tx_hash TEXT,
  tx_hash_lower TEXT,
  trade_time_ms INTEGER,
  holdings_refreshed_at INTEGER,
  period_bucket_start_ms INTEGER,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  holder_count INTEGER,
  error TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  requested_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES tracked_users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_holder_snapshot_runs_status_requested
ON holder_snapshot_runs(status, requested_at);

CREATE INDEX IF NOT EXISTS idx_holder_snapshot_runs_wallet_time
ON holder_snapshot_runs(tracked_wallet_address_lower, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_holder_snapshot_runs_token_time
ON holder_snapshot_runs(chain, token_address_lower, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_holder_snapshot_runs_trade_tx
ON holder_snapshot_runs(chain, tracked_wallet_address_lower, tx_hash_lower);

CREATE TABLE IF NOT EXISTS holder_snapshot_holders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_run_id INTEGER NOT NULL,
  holder_rank INTEGER NOT NULL,
  address TEXT NOT NULL,
  account_address TEXT,
  addr_type INTEGER,
  exchange TEXT,
  wallet_tag_v2 TEXT,
  name TEXT,
  twitter_username TEXT,
  balance REAL,
  amount_percentage REAL,
  usd_value REAL,
  cost REAL,
  profit REAL,
  avg_cost REAL,
  realized_profit REAL,
  unrealized_profit REAL,
  buy_tx_count_cur INTEGER,
  sell_tx_count_cur INTEGER,
  is_new INTEGER NOT NULL DEFAULT 0,
  is_suspicious INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(snapshot_run_id, holder_rank),
  FOREIGN KEY (snapshot_run_id) REFERENCES holder_snapshot_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_holder_snapshot_holders_snapshot
ON holder_snapshot_holders(snapshot_run_id, holder_rank);

CREATE INDEX IF NOT EXISTS idx_holder_snapshot_holders_address
ON holder_snapshot_holders(address);

CREATE INDEX IF NOT EXISTS idx_holder_snapshot_holders_twitter
ON holder_snapshot_holders(twitter_username);

CREATE TABLE IF NOT EXISTS asset_peak_validation_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  candidate_total_asset_usd REAL NOT NULL,
  previous_historical_max_asset_usd REAL NOT NULL,
  block_status TEXT NOT NULL,
  reason_text TEXT NOT NULL DEFAULT '',
  top_holdings_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES tracked_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_asset_peak_validation_blocks_user_time
ON asset_peak_validation_blocks(user_id, created_at DESC);

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
  projected_activity_json TEXT,
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
  UNIQUE(chain, tracked_wallet_address_lower, tx_hash_lower, token_address_lower),
  FOREIGN KEY (user_id) REFERENCES tracked_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telegram_monitor_tx_states_recent
ON telegram_monitor_tx_states(event_time_ms DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_monitor_tx_states_repair
ON telegram_monitor_tx_states(reconciliation_status, next_retry_at, updated_at DESC);

-- Cross-process doorbell: XXYY (bridge) rings, live-monitor (web) claims → GMGN.
CREATE TABLE IF NOT EXISTS live_doorbell_queue (
  wallet_lower TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  user_id TEXT NOT NULL,
  chains_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'xxyy',
  due_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  -- Confirmed-consume lease: claim stamps these, ack (success) deletes the row,
  -- nack (scan failure) clears them + reschedules due_at_ms. NULL ⇒ available.
  claim_lease_token TEXT,
  claimed_at_ms INTEGER,
  lease_expires_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_live_doorbell_queue_due
ON live_doorbell_queue(due_at_ms ASC);

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
  channel_type TEXT NOT NULL DEFAULT 'social',
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
  channel_type TEXT NOT NULL DEFAULT 'social',
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

-- person-page feed: readActivityBreakdownByUser does SUM(CASE WHEN source=...) WHERE user_id=?,
-- which was a full SCAN of activity_feed (~1.8s per click) before this index existed.
CREATE INDEX IF NOT EXISTS idx_activity_feed_user
ON activity_feed(user_id, source);

CREATE TABLE IF NOT EXISTS twitter_tweets (
  tweet_id TEXT PRIMARY KEY,
  author_user_id TEXT,
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
  quoted_translation_zh TEXT,
  quoted_translation_status TEXT NOT NULL DEFAULT 'pending',
  vision_status TEXT NOT NULL DEFAULT 'pending',
  vision_processed_at_ms INTEGER,
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
  origin TEXT NOT NULL DEFAULT 'text',
  market_cap_usd REAL,
  market_cap_at_post_usd REAL,
  market_cap_at_post_estimated INTEGER NOT NULL DEFAULT 0,
  market_cap_source TEXT,
  resolved_at_ms INTEGER,
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
  avatar_url TEXT,
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

-- Per-wallet GMGN activity timeline completeness (rolling ≥14d).
-- Separate from tracked_addresses.last_synced_at (OKX asset/sync path).
CREATE TABLE IF NOT EXISTS wallet_timeline_state (
  address_lower TEXT PRIMARY KEY,
  last_backfill_at INTEGER,
  last_ok_at INTEGER,
  window_start_ms INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wallet_timeline_state_last_ok
ON wallet_timeline_state(last_ok_at);

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

CREATE INDEX IF NOT EXISTS idx_events_updated_at
ON events(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_timestamp
ON events(timestamp DESC, event_id DESC);

CREATE INDEX IF NOT EXISTS idx_events_source_timestamp
ON events(source, timestamp DESC, event_id DESC);

CREATE INDEX IF NOT EXISTS idx_events_user_timestamp
ON events(user_id, timestamp DESC, event_id DESC);

CREATE INDEX IF NOT EXISTS idx_events_chain_address_timestamp
ON events(chain, address, timestamp DESC, event_id DESC);

CREATE INDEX IF NOT EXISTS idx_events_blockchain_chain_address_lower_timestamp
ON events(source, chain, LOWER(address), timestamp DESC, event_id DESC);

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

${COMPLETENESS_SCHEMA_SQL}

CREATE TABLE IF NOT EXISTS feed_content_revision (
  singleton_key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Realized/unrealized PnL derived from events. One row per position round trip
-- (a series segment from zero shares back to zero shares) per
-- chain|wallet|token series. Derived data only: safe to DELETE and recompute.
CREATE TABLE IF NOT EXISTS wallet_token_pnl (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  series_key TEXT NOT NULL,
  round_index INTEGER NOT NULL,
  user_id TEXT,
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  wallet_address_lower TEXT NOT NULL,
  token_address TEXT NOT NULL,
  token_address_lower TEXT NOT NULL,
  token_symbol TEXT,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  last_trade_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  confidence TEXT NOT NULL,
  buy_count INTEGER NOT NULL DEFAULT 0,
  sell_count INTEGER NOT NULL DEFAULT 0,
  buy_usd REAL NOT NULL DEFAULT 0,
  sell_usd REAL NOT NULL DEFAULT 0,
  cost_basis_sold_usd REAL NOT NULL DEFAULT 0,
  realized_pnl_usd REAL NOT NULL DEFAULT 0,
  realized_multiple REAL,
  remaining_shares REAL NOT NULL DEFAULT 0,
  remaining_cost_usd REAL NOT NULL DEFAULT 0,
  avg_cost_price_usd REAL,
  entry_market_cap_usd REAL,
  -- 1 when the closing sell was a same-tx swap into another token (换仓),
  -- not a deliberate exit. Keeps hold-time honest for 满仓换仓 traders.
  closed_by_swap INTEGER NOT NULL DEFAULT 0,
  -- Emptied by a transfer out rather than a sale; excluded from win rate.
  exited_by_transfer INTEGER NOT NULL DEFAULT 0,
  max_single_buy_usd REAL NOT NULL DEFAULT 0,
  computed_at INTEGER NOT NULL,
  UNIQUE(series_key, round_index)
);

CREATE INDEX IF NOT EXISTS idx_wallet_token_pnl_user
ON wallet_token_pnl(user_id, status, confidence);

CREATE INDEX IF NOT EXISTS idx_wallet_token_pnl_token
ON wallet_token_pnl(chain, token_address_lower);

CREATE INDEX IF NOT EXISTS idx_wallet_token_pnl_series
ON wallet_token_pnl(series_key);

-- Sent trade-signal alerts. Persisted (not in-memory) so a worker restart does
-- not re-push signals the user already saw.
CREATE TABLE IF NOT EXISTS trade_signal_alerts (
  dedupe_key TEXT PRIMARY KEY,
  signal_type TEXT NOT NULL,
  user_id TEXT,
  chain TEXT NOT NULL,
  token_address_lower TEXT NOT NULL,
  token_symbol TEXT,
  trade_amount_usd REAL,
  market_cap_usd REAL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  triggered_at INTEGER NOT NULL,
  sent_at INTEGER,
  delivered INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_trade_signal_alerts_recent
ON trade_signal_alerts(triggered_at DESC);

-- Per-person rollup of wallet_token_pnl. Rebuilt wholesale on each run.
-- One row per (person, time window). A person's style changes: rop traded 504
-- tokens over 2.5y but only 24 in the last 90 days, so an all-time aggregate
-- hides what they are doing now.
CREATE TABLE IF NOT EXISTS user_pnl_stats (
  user_id TEXT NOT NULL,
  window_key TEXT NOT NULL DEFAULT 'all',
  realized_pnl_usd REAL NOT NULL DEFAULT 0,
  unrealized_pnl_usd REAL,
  round_trips INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  win_rate REAL,
  median_multiple REAL,
  avg_win_usd REAL,
  avg_loss_usd REAL,
  profit_factor REAL,
  median_entry_market_cap_usd REAL,
  open_positions INTEGER NOT NULL DEFAULT 0,
  partial_round_trips INTEGER NOT NULL DEFAULT 0,
  transfer_exit_rounds INTEGER NOT NULL DEFAULT 0,
  median_max_single_buy_usd REAL,
  big_buy_win_rate REAL,
  big_buy_round_trips INTEGER NOT NULL DEFAULT 0,
  coverage_ratio REAL,
  first_trade_at INTEGER,
  last_trade_at INTEGER,
  -- 可跟单性维度（口径见 LLMwiki「meme信息源管理 / 如何评价一个链上个体」）:
  -- 出手币数越少越好、持仓越久越好、入场市值越高越好、胜率越高越好。
  distinct_tokens INTEGER NOT NULL DEFAULT 0,
  total_buys INTEGER NOT NULL DEFAULT 0,
  avg_hold_hours REAL,
  -- Excludes rounds closed by a swap, so 满仓换仓 does not read as short holding.
  avg_hold_hours_excl_swap REAL,
  swap_closed_rounds INTEGER NOT NULL DEFAULT 0,
  -- Simple mean over buys (not amount-weighted), matching the wiki's 回填口径.
  avg_entry_market_cap_usd REAL,
  followability_score REAL,
  followability_parts_json TEXT,
  -- 复合质量分 = followability_score × volume_factor × conviction_factor.
  -- 修正 followability 百分位「不区分样本量」的病根（小样本假高 vs 大样本真钱），
  -- 见 docs/smart-money-compound-score-plan.md。两 factor 为绝对饱和曲线，与百分位解耦。
  compound_quality_score REAL,
  compound_quality_parts_json TEXT,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, window_key)
);

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

function getAppStateFlag(db: SqlDatabase, key: string) {
  const row = db
    .prepare('SELECT value_json FROM app_state WHERE key = ? LIMIT 1')
    .get(key) as { value_json: string } | undefined;
  if (!row) {
    return false;
  }
  const parsed = parseJSON<{ done?: boolean }>(row.value_json, {});
  return parsed.done === true;
}

function setAppStateFlag(db: SqlDatabase, key: string) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO app_state (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify({ done: true, at: now }), now);
}

function recreateEventsFtsTriggers(db: SqlDatabase) {
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

function rebuildEventsFtsIndex(db: SqlDatabase) {
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

function eventsFtsTriggersPresent(db: SqlDatabase) {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'trigger' AND name IN ('events_ai', 'events_ad', 'events_au')`
    )
    .all() as Array<{ name?: string }>;
  const names = new Set(rows.map((row) => row.name || '').filter(Boolean));
  return names.has('events_ai') && names.has('events_ad') && names.has('events_au');
}

function ensureEventsFtsIndexing(db: SqlDatabase) {
  // DROP/CREATE triggers takes a schema write lock. Only do it when triggers
  // are missing or the version flag was bumped — every worker used to hit this
  // on boot and thrash under SQLITE_BUSY.
  const flagReady = getAppStateFlag(db, EVENTS_FTS_TRIGGERS_FLAG);
  const present = eventsFtsTriggersPresent(db);
  if (!present) {
    recreateEventsFtsTriggers(db);
    setAppStateFlag(db, EVENTS_FTS_TRIGGERS_FLAG);
  } else if (!flagReady) {
    // Triggers already exist (e.g. from SCHEMA_SQL IF NOT EXISTS). Stamp flag
    // without DROP/CREATE so concurrent workers don't take a schema lock.
    setAppStateFlag(db, EVENTS_FTS_TRIGGERS_FLAG);
  }

  const rebuilt = getAppStateFlag(db, EVENTS_FTS_METADATA_FLAG);
  if (rebuilt) {
    return;
  }

  rebuildEventsFtsIndex(db);
  setAppStateFlag(db, EVENTS_FTS_METADATA_FLAG);
}

function migrateLegacyJudgments(db: SqlDatabase) {
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

function initializeDb(db: SqlDatabase) {
  if (initialized) {
    return;
  }

  withSqliteBusyRetry(() => {
    // user_pnl_stats is fully derived and its PK changed when time windows were
    // added, which ALTER TABLE cannot do. Drop the pre-window shape so the
    // CREATE below rebuilds it; the next PnL cycle repopulates it.
    if (tableExists(db, 'user_pnl_stats') && !hasColumn(db, 'user_pnl_stats', 'window_key')) {
      db.exec('DROP TABLE user_pnl_stats');
    }
    db.exec(SCHEMA_SQL);
    ensureTelegramChannelSourceColumns(db);
    ensureTelegramChannelPostSchema(db);
    ensureTelegramMonitorEventColumns(db);
    ensureLiveDoorbellColumns(db);
    ensureWalletPnlColumns(db);
    ensureTelegramMonitorTxStatesTokenAwareSchema(db);
    ensureActivityJudgmentColumns(db);
    ensureTwitterSyncCursorColumns(db);
    ensureTwitterIdentityColumns(db);
    ensureTwitterEnrichmentColumns(db);
    ensureTelegramsJsonColumn(db);
    ensureMonitoringEnabledColumns(db);
    ensureCompletenessSchema(db);
    ensureWalletTimelineStateSchema(db);
    ensureEventsFtsIndexing(db);
    migrateLegacyJudgments(db);
  }, { label: 'initializeDb' });
  initialized = true;
}

function tableExists(db: SqlDatabase, tableName: string) {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
    .get(tableName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function hasColumn(db: SqlDatabase, tableName: string, columnName: string) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === columnName);
}

function ensureColumn(
  db: SqlDatabase,
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

/**
 * Confirmed-consume lease columns for live_doorbell_queue. The two partial
 * indexes must be created here (after ensureColumn adds the columns), NOT in
 * SCHEMA_SQL: db.exec(SCHEMA_SQL) runs before the ensure* chain, so on a
 * pre-existing DB the columns don't exist yet and a SCHEMA_SQL index referencing
 * them would throw "no such column" at startup.
 */
function ensureLiveDoorbellColumns(db: SqlDatabase) {
  ensureColumn(db, 'live_doorbell_queue', 'claim_lease_token', 'TEXT');
  ensureColumn(db, 'live_doorbell_queue', 'claimed_at_ms', 'INTEGER');
  ensureColumn(db, 'live_doorbell_queue', 'lease_expires_at_ms', 'INTEGER');
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_live_doorbell_queue_claim ON live_doorbell_queue(due_at_ms ASC) WHERE lease_expires_at_ms IS NULL`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_live_doorbell_queue_lease ON live_doorbell_queue(lease_expires_at_ms ASC) WHERE lease_expires_at_ms IS NOT NULL`
  );
}

function ensureTelegramMonitorTxStatesTokenAwareSchema(db: SqlDatabase) {
  const indexRows = db.prepare(`PRAGMA index_list(telegram_monitor_tx_states)`).all() as Array<{ name?: string; unique?: number }>;
  const uniqueIndex = indexRows.find((row) => row.unique === 1);
  if (uniqueIndex?.name) {
    const columns = db.prepare(`PRAGMA index_info(${uniqueIndex.name})`).all() as Array<{ name?: string }>;
    const columnNames = columns.map((row) => row.name || '');
    if (columnNames.includes('token_address_lower')) {
      return;
    }
  }

  const migrate = db.transaction(() => {
    db.exec('DROP INDEX IF EXISTS idx_telegram_monitor_tx_states_recent');
    db.exec('DROP INDEX IF EXISTS idx_telegram_monitor_tx_states_repair');
    db.exec('DROP INDEX IF EXISTS idx_telegram_monitor_tx_states_repair_claim');
    db.exec('ALTER TABLE telegram_monitor_tx_states RENAME TO telegram_monitor_tx_states_legacy_v1');
    db.exec(`
CREATE TABLE telegram_monitor_tx_states (
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
  UNIQUE(chain, tracked_wallet_address_lower, tx_hash_lower, token_address_lower),
  FOREIGN KEY (user_id) REFERENCES tracked_users(id) ON DELETE CASCADE
);
CREATE INDEX idx_telegram_monitor_tx_states_recent
ON telegram_monitor_tx_states(event_time_ms DESC, updated_at DESC);
CREATE INDEX idx_telegram_monitor_tx_states_repair
ON telegram_monitor_tx_states(reconciliation_status, next_retry_at, updated_at DESC);
CREATE INDEX idx_telegram_monitor_tx_states_repair_claim
ON telegram_monitor_tx_states(reconciliation_status, repair_claimed_at, next_retry_at);
    `);
    db.exec(`
INSERT INTO telegram_monitor_tx_states (
  id, user_id, chain, tracked_wallet_address, tracked_wallet_address_lower, tx_hash, tx_hash_lower,
  token_address, token_address_lower, token_symbol, provisional_action, provisional_action_label,
  provisional_action_variant, provisional_quote_amount, provisional_quote_symbol, provisional_token_amount,
  provisional_token_symbol, provisional_price_usd, provisional_market_cap_usd, provisional_raw_text,
  provisional_message_links_json, provisional_wallet_label, provisional_wallet_group_label,
  provisional_wallet_alias_label, event_time_ms, canonical_activity_json, reconciliation_status,
  reconciled_source, first_seen_at, last_seen_at, reconciled_at, next_retry_at, repair_claimed_at,
  retry_count, last_error, updated_at
)
SELECT id, user_id, chain, tracked_wallet_address, tracked_wallet_address_lower, tx_hash, tx_hash_lower,
  token_address, token_address_lower, token_symbol, provisional_action, provisional_action_label,
  provisional_action_variant, provisional_quote_amount, provisional_quote_symbol, provisional_token_amount,
  provisional_token_symbol, provisional_price_usd, provisional_market_cap_usd, provisional_raw_text,
  provisional_message_links_json, provisional_wallet_label, provisional_wallet_group_label,
  provisional_wallet_alias_label, event_time_ms, canonical_activity_json, reconciliation_status,
  reconciled_source, first_seen_at, last_seen_at, reconciled_at, next_retry_at, repair_claimed_at,
  retry_count, last_error, updated_at
FROM telegram_monitor_tx_states_legacy_v1;
    `);
    db.exec('DROP TABLE telegram_monitor_tx_states_legacy_v1');
  });
  migrate();
}

/**
 * Both PnL tables are fully derived and rewritten wholesale each run, so new
 * columns just need to exist — the next cycle backfills their values.
 */
function ensureWalletPnlColumns(db: SqlDatabase) {
  ensureColumn(db, 'wallet_token_pnl', 'closed_by_swap', 'INTEGER NOT NULL', '0');
  ensureColumn(db, 'wallet_token_pnl', 'exited_by_transfer', 'INTEGER NOT NULL', '0');
  ensureColumn(db, 'wallet_token_pnl', 'max_single_buy_usd', 'REAL NOT NULL', '0');
  ensureColumn(db, 'user_pnl_stats', 'transfer_exit_rounds', 'INTEGER NOT NULL', '0');
  ensureColumn(db, 'user_pnl_stats', 'median_max_single_buy_usd', 'REAL');
  ensureColumn(db, 'user_pnl_stats', 'big_buy_win_rate', 'REAL');
  ensureColumn(db, 'user_pnl_stats', 'big_buy_round_trips', 'INTEGER NOT NULL', '0');
  ensureColumn(db, 'user_pnl_stats', 'distinct_tokens', 'INTEGER NOT NULL', '0');
  ensureColumn(db, 'user_pnl_stats', 'total_buys', 'INTEGER NOT NULL', '0');
  ensureColumn(db, 'user_pnl_stats', 'avg_hold_hours', 'REAL');
  ensureColumn(db, 'user_pnl_stats', 'avg_hold_hours_excl_swap', 'REAL');
  ensureColumn(db, 'user_pnl_stats', 'swap_closed_rounds', 'INTEGER NOT NULL', '0');
  ensureColumn(db, 'user_pnl_stats', 'avg_entry_market_cap_usd', 'REAL');
  ensureColumn(db, 'user_pnl_stats', 'followability_score', 'REAL');
  ensureColumn(db, 'user_pnl_stats', 'followability_parts_json', 'TEXT');
  ensureColumn(db, 'user_pnl_stats', 'selector_score', 'REAL');
  ensureColumn(db, 'user_pnl_stats', 'selector_hit_rate', 'REAL');
  ensureColumn(db, 'user_pnl_stats', 'selector_round_trips', 'INTEGER NOT NULL', '0');
  ensureColumn(db, 'user_pnl_stats', 'compound_quality_score', 'REAL');
  ensureColumn(db, 'user_pnl_stats', 'compound_quality_parts_json', 'TEXT');
}

function ensureTelegramMonitorEventColumns(db: SqlDatabase) {
  ensureColumn(db, 'telegram_monitor_events', 'wallet_group_label', 'TEXT');
  ensureColumn(db, 'telegram_monitor_events', 'wallet_alias_label', 'TEXT');
  ensureColumn(db, 'telegram_monitor_events', 'tracked_wallet_address', 'TEXT');
  ensureColumn(db, 'telegram_monitor_events', 'tracked_wallet_address_lower', 'TEXT');
  ensureColumn(db, 'telegram_monitor_events', 'action_label', 'TEXT');
  ensureColumn(db, 'telegram_monitor_events', 'action_variant', 'TEXT');
  ensureColumn(db, 'telegram_monitor_events', 'message_links_json', 'TEXT', "'[]'");
  ensureColumn(db, 'telegram_monitor_events', 'projected_activity_json', 'TEXT');
  ensureColumn(db, 'telegram_monitor_tx_states', 'repair_claimed_at', 'INTEGER');
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_telegram_monitor_tx_states_repair_claim
     ON telegram_monitor_tx_states(reconciliation_status, repair_claimed_at, next_retry_at)`
  );
}

function ensureTelegramChannelSourceColumns(db: SqlDatabase) {
  ensureColumn(db, 'telegram_channel_sources', 'source_kind', 'TEXT', "'auto'");
  ensureColumn(db, 'telegram_channel_sources', 'channel_type', 'TEXT', "'social'");
}

function ensureTelegramChannelPostSchema(db: SqlDatabase) {
  ensureColumn(db, 'telegram_channel_posts', 'channel_type', 'TEXT', "'social'");
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
  channel_type TEXT NOT NULL DEFAULT 'social',
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
  channel_type,
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
  'social',
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

function ensureActivityJudgmentColumns(db: SqlDatabase) {
  ensureColumn(db, 'activity_judgments', 'tx_time', 'INTEGER');
  ensureColumn(db, 'activity_judgments', 'quote_token', 'TEXT');
  ensureColumn(db, 'activity_judgments', 'quote_amount', 'TEXT');
  ensureColumn(db, 'activity_judgments', 'decision', 'TEXT', "'visible'");
  ensureColumn(db, 'activity_judgments', 'reason_code', 'TEXT');
  ensureColumn(db, 'activity_judgments', 'reason_text', 'TEXT');
  ensureColumn(db, 'activity_judgments', 'computed_usd_value', 'REAL');
}

function ensureTwitterSyncCursorColumns(db: SqlDatabase) {
  ensureColumn(db, 'twitter_sync_cursor', 'covered_since_ms', 'INTEGER');
}

function ensureTwitterIdentityColumns(db: SqlDatabase) {
  ensureColumn(db, 'tracked_users', 'twitter_user_id', 'TEXT');
  ensureColumn(db, 'tracked_users', 'twitter_avatar_url', 'TEXT');
  ensureColumn(db, 'twitter_tweets', 'author_user_id', 'TEXT');
  ensureColumn(db, 'twitter_identity_cache', 'avatar_url', 'TEXT');
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_twitter_tweets_author_user_created
     ON twitter_tweets(author_user_id, created_at_ms DESC)`
  );
}

function ensureTwitterEnrichmentColumns(db: SqlDatabase) {
  ensureColumn(db, 'twitter_tweet_enrichments', 'quoted_translation_zh', 'TEXT');
  ensureColumn(db, 'twitter_tweet_enrichments', 'quoted_translation_status', 'TEXT', "'pending'");
  ensureColumn(db, 'twitter_tweet_enrichments', 'vision_status', 'TEXT', "'pending'");
  ensureColumn(db, 'twitter_tweet_enrichments', 'vision_processed_at_ms', 'INTEGER');

  ensureColumn(db, 'twitter_tweet_token_mentions', 'origin', 'TEXT', "'text'");
  ensureColumn(db, 'twitter_tweet_token_mentions', 'market_cap_usd', 'REAL');
  ensureColumn(db, 'twitter_tweet_token_mentions', 'market_cap_at_post_usd', 'REAL');
  ensureColumn(db, 'twitter_tweet_token_mentions', 'market_cap_at_post_estimated', 'INTEGER', '0');
  ensureColumn(db, 'twitter_tweet_token_mentions', 'market_cap_source', 'TEXT');
  ensureColumn(db, 'twitter_tweet_token_mentions', 'resolved_at_ms', 'INTEGER');
}

function ensureTelegramsJsonColumn(db: SqlDatabase) {
  ensureColumn(db, 'tracked_users', 'telegrams_json', 'TEXT', "'[]'");
}

/**
 * Feishu/newone enablement mirror.
 * Default 1 keeps legacy DBs collecting until the first sync:feishu-enablement run.
 */
function ensureMonitoringEnabledColumns(db: SqlDatabase) {
  ensureColumn(db, 'tracked_users', 'monitoring_enabled', 'INTEGER', '1');
  ensureColumn(db, 'tracked_addresses', 'monitoring_enabled', 'INTEGER', '1');
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tracked_addresses_monitoring_enabled
     ON tracked_addresses(monitoring_enabled, address_lower)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tracked_users_monitoring_enabled
     ON tracked_users(monitoring_enabled)`
  );
}

function ensureCompletenessSchema(db: SqlDatabase) {
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_completeness_run_sources_run_source
     ON completeness_run_sources(run_id, source)`
  );
}

function ensureWalletTimelineStateSchema(db: SqlDatabase) {
  db.exec(`
CREATE TABLE IF NOT EXISTS wallet_timeline_state (
  address_lower TEXT PRIMARY KEY,
  last_backfill_at INTEGER,
  last_ok_at INTEGER,
  window_start_ms INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wallet_timeline_state_last_ok
ON wallet_timeline_state(last_ok_at);
`);
}

export function getDb() {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = getDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = createDatabase(dbPath);
  initializeDb(db);
  // Web processes must NOT run checkpoint timers — the background worker owns it.
  // Only non-web processes (background worker, CLI scripts) get the timer.
  if (process.env.PILIPILI_WEB_PROCESS !== 'true') {
    const checkpointMode =
      (process.env.PILIPILI_WAL_CHECKPOINT || '').trim().toUpperCase() === 'TRUNCATE'
        ? 'TRUNCATE'
        : 'PASSIVE';
    setInterval(() => {
      try {
        if (typeof db.pragma === 'function') {
          db.pragma(`wal_checkpoint(${checkpointMode})`);
        }
      } catch (error) {
        console.warn('[sqlite] wal_checkpoint failed:', error);
      }
    }, 10 * 60 * 1000).unref();
  }
  dbInstance = db;
  return db;
}

export type DbHandle = SqlDatabase;

export function withTransaction<T>(fn: (db: DbHandle) => T): T {
  const db = getDb();
  const wrapped = db.transaction(() => fn(db));
  return wrapped();
}

export function withTransactionTyped<T>(fn: (db: SqlDatabase) => T): T {
  const db = getDb();
  const wrapped = db.transaction(() => fn(db));
  return wrapped();
}
