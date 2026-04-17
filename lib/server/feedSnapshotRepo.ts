import 'server-only';

import { type Activity, type User } from '@/types';
import { getDb, withTransaction } from '@/lib/server/sqlite';

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
  txAction: 'buy' | 'sell' | 'send' | 'receive';
  token?: string;
  value?: string;
  tokenAddress?: string;
  fromAddress?: string;
  toAddress?: string;
  uncertainFrom: boolean;
}

interface FeedRow {
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

// Environment variable to temporarily disable poison filtering for debugging
const DISABLE_POISON_FILTER = process.env.DISABLE_POISON_FILTER === 'true';

if (DISABLE_POISON_FILTER) {
  console.warn('[feedSnapshotRepo] ⚠️ Poison filtering is DISABLED via DISABLE_POISON_FILTER environment variable');
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
  const txHash = normalize(item.activity.metadata.txHash);
  const trackedAddress = normalize(item.activity.metadata.trackedAddress);
  if (txHash) {
    return `${item.user.id}|${trackedAddress}|${txHash}`;
  }
  return `${item.user.id}|${item.activity.timestamp}|${item.activity.title || ''}|${item.activity.content}|${index}`;
}

export function replaceFeedSnapshot(feed: Array<{ user: User; activity: Activity }>) {
  withTransaction(() => {
    const db = getDb();
    const now = Date.now();
    db.prepare('DELETE FROM activity_feed').run();

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

    for (const { item, index } of dedupedFeed) {
      const activityKey = buildActivityKey(item, index);
      insertStmt.run(
        item.user.id,
        activityKey,
        item.activity.timestamp,
        normalize(item.activity.metadata.txHash) || null,
        normalize(item.activity.metadata.chain) || null,
        normalize(item.activity.metadata.trackedAddress) || null,
        item.activity.source,
        item.activity.type,
        JSON.stringify(item.user),
        JSON.stringify(item.activity),
        now
      );
    }
  });
}

export function upsertFeedSnapshot(feed: Array<{ user: User; activity: Activity }>) {
  if (feed.length === 0) {
    return;
  }

  withTransaction(() => {
    const db = getDb();
    const now = Date.now();

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

    const seenKeys = new Set<string>();
    for (let index = 0; index < feed.length; index += 1) {
      const item = feed[index];
      const activityKey = buildActivityKey(item, index);
      if (seenKeys.has(activityKey)) {
        continue;
      }
      seenKeys.add(activityKey);

      insertStmt.run(
        item.user.id,
        activityKey,
        item.activity.timestamp,
        normalize(item.activity.metadata.txHash) || null,
        normalize(item.activity.metadata.chain) || null,
        normalize(item.activity.metadata.trackedAddress) || null,
        item.activity.source,
        item.activity.type,
        JSON.stringify(item.user),
        JSON.stringify(item.activity),
        now
      );
    }
  });
}

export function readFeedSnapshot(limit: number, offset: number, userId?: string | null) {
  const safeLimit = Math.max(1, Math.min(50000, limit));
  const safeOffset = Math.max(0, offset);
  const normalizedUserId = typeof userId === 'string' ? userId.trim() : '';
  const hasUserFilter = normalizedUserId.length > 0;

  const db = getDb();
  const rows = hasUserFilter
    ? (db
        .prepare(
          `SELECT user_json, activity_json, timestamp
           FROM activity_feed
           WHERE user_id = ?
           ORDER BY timestamp DESC, id DESC
           LIMIT ? OFFSET ?`
        )
        .all(normalizedUserId, safeLimit, safeOffset) as FeedRow[])
    : (db
        .prepare(
          `SELECT user_json, activity_json, timestamp
           FROM activity_feed
           ORDER BY timestamp DESC, id DESC
           LIMIT ? OFFSET ?`
        )
        .all(safeLimit, safeOffset) as FeedRow[]);

  const totalRow = hasUserFilter
    ? (db
        .prepare('SELECT COUNT(1) AS count FROM activity_feed WHERE user_id = ?')
        .get(normalizedUserId) as { count: number })
    : (db.prepare('SELECT COUNT(1) AS count FROM activity_feed').get() as { count: number });

  const feed = rows
    .map((row) => {
      const user = parseJSON<User | null>(row.user_json, null);
      const activity = parseJSON<Activity | null>(row.activity_json, null);
      if (!user || !activity) {
        return null;
      }
      return { user, activity };
    })
    .filter((item): item is { user: User; activity: Activity } => Boolean(item));

  const fixCandidates = feed.filter((item) => {
    const action = item.activity.metadata.txAction;
    if (action !== 'buy' && action !== 'sell') {
      return false;
    }
    return true;
  });

  if (fixCandidates.length > 0) {
    const fetchRawStmt = db.prepare(
      `SELECT chain, tracked_address_lower, tx_hash_lower, payload_json
       FROM raw_transactions
       WHERE chain = ? AND tracked_address_lower = ? AND tx_hash_lower = ?
       LIMIT 1`
    );
    const rawByKey = new Map<string, RawPayloadRow>();
    for (const item of fixCandidates) {
      const chain = normalize(item.activity.metadata.chain);
      const tracked = normalize(item.activity.metadata.trackedAddress);
      const txHash = normalize(item.activity.metadata.txHash);
      if (!chain || !tracked || !txHash) {
        continue;
      }
      const key = `${chain}|${tracked}|${txHash}`;
      if (rawByKey.has(key)) {
        continue;
      }
      const raw = fetchRawStmt.get(chain, tracked, txHash) as RawPayloadRow | undefined;
      if (raw) {
        rawByKey.set(key, raw);
      }
    }

    if (rawByKey.size > 0) {
      for (let i = 0; i < feed.length; i += 1) {
        const nativeFixed = tryFixLegacyNativeTradeActivity(feed[i], rawByKey);
        feed[i] = tryFixLegacyIncomingPoisonBuy(nativeFixed, rawByKey);
      }
    }
  }

  const senderFanOutStats = new Map<
    string,
    {
      transferCount: number;
      recipientAddresses: Set<string>;
    }
  >();

  for (const item of feed) {
    const action = item.activity.metadata.txAction;
    if (action !== 'receive') {
      continue;
    }
    if (!item.activity.metadata.uncertainFrom) {
      continue;
    }
    const chain = normalize(item.activity.metadata.chain);
    const fromAddress = normalize(item.activity.metadata.fromAddress);
    const toAddress = normalize(item.activity.metadata.toAddress) || normalize(item.activity.metadata.trackedAddress);
    if (!chain || !fromAddress || !toAddress) {
      continue;
    }
    const key = `${chain}|${fromAddress}`;
    const existing = senderFanOutStats.get(key) ?? {
      transferCount: 0,
      recipientAddresses: new Set<string>(),
    };
    existing.transferCount += 1;
    existing.recipientAddresses.add(toAddress);
    senderFanOutStats.set(key, existing);
  }

  const suspiciousSenderKeys = new Set(
    Array.from(senderFanOutStats.entries())
      .filter(
        ([, value]) =>
          value.transferCount >= SNAPSHOT_POISON_SENDER_FANOUT_MIN_TRANSFERS &&
          value.recipientAddresses.size >= SNAPSHOT_POISON_SENDER_FANOUT_MIN_RECIPIENTS
      )
      .map(([key]) => key)
  );

  const filteredFeed =
    DISABLE_POISON_FILTER || suspiciousSenderKeys.size === 0
      ? feed
      : feed.filter((item) => {
          const action = item.activity.metadata.txAction;
          if (action !== 'receive') {
            return true;
          }
          if (!item.activity.metadata.uncertainFrom) {
            return true;
          }
          const chain = normalize(item.activity.metadata.chain);
          const fromAddress = normalize(item.activity.metadata.fromAddress);
          if (!chain || !fromAddress) {
            return true;
          }
          return !suspiciousSenderKeys.has(`${chain}|${fromAddress}`);
        });

  // Debug logging for poison filtering
  if (suspiciousSenderKeys.size > 0 && !DISABLE_POISON_FILTER) {
    console.log('[readFeedSnapshot] Poison filtering stats:', {
      feedBeforeFilter: feed.length,
      suspiciousSendersCount: suspiciousSenderKeys.size,
      feedAfterFilter: filteredFeed.length,
      filteredCount: feed.length - filteredFeed.length,
      sampleSuspiciousSenders: Array.from(suspiciousSenderKeys).slice(0, 3),
    });
  } else if (DISABLE_POISON_FILTER && suspiciousSenderKeys.size > 0) {
    console.log('[readFeedSnapshot] Poison filtering skipped (DISABLE_POISON_FILTER=true). Would have filtered:', {
      suspiciousSendersCount: suspiciousSenderKeys.size,
      sampleSuspiciousSenders: Array.from(suspiciousSenderKeys).slice(0, 3),
    });
  }

  return {
    feed: filteredFeed,
    total: totalRow.count,
  };
}

export function readLatestActivityAtByUser() {
  // 与前端列表保持同一口径：使用 readFeedSnapshot 的过滤后结果计算“最近活跃”。
  const snapshot = readFeedSnapshot(50000, 0, null);
  const latestByUser: Record<string, number> = {};
  for (const item of snapshot.feed) {
    const userId = item.user.id;
    if (!userId) continue;
    const ts = item.activity.timestamp;
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const current = latestByUser[userId] ?? 0;
    if (ts > current) {
      latestByUser[userId] = ts;
    }
  }
  return latestByUser;
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
        record.txAction,
        record.token ?? null,
        record.value ?? null,
        record.tokenAddress ?? null,
        record.fromAddress ?? null,
        record.toAddress ?? null,
        record.uncertainFrom ? 1 : 0,
        now
      );
    }
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

  return parseJSON<FeedBackfillWindowState | null>(row.value_json, null);
}

export function saveFeedBackfillWindowState(state: FeedBackfillWindowState) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO app_state (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(FEED_BACKFILL_WINDOW_STATE_KEY, JSON.stringify(state), now);
}
