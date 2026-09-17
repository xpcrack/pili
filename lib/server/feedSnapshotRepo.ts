import 'server-only';

import { type Activity, type User } from '@/types';
import { buildActivityScopedDedupKey } from '@/lib/activityIdentity';
import { scoreFeedRowsChronologically } from '@/lib/server/activityImportanceService';
import { SQLITE_WRITE_CHUNK_ROWS, forEachWriteChunk, getDb, withTransaction } from '@/lib/server/sqlite';
import { upsertEventsFromFeedRows } from '@/lib/server/eventsRepo';

export interface FeedSnapshotState {
  summary: {
    userCount: number;
    addressCount: number;
    transactionCount: number;
    successfulAddressCount: number;
    failedAddressCount: number;
    emptyAddressCount: number;
    completedAt: number;
  };
  diagnostics: Array<{
    userId: string;
    userName: string;
    address: string;
    addressName: string;
    chain: string;
    ok: boolean;
    transactionCount: number;
    error: string | null;
  }>;
  runId: number;
}

export interface FeedBackfillWindowState {
  globalEarliestMs: number | null;
  perUserEarliestMs: Record<string, number>;
  perUserHistoryComplete: Record<string, boolean>;
  perUserLastBackfillAt: Record<string, number>;
  perUserLocalQualifiedCount: Record<string, number>;
  globalAlignment: 'aligned' | 'partial';
  updatedAt: number;
}

export interface RawTransactionSnapshot {
  chain: string;
  trackedAddress: string;
  txHash: string;
  txTime: number | null;
  payload: unknown;
}

export interface ActivityJudgmentSnapshot {
  chain: string;
  trackedAddress: string;
  txHash: string;
  txTime?: number | null;
  txAction: 'buy' | 'sell' | 'send' | 'receive';
  token?: string;
  value?: string;
  tokenAddress?: string;
  quoteToken?: string;
  quoteAmount?: string;
  fromAddress?: string;
  toAddress?: string;
  uncertainFrom: boolean;
  decision: 'visible' | 'hidden' | 'pending';
  reasonCode: string;
  reasonText: string;
  computedUsdValue?: number | null;
}

interface FeedRow {
  user_id: string;
  chain: string | null;
  tracked_address_lower: string | null;
  user_json: string;
  activity_json: string;
  timestamp: number;
}

interface RawPayloadRow {
  chain: string;
  tracked_address_lower: string;
  tx_hash_lower: string;
  payload_json: string;
}

const FEED_BACKFILL_WINDOW_STATE_KEY = 'feed_backfill_window_state_v1';

const SNAPSHOT_POISON_SENDER_FANOUT_MIN_RECIPIENTS = 3;
const SNAPSHOT_POISON_SENDER_FANOUT_MIN_TRANSFERS = 3;
const ENABLE_LEGACY_SNAPSHOT_REPAIRS = process.env.ENABLE_LEGACY_SNAPSHOT_REPAIRS === 'true';
const ENABLE_LEGACY_POISON_FILTER = process.env.ENABLE_LEGACY_POISON_FILTER === 'true';

if (ENABLE_LEGACY_SNAPSHOT_REPAIRS) {
  console.warn('[feedSnapshotRepo] ⚠️ Legacy snapshot repair compatibility mode is enabled');
}

if (ENABLE_LEGACY_POISON_FILTER) {
  console.warn('[feedSnapshotRepo] ⚠️ Legacy poison filtering compatibility mode is enabled');
}

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

function normalizeWindowState(state: FeedBackfillWindowState | null) {
  if (!state) {
    return null;
  }

  return {
    globalEarliestMs: typeof state.globalEarliestMs === 'number' ? state.globalEarliestMs : null,
    perUserEarliestMs: state.perUserEarliestMs || {},
    perUserHistoryComplete: state.perUserHistoryComplete || {},
    perUserLastBackfillAt: state.perUserLastBackfillAt || {},
    perUserLocalQualifiedCount: state.perUserLocalQualifiedCount || {},
    globalAlignment: state.globalAlignment === 'partial' ? 'partial' : 'aligned',
    updatedAt: typeof state.updatedAt === 'number' ? state.updatedAt : Date.now(),
  } satisfies FeedBackfillWindowState;
}

const NATIVE_SYMBOLS_BY_CHAIN: Record<string, Set<string>> = {
  bsc: new Set(['bnb', 'wbnb']),
  solana: new Set(['sol', 'wsol']),
};

function isNativeSymbol(chain: string | undefined, symbol: string | undefined) {
  const normalizedChain = normalize(chain);
  const normalizedSymbol = normalize(symbol);
  if (!normalizedChain || !normalizedSymbol) {
    return false;
  }
  return NATIVE_SYMBOLS_BY_CHAIN[normalizedChain]?.has(normalizedSymbol) ?? false;
}

function parsePositiveAmount(value: unknown) {
  const raw = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return raw;
}

function tryFixLegacyNativeTradeActivity(
  item: { user: User; activity: Activity },
  rawByKey: Map<string, RawPayloadRow>
) {
  const txAction = item.activity.metadata.txAction;
  if (txAction !== 'buy' && txAction !== 'sell') {
    return item;
  }

  const chain = normalize(item.activity.metadata.chain);
  const trackedAddress = normalize(item.activity.metadata.trackedAddress);
  const txHash = normalize(item.activity.metadata.txHash);
  if (!chain || !trackedAddress || !txHash) {
    return item;
  }

  const shownToken = item.activity.metadata.token;
  if (!isNativeSymbol(chain, shownToken)) {
    return item;
  }

  const raw = rawByKey.get(`${chain}|${trackedAddress}|${txHash}`);
  if (!raw) {
    return item;
  }

  const payload = parseJSON<Record<string, unknown>>(raw.payload_json, {});
  const rawSymbol = typeof payload.symbol === 'string' ? payload.symbol.trim() : '';
  if (!rawSymbol || isNativeSymbol(chain, rawSymbol)) {
    return item;
  }

  const rawAmount = parsePositiveAmount(payload.amount);
  if (!rawAmount) {
    return item;
  }

  const tokenAddress =
    typeof payload.tokenContractAddress === 'string'
      ? payload.tokenContractAddress.trim()
      : typeof payload.tokenAddress === 'string'
        ? payload.tokenAddress.trim()
        : '';
  const fromAddress = Array.isArray(payload.from)
    ? (payload.from[0] as { address?: string } | undefined)?.address?.trim() || item.activity.metadata.fromAddress
    : item.activity.metadata.fromAddress;
  const toAddress = Array.isArray(payload.to)
    ? (payload.to[0] as { address?: string } | undefined)?.address?.trim() || item.activity.metadata.toAddress
    : item.activity.metadata.toAddress;

  return {
    ...item,
    activity: {
      ...item.activity,
      metadata: {
        ...item.activity.metadata,
        token: rawSymbol,
        value: rawAmount,
        tokenAddress: tokenAddress || item.activity.metadata.tokenAddress,
        fromAddress,
        toAddress,
      },
    },
  };
}

function tryFixLegacyIncomingPoisonBuy(
  item: { user: User; activity: Activity },
  rawByKey: Map<string, RawPayloadRow>
) {
  if (item.activity.metadata.txAction !== 'buy') {
    return item;
  }

  const chain = normalize(item.activity.metadata.chain);
  const trackedAddress = normalize(item.activity.metadata.trackedAddress);
  const txHash = normalize(item.activity.metadata.txHash);
  if (!chain || !trackedAddress || !txHash) {
    return item;
  }

  const raw = rawByKey.get(`${chain}|${trackedAddress}|${txHash}`);
  if (!raw) {
    return item;
  }

  const payload = parseJSON<Record<string, unknown>>(raw.payload_json, {});
  const rawSymbol = typeof payload.symbol === 'string' ? payload.symbol.trim() : '';
  if (!rawSymbol || isNativeSymbol(chain, rawSymbol)) {
    return item;
  }

  const rawAmount = parsePositiveAmount(payload.amount);
  if (!rawAmount) {
    return item;
  }

  const fromAddress = Array.isArray(payload.from)
    ? (payload.from[0] as { address?: string } | undefined)?.address?.trim() || ''
    : '';
  const toAddress = Array.isArray(payload.to)
    ? (payload.to[0] as { address?: string } | undefined)?.address?.trim() || ''
    : '';
  const fromLower = normalize(fromAddress);
  const toLower = normalize(toAddress);

  // 典型投毒：外部地址 -> 被跟踪地址 的非原生 token 转入，却被旧逻辑标成 buy。
  if (!fromLower || !toLower || toLower !== trackedAddress || fromLower === trackedAddress) {
    return item;
  }

  const tokenAddress =
    typeof payload.tokenContractAddress === 'string'
      ? payload.tokenContractAddress.trim()
      : typeof payload.tokenAddress === 'string'
        ? payload.tokenAddress.trim()
        : '';

  const currentTitle = item.activity.title || item.activity.content;
  return {
    ...item,
    activity: {
      ...item.activity,
      title: currentTitle.replace('买入', '收到转账'),
      metadata: {
        ...item.activity.metadata,
        txAction: 'receive' as const,
        token: rawSymbol,
        value: rawAmount,
        tokenAddress: tokenAddress || item.activity.metadata.tokenAddress,
        fromAddress,
        toAddress,
        uncertainFrom: true,
      },
    },
  };
}

function buildActivityKey(item: { user: User; activity: Activity }, index: number) {
  const dedupKey = buildActivityScopedDedupKey(item.activity, item.user.id);
  if (dedupKey) {
    return dedupKey;
  }
  return `${item.user.id}|${item.activity.timestamp}|${item.activity.title || ''}|${item.activity.content}|${index}`;
}

export function replaceFeedSnapshot(feed: Array<{ user: User; activity: Activity }>) {
  const seenKeys = new Set<string>();
  const dedupedFeed: Array<{ item: typeof feed[number]; index: number }> = [];
  feed.forEach((item, index) => {
    const activityKey = buildActivityKey(item, index);
    if (seenKeys.has(activityKey)) {
      return;
    }
    seenKeys.add(activityKey);
    dedupedFeed.push({ item, index });
  });

  const scoredRows = scoreFeedRowsChronologically(
    dedupedFeed.map(({ item, index }) => ({
      user: item.user,
      activity: item.activity,
      stableId: buildActivityKey(item, index),
    }))
  );

  // 2026-09-03 事故：这里原本是「一个事务里 DELETE 全表 + 逐行插入」——83k 行 / 300MB JSON
  // 会把 WAL 写锁独占到几十分钟，饿死其它写进程（频道采集静默停摆的根因之一）。
  // 现在按块提交，单事务持锁时长有上界；代价是不再原子替换（重建窗口内读者可能看到部分行），
  // 生产调用方只以空 feed 走这条路径（syncService 的 empty snapshot）。
  const db = getDb();
  const now = Date.now();
  for (;;) {
    const deleted = withTransaction(
      () =>
        db
          .prepare(`DELETE FROM activity_feed WHERE rowid IN (SELECT rowid FROM activity_feed LIMIT ?)`)
          .run(SQLITE_WRITE_CHUNK_ROWS).changes
    );
    if (deleted < SQLITE_WRITE_CHUNK_ROWS) break;
  }

  forEachWriteChunk(scoredRows, (chunk) => {
    withTransaction(() => {
      const insertStmt = db.prepare(
        `INSERT INTO activity_feed (
          user_id,
          activity_key,
          timestamp,
          tx_hash_lower,
          chain,
          tracked_address_lower,
          source,
          type,
          user_json,
          activity_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const row of chunk) {
        const activityKey = row.stableId || row.activity.id;
        insertStmt.run(
          row.user.id,
          activityKey,
          row.activity.timestamp,
          normalize(row.activity.metadata.txHash) || null,
          normalize(row.activity.metadata.chain) || null,
          normalize(row.activity.metadata.trackedAddress) || null,
          row.activity.source,
          row.activity.type,
          JSON.stringify(row.user),
          JSON.stringify(row.activity),
          now
        );
      }
    });
  });

  upsertEventsFromFeedRows(scoredRows, 'feed-snapshot-replace');
}

export function upsertFeedSnapshot(feed: Array<{ user: User; activity: Activity }>) {
  if (feed.length === 0) {
    return;
  }

  // Group activities by dedup key and prioritize Telegram monitoring sources
  const activityGroups = new Map<string, Array<{ item: { user: User; activity: Activity }; index: number }>>();

  for (let index = 0; index < feed.length; index += 1) {
    const item = feed[index];
    const activityKey = buildActivityKey(item, index);

    if (!activityGroups.has(activityKey)) {
      activityGroups.set(activityKey, []);
    }
    activityGroups.get(activityKey)!.push({ item, index });
  }

  const dedupedFeedRows: Array<{ activityKey: string; item: { user: User; activity: Activity } }> = [];
  // For each group, select the highest priority activity
  for (const [activityKey, group] of activityGroups) {
    // Sort by priority: live/xxyy monitor prefixes first, then by timestamp desc
    const prioritized = group.sort((a, b) => {
      const aIsLive =
        a.item.activity.id.startsWith('xxyy-monitor:') ||
        a.item.activity.id.startsWith('live-monitor:');
      const bIsLive =
        b.item.activity.id.startsWith('xxyy-monitor:') ||
        b.item.activity.id.startsWith('live-monitor:');

      if (aIsLive && !bIsLive) return -1;
      if (!aIsLive && bIsLive) return 1;

      // Prefer live-monitor over xxyy when both present for same key (cutover)
      const aIsAlchemy = a.item.activity.id.startsWith('live-monitor:');
      const bIsAlchemy = b.item.activity.id.startsWith('live-monitor:');
      if (aIsAlchemy && !bIsAlchemy) return -1;
      if (!aIsAlchemy && bIsAlchemy) return 1;

      // If both are same source type, prefer newer timestamp
      return b.item.activity.timestamp - a.item.activity.timestamp;
    });

    const selectedActivity = prioritized[0];
    dedupedFeedRows.push({ activityKey, item: selectedActivity.item });
  }

  const scoredRows = scoreFeedRowsChronologically(
    dedupedFeedRows.map(({ activityKey, item }) => ({
      user: item.user,
      activity: item.activity,
      stableId: activityKey,
    }))
  );

  // 同 replaceFeedSnapshot：批量写按块提交，单事务持锁时长有上界（2026-09-03 事故）。
  const db = getDb();
  const now = Date.now();
  forEachWriteChunk(scoredRows, (chunk) => {
    withTransaction(() => {
      const insertStmt = db.prepare(
        `INSERT INTO activity_feed (
          user_id,
          activity_key,
          timestamp,
          tx_hash_lower,
          chain,
          tracked_address_lower,
          source,
          type,
          user_json,
          activity_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(activity_key)
        DO UPDATE SET
          timestamp = excluded.timestamp,
          tx_hash_lower = excluded.tx_hash_lower,
          chain = excluded.chain,
          tracked_address_lower = excluded.tracked_address_lower,
          source = excluded.source,
          type = excluded.type,
          user_json = excluded.user_json,
          activity_json = excluded.activity_json`
      );

      for (const row of chunk) {
        const activityKey = row.stableId || row.activity.id;
        insertStmt.run(
          row.user.id,
          activityKey,
          row.activity.timestamp,
          normalize(row.activity.metadata.txHash) || null,
          normalize(row.activity.metadata.chain) || null,
          normalize(row.activity.metadata.trackedAddress) || null,
          row.activity.source,
          row.activity.type,
          JSON.stringify(row.user),
          JSON.stringify(row.activity),
          now
        );
      }
    });
  });

  upsertEventsFromFeedRows(scoredRows, 'feed-snapshot-upsert');
}

function parseFeedRows(rows: FeedRow[]) {
  return rows
    .map((row) => {
      const user = parseJSON<User | null>(row.user_json, null);
      const activity = parseJSON<Activity | null>(row.activity_json, null);
      if (!user || !activity) {
        return null;
      }
      return { user, activity };
    })
    .filter((item): item is { user: User; activity: Activity } => Boolean(item));
}

export function deleteFeedSnapshotWindowForUsers(
  users: User[],
  beginMs: number,
  endMs: number
) {
  if (users.length === 0) {
    return;
  }

  withTransaction(() => {
    const db = getDb();
    const deleteStmt = db.prepare(
      `DELETE FROM activity_feed
       WHERE user_id = ?
         AND chain = ?
         AND tracked_address_lower = ?
         AND timestamp >= ?
         AND timestamp <= ?`
    );

    for (const user of users) {
      for (const address of user.addresses) {
        deleteStmt.run(
          user.id,
          normalize(address.chain),
          normalize(address.address),
          beginMs,
          endMs
        );
      }
    }
  });
}

export function countQualifiedActivitiesByUser(userId: string) {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    return 0;
  }

  const db = getDb();
  // Canonical feed store is `events` (activity_feed is legacy snapshot path).
  const row = db
    .prepare('SELECT COUNT(1) AS count FROM events WHERE user_id = ?')
    .get(normalizedUserId) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function getQualifiedActivityCountsByUser() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT user_id AS userId, COUNT(1) AS count
       FROM events
       GROUP BY user_id`
    )
    .all() as Array<{ userId: string; count: number }>;

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.userId] = row.count;
  }
  return counts;
}

export function upsertRawTransactions(records: RawTransactionSnapshot[]) {
  if (records.length === 0) {
    return;
  }

  withTransaction(() => {
    const db = getDb();
    const now = Date.now();

    const stmt = db.prepare(
      `INSERT INTO raw_transactions (
        chain,
        tracked_address,
        tracked_address_lower,
        tx_hash,
        tx_hash_lower,
        tx_time,
        payload_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chain, tracked_address_lower, tx_hash_lower)
      DO UPDATE SET
        tx_time = excluded.tx_time,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at`
    );

    for (const record of records) {
      const chain = normalize(record.chain);
      const address = typeof record.trackedAddress === 'string' ? record.trackedAddress.trim() : '';
      const addressLower = normalize(address);
      const txHash = typeof record.txHash === 'string' ? record.txHash.trim() : '';
      const txHashLower = normalize(txHash);
      if (!chain || !addressLower || !txHashLower) {
        continue;
      }

      stmt.run(
        chain,
        address,
        addressLower,
        txHash,
        txHashLower,
        record.txTime,
        JSON.stringify(record.payload),
        now,
        now
      );
    }
  });
}

export function upsertActivityJudgments(records: ActivityJudgmentSnapshot[]) {
  if (records.length === 0) {
    return;
  }

  withTransaction(() => {
    const db = getDb();
    const now = Date.now();

    const stmt = db.prepare(
      `INSERT INTO activity_judgments (
        chain,
        tracked_address,
        tracked_address_lower,
        tx_hash,
        tx_hash_lower,
        tx_time,
        tx_action,
        token,
        value,
        token_address,
        quote_token,
        quote_amount,
        from_address,
        to_address,
        uncertain_from,
        decision,
        reason_code,
        reason_text,
        computed_usd_value,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chain, tracked_address_lower, tx_hash_lower)
      DO UPDATE SET
        tx_time = excluded.tx_time,
        tx_action = excluded.tx_action,
        token = excluded.token,
        value = excluded.value,
        token_address = excluded.token_address,
        quote_token = excluded.quote_token,
        quote_amount = excluded.quote_amount,
        from_address = excluded.from_address,
        to_address = excluded.to_address,
        uncertain_from = excluded.uncertain_from,
        decision = excluded.decision,
        reason_code = excluded.reason_code,
        reason_text = excluded.reason_text,
        computed_usd_value = excluded.computed_usd_value,
        updated_at = excluded.updated_at`
    );

    for (const record of records) {
      const chain = normalize(record.chain);
      const address = typeof record.trackedAddress === 'string' ? record.trackedAddress.trim() : '';
      const addressLower = normalize(address);
      const txHash = typeof record.txHash === 'string' ? record.txHash.trim() : '';
      const txHashLower = normalize(txHash);
      if (!chain || !addressLower || !txHashLower) {
        continue;
      }

      stmt.run(
        chain,
        address,
        addressLower,
        txHash,
        txHashLower,
        record.txTime ?? null,
        record.txAction,
        record.token ?? null,
        record.value ?? null,
        record.tokenAddress ?? null,
        record.quoteToken ?? null,
        record.quoteAmount ?? null,
        record.fromAddress ?? null,
        record.toAddress ?? null,
        record.uncertainFrom ? 1 : 0,
        record.decision,
        record.reasonCode,
        record.reasonText,
        typeof record.computedUsdValue === 'number' ? record.computedUsdValue : null,
        now
      );
    }
  });
}

export function clearParserArtifactSnapshots() {
  withTransaction(() => {
    const db = getDb();
    db.prepare('DELETE FROM raw_transactions').run();
    db.prepare('DELETE FROM activity_judgments').run();
  });
}

export function saveLastSuccessfulSnapshotState(state: FeedSnapshotState) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO app_state (key, value_json, updated_at)
     VALUES ('last_success_snapshot', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(JSON.stringify(state), now);
}

export function saveLastFailureState(payload: { error: string; failedAt: number; runId: number }) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO app_state (key, value_json, updated_at)
     VALUES ('last_failed_sync', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(JSON.stringify(payload), now);
}

export function readLastSuccessfulSnapshotState() {
  const db = getDb();
  const row = db
    .prepare('SELECT value_json FROM app_state WHERE key = ? LIMIT 1')
    .get('last_success_snapshot') as { value_json: string } | undefined;

  if (!row) {
    return null;
  }

  return parseJSON<FeedSnapshotState | null>(row.value_json, null);
}

export function readLastFailedSyncState() {
  const db = getDb();
  const row = db
    .prepare('SELECT value_json FROM app_state WHERE key = ? LIMIT 1')
    .get('last_failed_sync') as { value_json: string } | undefined;

  if (!row) {
    return null;
  }

  return parseJSON<{ error: string; failedAt: number; runId: number } | null>(row.value_json, null);
}

export function readFeedBackfillWindowState() {
  const db = getDb();
  const row = db
    .prepare('SELECT value_json FROM app_state WHERE key = ? LIMIT 1')
    .get(FEED_BACKFILL_WINDOW_STATE_KEY) as { value_json: string } | undefined;

  if (!row) {
    return null;
  }

  return normalizeWindowState(parseJSON<FeedBackfillWindowState | null>(row.value_json, null));
}

export function saveFeedBackfillWindowState(state: FeedBackfillWindowState) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO app_state (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(FEED_BACKFILL_WINDOW_STATE_KEY, JSON.stringify(normalizeWindowState(state)), now);
}
