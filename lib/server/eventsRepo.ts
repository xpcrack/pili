import 'server-only';

import { createHash } from 'node:crypto';

import { type Activity, type User } from '@/types';
import { getBlockchainActivityIdentity } from '@/lib/activityIdentity';
import { buildTradeDisplayMetadata, TRADE_ACTION_LABEL_VALUES } from '@/lib/tradeDisplay';
import {
  chooseConflictWinner,
  detectConflictDomain,
  diffActivityForConflict,
  type ConflictFieldDiff,
} from '@/lib/server/sourceReconciliation';
import { scoreFeedRowsAgainstDatabase } from '@/lib/server/activityImportanceService';
import { triggerBidFeedPush } from '@/lib/server/bidFeedPushNotifier';
import { repairCollapsedCanonicalActivitySync } from '@/lib/server/telegramMonitorActivity';
import { upsertConflictAndEnqueue } from '@/lib/server/conflictRepo';
import { flushConflictNotifications } from '@/lib/server/conflictNotifier';
import { getPrimaryPoolOfficialTwitterMap } from '@/lib/server/primaryPoolSymbols';
import {
  buildTelegramMonitorTxStateLookupKey,
  listTelegramMonitorTxStatesByKeys,
  setTelegramMonitorTxStateCanonicalActivity,
  type TelegramMonitorTxState,
} from '@/lib/server/telegramMonitorTxStateRepo';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import {
  SQLITE_WRITE_CHUNK_ROWS,
  forEachWriteChunk,
  getDb,
  withTransaction,
} from '@/lib/server/sqlite';
import { bumpFeedRevision } from '@/lib/server/feedRevision';

export { readFeedRevision as readEventsRevision } from '@/lib/server/feedRevision';

export interface EventFeedQuery {
  limit: number;
  cursor?: string | null;
  q?: string | null;
  source?: string | null;
  userId?: string | null;
  chain?: string | null;
  fromMs?: number | null;
  toMs?: number | null;
  /** When true (default), hide users with monitoring_enabled=0 unless userId/q pin a history view. */
  monitoredOnly?: boolean;
  /** When false, skip COUNT query (for poll mode where total precision isn't needed). */
  includeTotal?: boolean;
  /**
   * CA 搜索扩展：把「正文只提 ticker 没贴 CA」的推文也算命中
   * （twitter_tweet_token_mentions.token_address_lower = q 且 match_source='ticker'）。
   * official_twitter/both 的推文归 expandOfficialTweets / FTS 自身。
   */
  expandTicker?: boolean;
  /**
   * CA 搜索扩展：把「官推相关」的推文也算命中 —— ①正文 @ 官推 handle 的推
   * （mentions.match_source='official_twitter'）②官推自己发的推
   * （twitter_tweets.author_handle = 官推 handle，来自 newone tokens.twitter_url）。
   * 官推 handle 集合由 q（CA）反查 primary-pool officialTwitterByHandle 得到。
   */
  expandOfficialTweets?: boolean;
}

const TRADE_ACTION_KEYWORDS = new Set<string>(TRADE_ACTION_LABEL_VALUES);

/**
 * FTS 搜索的排序时间窗（天）：命中行超窗就不再参与「最近优先」排序与返回。
 * 背景：FTS 驱动路径的 ORDER BY 是 TEMP B-TREE，成本随命中数线性涨；
 * 哈基米(506) 0.08s / pow(8.7k) 0.85s / sol(3.7万) 2.6s，更热词（单字母前缀、$the）
 * 命中可上 10 万+，不设窗会重新逼近超时。搜索命中超 50 条只看最近 N 天是 Finn 的拍板。
 * 窗外的历史命中仍然存在，只是不进搜索结果（等价于把搜索当作「最近 N 天内检索」）。
 */
const FTS_SEARCH_TIME_WINDOW_DAYS = 30;

/**
 * 触发时间窗的命中数阈值：≤ 此数全史排序（老 CA 可搜），> 此数只排窗内。
 * Finn 拍板的「命中结果超 50 条就只排最近 N 天」。
 */
const FTS_SEARCH_WINDOW_HIT_THRESHOLD = 50;

export interface EventFeedRow {
  user: User;
  activity: Activity;
  cursor: string;
}

function normalize(value: string | undefined | null) {
  return (value || '').trim().toLowerCase();
}

function encodeCursor(timestamp: number, eventId: string) {
  return Buffer.from(`${timestamp}|${eventId}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | null | undefined): { timestamp: number; eventId: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const [rawTs, ...rest] = decoded.split('|');
    const ts = Number.parseInt(rawTs || '', 10);
    const eventId = rest.join('|');
    if (!Number.isFinite(ts) || !eventId) return null;
    return { timestamp: ts, eventId };
  } catch {
    return null;
  }
}

function buildBlockchainEventId(activity: Activity) {
  const monitorAggregateKey = (activity.metadata.monitorTxAggregateKey || '').trim();
  if (monitorAggregateKey) {
    return monitorAggregateKey;
  }

  const identity = getBlockchainActivityIdentity(activity);
  if (!identity) {
    return null;
  }

  if (!identity.signatureSeed) {
    return identity.scopedBaseKey;
  }

  const signature = createHash('sha1')
    .update(identity.signatureSeed)
    .digest('hex')
    .slice(0, 12);

  return `${identity.scopedBaseKey}:${signature}`;
}

function buildEventId(user: User, activity: Activity) {
  const tweetId = (activity.metadata.tweetId || '').trim();
  if (tweetId) {
    return `twitter:${tweetId}`;
  }

  const blockchainEventId = buildBlockchainEventId(activity);
  if (blockchainEventId) {
    return blockchainEventId;
  }

  return `${user.id}:${activity.id}`;
}

function extractUrl(activity: Activity) {
  return activity.metadata.tweetUrl || activity.metadata.telegramPostUrl || null;
}

function parseQueryTerms(q: string) {
  const terms = q
    .trim()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 8);

  if (terms.length === 0) return null;
  return terms
    .map((term) => `"${term.replace(/"/g, '""')}"*`)
    .join(' AND ');
}

function parseJson<T>(value: string | null | undefined) {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function mergeCurrentUserSnapshot(
  user: User,
  currentUsersById: Map<string, User>,
  preferredUserId?: string | null
) {
  // user_id 列是归属权威；user_json 可能落后（fomo 频道帖归属回填只更了列，漏了 JSON）。
  return (
    (preferredUserId ? currentUsersById.get(preferredUserId) : undefined) ??
    currentUsersById.get(user.id) ??
    user
  );
}

function pickDisplaySeed(...values: Array<string | null | undefined>) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function isTelegramMonitorActivity(activity: Activity, ingestSource: string) {
  if (ingestSource.startsWith('telegram-monitor') || ingestSource.startsWith('live-monitor')) {
    return true;
  }

  if (activity.id.startsWith('xxyy-monitor:') || activity.id.startsWith('live-monitor:')) {
    return true;
  }

  return Boolean(
    activity.metadata.rawText &&
      (
        activity.metadata.monitorWalletLabel ||
        activity.metadata.monitorWalletAliasLabel ||
        activity.metadata.monitorWalletGroupLabel
      )
  );
}

function buildTelegramMonitorLogicalTxKey(activity: Activity) {
  if (!isTelegramMonitorActivity(activity, 'telegram-monitor')) {
    return null;
  }

  return buildTelegramMonitorTxStateLookupKey(
    activity.metadata.chain,
    activity.metadata.trackedAddress,
    activity.metadata.txHash,
    activity.metadata.tokenAddress
  );
}

/**
 * Once live-monitor owns a wallet+tx, telegram/xxyy rows for the same key are shadows
 * (same-token dups or counter-flow wrong-token legs). Prefer live as authority.
 */
const LIVE_MONITOR_OWNS_WALLET_TX_SQL = `SELECT 1 AS ok
       FROM events
       WHERE user_id = ?
         AND source = 'blockchain'
         AND chain = ?
         -- LOWER(address) matches the expression in
         -- idx_events_blockchain_chain_address_lower_timestamp; plain
         -- address=? would skip the third index column and force a scan of
         -- every blockchain/chain row (5s per XXYY message during backlog).
         AND LOWER(address) = ?
         AND LOWER(COALESCE(tx_hash, '')) = ?
         AND (
           ingest_source LIKE 'live-monitor%'
           OR event_id LIKE 'live-monitor:%'
         )
       LIMIT 1`;

let liveMonitorOwnsWalletTxStmt: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;

function getLiveMonitorOwnsWalletTxStmt() {
  if (!liveMonitorOwnsWalletTxStmt) {
    liveMonitorOwnsWalletTxStmt = getDb().prepare(LIVE_MONITOR_OWNS_WALLET_TX_SQL);
  }
  return liveMonitorOwnsWalletTxStmt;
}

export function liveMonitorOwnsWalletTx(params: {
  userId: string;
  chain: string | null | undefined;
  trackedAddress: string | null | undefined;
  txHash: string | null | undefined;
}): boolean {
  const userId = (params.userId || '').trim();
  const chain = normalize(params.chain);
  const address = normalize(params.trackedAddress);
  const txHash = normalize(params.txHash);
  if (!userId || !chain || !address || !txHash) {
    return false;
  }

  const row = getLiveMonitorOwnsWalletTxStmt().get(userId, chain, address, txHash) as
    | { ok: number }
    | undefined;

  return Boolean(row);
}

function isTelegramMonitorIngestSource(ingestSource: string) {
  return ingestSource.startsWith('telegram-monitor');
}

function repairMonitorEventActivity(
  user: User,
  activity: Activity,
  monitorStatesByLogicalKey: Map<string, TelegramMonitorTxState>
) {
  const monitorLogicalKey = buildTelegramMonitorLogicalTxKey(activity);
  if (!monitorLogicalKey) {
    return activity;
  }

  const state = monitorStatesByLogicalKey.get(monitorLogicalKey);
  if (!state) {
    return activity;
  }

  const repaired = repairCollapsedCanonicalActivitySync({
    user,
    state,
    canonicalActivity: activity,
  });
  persistHealedTelegramMonitorActivity({
    user,
    originalActivity: activity,
    healedActivity: repaired,
  });
  return repaired;
}

function areActivitiesEquivalent(left: Activity, right: Activity) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function persistHealedTelegramMonitorActivity(params: {
  user: User;
  originalActivity: Activity;
  healedActivity: Activity;
}) {
  if (areActivitiesEquivalent(params.originalActivity, params.healedActivity)) {
    return false;
  }

  const chain = (params.healedActivity.metadata.chain || '').trim();
  const trackedWalletAddress = (params.healedActivity.metadata.trackedAddress || '').trim();
  const txHash = (params.healedActivity.metadata.txHash || '').trim();
  if (chain && trackedWalletAddress && txHash) {
    setTelegramMonitorTxStateCanonicalActivity({
      chain,
      trackedWalletAddress,
      txHash,
      tokenAddress: params.healedActivity.metadata.tokenAddress || null,
      activity: params.healedActivity,
    });
  }

  upsertEventsFromFeedRows(
    [{ user: params.user, activity: params.healedActivity }],
    'telegram-monitor-storage-heal'
  );
  return true;
}

/**
 * Minimal provisional writer for the latency-sensitive XXYY doorbell path.
 *
 * The normal upsert performs historical importance scans, logical rekeying,
 * conflict detection, and raw-payload joins. Those are appropriate for
 * canonical/reconciliation writes, but they turn a burst of complete XXYY
 * messages into a serial SQLite write queue. The raw XXYY audit row and the
 * later live-monitor canonical write remain the authorities for those jobs.
 */
export function upsertTelegramMonitorProvisionalEventFast(params: {
  user: User;
  activity: Activity;
  ingestSource?: string;
}) {
  const ingestSource = params.ingestSource || 'telegram-monitor-ingest';
  const activity = params.activity;
  if (
    liveMonitorOwnsWalletTx({
      userId: params.user.id,
      chain: activity.metadata.chain,
      trackedAddress: activity.metadata.trackedAddress,
      txHash: activity.metadata.txHash,
    })
  ) {
    return {
      upserted: false,
      skipped: 'live-monitor-owns-wallet-tx' as const,
      eventId: buildEventId(params.user, activity),
    };
  }

  const db = getDb();
  const eventId = buildEventId(params.user, activity);
  const chain = normalize(activity.metadata.chain) || null;
  const address =
    normalize(activity.metadata.trackedAddress) ||
    normalize(activity.metadata.fromAddress) ||
    normalize(activity.metadata.toAddress) ||
    null;
  const action = (activity.metadata.txAction || activity.metadata.tweetKind || null) as string | null;
  const now = Date.now();
  const originalPayload = buildFallbackOriginalPayload(activity, ingestSource);

  withTransaction(() => {
    db.prepare(
      `INSERT INTO events (
         event_id, source, kind, timestamp, user_id, user_name,
         chain, address, content, url, action, token, tweet_id, tx_hash,
         ingest_source, dedup_key, metadata_json, payload_json,
         user_json, activity_json, indexed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         source = excluded.source,
         kind = excluded.kind,
         timestamp = excluded.timestamp,
         user_id = excluded.user_id,
         user_name = excluded.user_name,
         chain = excluded.chain,
         address = excluded.address,
         content = excluded.content,
         url = excluded.url,
         action = excluded.action,
         token = excluded.token,
         tx_hash = excluded.tx_hash,
         ingest_source = excluded.ingest_source,
         dedup_key = excluded.dedup_key,
         metadata_json = excluded.metadata_json,
         payload_json = excluded.payload_json,
         user_json = excluded.user_json,
         activity_json = excluded.activity_json,
         indexed_at = excluded.indexed_at,
         updated_at = excluded.updated_at`
    ).run(
      eventId,
      activity.source,
      activity.type,
      activity.timestamp,
      params.user.id,
      params.user.name,
      chain,
      address,
      activity.content,
      extractUrl(activity),
      action,
      activity.metadata.token || null,
      activity.metadata.tweetId || null,
      activity.metadata.txHash || null,
      ingestSource,
      eventId,
      JSON.stringify(activity.metadata || {}),
      JSON.stringify(originalPayload),
      JSON.stringify(params.user),
      JSON.stringify(activity),
      now,
      now,
      now
    );
  });

  bumpFeedRevision();
  if (ingestSource === 'telegram-monitor-ingest') {
    triggerBidFeedPush([{ user: params.user, activity }]);
  }
  return { upserted: true, skipped: null, eventId };
}

function buildTelegramMonitorRepairLookup(activity: Activity) {
  const lookupKey = buildTelegramMonitorLogicalTxKey(activity);
  if (!lookupKey) {
    return null;
  }
  const chain = (activity.metadata.chain || '').trim();
  const trackedWalletAddress = (activity.metadata.trackedAddress || '').trim();
  const txHash = (activity.metadata.txHash || '').trim();

  return {
    lookupKey,
    chain,
    trackedWalletAddress,
    txHash,
    tokenAddress: (activity.metadata.tokenAddress || '').trim() || null,
  };
}

function repairTelegramMonitorFeedRows(rows: EventFeedRow[]) {
  const repairable = rows
    .map((row) => {
      const lookup = buildTelegramMonitorRepairLookup(row.activity);
      return lookup
        ? {
            row,
            lookup,
          }
        : null;
    })
    .filter(
      (
        candidate
      ): candidate is {
        row: EventFeedRow;
        lookup: {
          lookupKey: string;
          chain: string;
          trackedWalletAddress: string;
          txHash: string;
          tokenAddress: string | null;
        };
      } => Boolean(candidate)
    );

  if (repairable.length === 0) {
    return;
  }

  const statesByKey = listTelegramMonitorTxStatesByKeys(
    repairable.map((candidate) => ({
      chain: candidate.lookup.chain,
      trackedWalletAddress: candidate.lookup.trackedWalletAddress,
      txHash: candidate.lookup.txHash,
      tokenAddress: candidate.lookup.tokenAddress,
    }))
  );

  for (const candidate of repairable) {
    const state = statesByKey.get(candidate.lookup.lookupKey);
    if (!state) {
      continue;
    }

    candidate.row.activity = repairCollapsedCanonicalActivitySync({
      user: candidate.row.user,
      state,
      canonicalActivity: candidate.row.activity,
    });
  }
}

function buildFallbackOriginalPayload(activity: Activity, ingestSource: string) {
  return {
    schemaVersion: 1,
    ingestSource,
    originalType: 'event-fallback',
    rawText: activity.metadata.rawText || activity.content || null,
    activity: {
      id: activity.id,
      source: activity.source,
      type: activity.type,
      title: activity.title || null,
      content: activity.content,
      timestamp: activity.timestamp,
      metadata: activity.metadata,
    },
  };
}

function mergeActivityForUpsert(user: User, incoming: Activity, existing: Activity | null) {
  if (!existing) {
    return incoming;
  }

  const prefersCanonicalMonitorDisplay =
    incoming.metadata.monitorReconciledSource === 'okx-address' ||
    incoming.metadata.monitorReconciledSource === 'okx-detail' ||
    existing.metadata.monitorReconciledSource === 'okx-address' ||
    existing.metadata.monitorReconciledSource === 'okx-detail';
  const prefersAggregatedMonitorDisplay =
    !incoming.metadata.rawText &&
    incoming.metadata.monitorReconciledSource === 'xxyy' &&
    isExpectedMonitorAggregateCorrection(existing, incoming);
  // 展示种子只由本次写入自带的推送文案驱动。canonical 链上写入(live-monitor/
  // OKX 对账)没有自己的 rawText 时,不得让历史推送文案(可能是拆单单腿,
  // 金额/MC 低估数倍)解析出的展示文案覆盖结构化成交数据。
  const incomingRawText = pickDisplaySeed(incoming.metadata.rawText);
  const mergedRawText = prefersAggregatedMonitorDisplay
    ? incomingRawText
    : incomingRawText ?? pickDisplaySeed(existing.metadata.rawText);
  const displayRawText =
    prefersCanonicalMonitorDisplay || prefersAggregatedMonitorDisplay ? undefined : incomingRawText;

  const mergedMetadata: Activity['metadata'] = {
    ...existing.metadata,
    ...incoming.metadata,
  };

  const displayMetadata = buildTradeDisplayMetadata({
    rawText: displayRawText,
    walletLabel: pickDisplaySeed(
      incoming.metadata.monitorWalletAliasLabel,
      incoming.metadata.monitorWalletLabel,
      existing.metadata.monitorWalletAliasLabel,
      existing.metadata.monitorWalletLabel
    ),
    fallbackWalletLabel: pickDisplaySeed(
      incoming.metadata.displayWalletLabel,
      existing.metadata.displayWalletLabel,
      user.name
    ),
    actionVariant: pickDisplaySeed(incoming.metadata.txActionVariant, existing.metadata.txActionVariant),
    txActionLabel: pickDisplaySeed(incoming.metadata.txActionLabel, existing.metadata.txActionLabel),
    quoteAmount: pickDisplaySeed(incoming.metadata.quoteAmount, existing.metadata.quoteAmount),
    quoteToken: pickDisplaySeed(incoming.metadata.quoteToken, existing.metadata.quoteToken),
    value: pickDisplaySeed(incoming.metadata.value, existing.metadata.value),
    tokenSymbol: pickDisplaySeed(incoming.metadata.token, existing.metadata.token),
    marketCapText: pickDisplaySeed(
      incoming.metadata.displayMarketCapText,
      existing.metadata.displayMarketCapText
    ),
    marketCapUsd: incoming.metadata.marketCapAtTxUsd ?? existing.metadata.marketCapAtTxUsd ?? null,
    tokenAddress: pickDisplaySeed(
      incoming.metadata.displayTokenAvatarTokenAddress,
      incoming.metadata.tokenAddress,
      existing.metadata.displayTokenAvatarTokenAddress,
      existing.metadata.tokenAddress
    ),
  });

  return {
    ...incoming,
    metadata: {
      ...mergedMetadata,
      rawText: mergedRawText,
      tradeAmountUsdAtTx: incoming.metadata.tradeAmountUsdAtTx ?? existing.metadata.tradeAmountUsdAtTx,
      marketCapAtTxUsd: incoming.metadata.marketCapAtTxUsd ?? existing.metadata.marketCapAtTxUsd,
      marketCapAtTxSource: incoming.metadata.marketCapAtTxSource ?? existing.metadata.marketCapAtTxSource,
      marketCapAtTxEstimated: incoming.metadata.marketCapAtTxEstimated ?? existing.metadata.marketCapAtTxEstimated,
      ...displayMetadata,
    },
  } satisfies Activity;
}

function buildConflictKey(domain: string, eventKey: string, diff: ConflictFieldDiff[]) {
  const diffSignatureBase = diff
    .map((item) => `${item.field}:${item.left}->${item.right}`)
    .join('|');
  const diffSignature = createHash('sha1')
    .update(diffSignatureBase)
    .digest('hex')
    .slice(0, 16);
  return `${domain}:${eventKey}:${diffSignature}`;
}

function isExpectedMonitorAggregateCorrection(existing: Activity, incoming: Activity) {
  const existingKey = (existing.metadata.monitorTxAggregateKey || '').trim();
  const incomingKey = (incoming.metadata.monitorTxAggregateKey || '').trim();
  if (existingKey && incomingKey && existingKey === incomingKey) {
    return true;
  }

  const existingLogicalKey = buildTelegramMonitorLogicalTxKey(existing);
  const incomingLogicalKey = buildTelegramMonitorLogicalTxKey(incoming);
  return Boolean(existingLogicalKey && incomingLogicalKey && existingLogicalKey === incomingLogicalKey);
}

export function upsertEventsFromFeedRows(rows: Array<{ user: User; activity: Activity }>, ingestSource: string) {
  if (rows.length === 0) return;
  // 分批提交：单事务覆盖全量 feed（syncService 走的是整份 feed，数万行）会把 WAL 写锁
  // 独占到几十分钟（2026-09-03 频道采集静默停摆的根因）。分块后单事务持锁有上界；
  // 元素引用不变，调用方数组的 in-place 同步语义保持。
  if (rows.length > SQLITE_WRITE_CHUNK_ROWS) {
    forEachWriteChunk(rows, (chunk) => upsertEventsFromFeedRows([...chunk], ingestSource));
    return;
  }

  // Live-monitor already owns this wallet+tx → drop telegram/xxyy shadows (dups + counter-flow).
  let candidateRows = rows;
  if (isTelegramMonitorIngestSource(ingestSource)) {
    candidateRows = rows.filter((row) => {
      const owned = liveMonitorOwnsWalletTx({
        userId: row.user.id,
        chain: row.activity.metadata.chain,
        trackedAddress: row.activity.metadata.trackedAddress,
        txHash: row.activity.metadata.txHash,
      });
      if (owned) {
        console.info('[eventsRepo] skip telegram shadow; live-monitor owns wallet+tx', {
          ingestSource,
          userId: row.user.id,
          chain: row.activity.metadata.chain,
          trackedAddress: row.activity.metadata.trackedAddress,
          txHash: row.activity.metadata.txHash,
          tokenAddress: row.activity.metadata.tokenAddress,
          txAction: row.activity.metadata.txAction,
        });
        return false;
      }
      return true;
    });
    if (candidateRows.length === 0) return;
  }

  const rowsWithStableIds = candidateRows.map((row, index) => ({
    ...row,
    stableId: `input-${String(index).padStart(12, '0')}`,
  }));
  const rowsNeedingScore = rowsWithStableIds.filter((row) => !row.activity.metadata.importance);
  const scoredRows = rowsNeedingScore.length > 0 ? scoreFeedRowsAgainstDatabase(rowsNeedingScore) : [];
  const scoredByStableId = new Map(scoredRows.map((row) => [row.stableId || '', row] as const));
  const rowsForUpsert = rowsWithStableIds.map((row) => scoredByStableId.get(row.stableId || '') || row);

  // Keep caller array in sync only for rows that were not filtered out.
  if (candidateRows === rows) {
    for (let index = 0; index < rows.length; index += 1) {
      const scored = rowsForUpsert[index];
      rows[index].user = scored.user;
      rows[index].activity = scored.activity;
    }
  } else {
    for (let index = 0; index < candidateRows.length; index += 1) {
      const scored = rowsForUpsert[index];
      candidateRows[index].user = scored.user;
      candidateRows[index].activity = scored.activity;
    }
  }

  const transactionResult = withTransaction(() => {
    let detectedConflictCount = 0;
    const db = getDb();
    const now = Date.now();
    const existingStmt = db.prepare(`SELECT event_id, activity_json FROM events WHERE event_id = ? LIMIT 1`);
    // Only rekey legacy 3-part ids (no token suffix) or same-token rows onto the
    // token-aware event_id. Never steal a sibling multi-token leg.
    const existingMonitorByLogicalTxStmt = db.prepare(
      `SELECT event_id, activity_json
       FROM events
       WHERE user_id = ?
         AND source = 'blockchain'
         AND chain = ?
         AND LOWER(COALESCE(tx_hash, '')) = ?
         AND address = ?
         AND (
           ingest_source LIKE 'telegram-monitor%'
           OR ingest_source LIKE 'live-monitor%'
         )
         AND (
           ? = ''
           OR LOWER(COALESCE(json_extract(activity_json, '$.metadata.tokenAddress'), '')) = ?
           OR (
             -- legacy 3-part xxyy-monitor:c:w:tx with no token segment
             event_id = ('xxyy-monitor:' || ? || ':' || ? || ':' || ?)
             AND (
               json_extract(activity_json, '$.metadata.tokenAddress') IS NULL
               OR LOWER(COALESCE(json_extract(activity_json, '$.metadata.tokenAddress'), '')) IN ('', ?)
             )
           )
         )
         AND event_id != ?
       ORDER BY updated_at DESC, rowid DESC
       LIMIT 1`
    );
    const rekeyEventStmt = db.prepare(
      `UPDATE events
       SET event_id = ?,
           dedup_key = ?,
           updated_at = ?
       WHERE event_id = ?`
    );
    const deleteDuplicateEventTweetRefsStmt = db.prepare(
      `DELETE FROM event_tweet_refs
       WHERE event_id = ?
         AND tweet_id IN (
           SELECT tweet_id
           FROM event_tweet_refs
           WHERE event_id = ?
         )`
    );
    const rekeyEventTweetRefsStmt = db.prepare(
      `UPDATE event_tweet_refs
       SET event_id = ?
       WHERE event_id = ?`
    );
    const rekeyFeedConflictsEventKeyStmt = db.prepare(
      `UPDATE feed_conflicts
       SET event_key = ?,
           updated_at = ?
       WHERE event_key = ?`
    );
    // Only drop legacy 3-part ids or same-token duplicates — never sibling multi-token legs.
    const deleteDuplicateMonitorEventsStmt = db.prepare(
      `DELETE FROM events
       WHERE user_id = ?
         AND source = 'blockchain'
         AND chain = ?
         AND LOWER(COALESCE(tx_hash, '')) = ?
         AND address = ?
         AND (
           ingest_source LIKE 'telegram-monitor%'
           OR ingest_source LIKE 'live-monitor%'
         )
         AND event_id != ?
         AND (
           event_id = ('xxyy-monitor:' || ? || ':' || ? || ':' || ?)
           OR (
             ? != ''
             AND LOWER(COALESCE(json_extract(activity_json, '$.metadata.tokenAddress'), '')) = ?
           )
         )`
    );
    const rawTransactionStmt = db.prepare(
      `SELECT tracked_address, tx_time, payload_json
       FROM raw_transactions
       WHERE chain = ?
         AND tracked_address_lower = ?
         AND tx_hash_lower = ?
       LIMIT 1`
    );
    const rawTransactionByHashStmt = db.prepare(
      `SELECT tracked_address, tx_time, payload_json
       FROM raw_transactions
       WHERE chain = ?
         AND tx_hash_lower = ?
       ORDER BY updated_at DESC
       LIMIT 1`
    );
    const telegramMonitorStmt = db.prepare(
      `SELECT provider,
              source_chat_id,
              source_message_id,
              update_id,
              tracked_wallet_address,
              event_time_ms,
              raw_text,
              payload_json
       FROM telegram_monitor_events
       WHERE chain = ?
         AND tx_hash_lower = ?
         AND (? = '' OR tracked_wallet_address_lower = ?)
       ORDER BY updated_at DESC
       LIMIT 1`
    );
    const twitterOriginalStmt = db.prepare(
      `SELECT tweet_id,
              author_handle,
              author_name,
              full_text,
              created_at_ms,
              lane,
              conversation_id,
              in_reply_to_tweet_id,
              quoted_tweet_id,
              metrics_reply_count,
              metrics_retweet_count,
              metrics_like_count,
              metrics_view_count,
              source_json
       FROM twitter_tweets
       WHERE tweet_id = ?
       LIMIT 1`
    );

    const stmt = db.prepare(
      `INSERT INTO events (
         event_id,
         source,
         kind,
         timestamp,
         user_id,
         user_name,
         chain,
         address,
         content,
         url,
         action,
         token,
         tweet_id,
         tx_hash,
         ingest_source,
         dedup_key,
         metadata_json,
         payload_json,
         user_json,
         activity_json,
         indexed_at,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         source = excluded.source,
         kind = excluded.kind,
         timestamp = excluded.timestamp,
         user_id = excluded.user_id,
         user_name = excluded.user_name,
         chain = excluded.chain,
         address = excluded.address,
         content = excluded.content,
         url = excluded.url,
         action = excluded.action,
         token = excluded.token,
         tweet_id = excluded.tweet_id,
         tx_hash = excluded.tx_hash,
         ingest_source = excluded.ingest_source,
         dedup_key = excluded.dedup_key,
         metadata_json = excluded.metadata_json,
         payload_json = excluded.payload_json,
         user_json = excluded.user_json,
         activity_json = excluded.activity_json,
         indexed_at = excluded.indexed_at,
         updated_at = excluded.updated_at`
    );

    for (const row of rowsForUpsert) {
      const { user, activity } = row;
      const eventId = buildEventId(user, activity);
      const monitorLogicalKey = buildTelegramMonitorLogicalTxKey(activity);
      const chainLower = normalize(activity.metadata.chain);
      const txHashLowerForLookup = normalize(activity.metadata.txHash);
      const trackedAddressLowerForLookup = normalize(activity.metadata.trackedAddress);
      const tokenAddressLower = normalize(activity.metadata.tokenAddress);
      const exactExistingRow = existingStmt.get(eventId) as
        | { event_id: string; activity_json?: string }
        | undefined;
      const monitorLogicalExistingRow =
        !exactExistingRow && monitorLogicalKey
          ? ((existingMonitorByLogicalTxStmt.get(
              user.id,
              chainLower,
              txHashLowerForLookup,
              trackedAddressLowerForLookup,
              tokenAddressLower,
              tokenAddressLower,
              chainLower,
              trackedAddressLowerForLookup,
              txHashLowerForLookup,
              tokenAddressLower,
              eventId
            ) as { event_id: string; activity_json?: string } | undefined) ??
            undefined)
          : undefined;
      if (monitorLogicalExistingRow && monitorLogicalExistingRow.event_id !== eventId) {
        rekeyEventStmt.run(eventId, eventId, now, monitorLogicalExistingRow.event_id);
        deleteDuplicateEventTweetRefsStmt.run(eventId, monitorLogicalExistingRow.event_id);
        rekeyEventTweetRefsStmt.run(eventId, monitorLogicalExistingRow.event_id);
        rekeyFeedConflictsEventKeyStmt.run(eventId, now, monitorLogicalExistingRow.event_id);
      }

      const existingActivity = parseJson<Activity>(
        (exactExistingRow || monitorLogicalExistingRow)?.activity_json
      );
      const mergedActivity = mergeActivityForUpsert(user, activity, existingActivity);
      if (existingActivity) {
        const diff = diffActivityForConflict(existingActivity, mergedActivity);
        if (diff.length > 0 && !isExpectedMonitorAggregateCorrection(existingActivity, mergedActivity)) {
          const domain = detectConflictDomain(mergedActivity);
          const winner = chooseConflictWinner(domain);
          const eventKey = eventId;
          const conflictKey = buildConflictKey(domain, eventKey, diff);

          upsertConflictAndEnqueue({
            conflictKey,
            domain,
            eventKey,
            winner,
            diffJson: diff,
          });

          detectedConflictCount += 1;

          console.info('[eventsRepo] conflict detected', {
            eventId,
            domain,
            winner,
            conflictKey,
            fields: diff.map((d) => d.field),
          });
        }
      }
      const chain = normalize(mergedActivity.metadata.chain) || null;
      const address =
        normalize(mergedActivity.metadata.trackedAddress) ||
        normalize(mergedActivity.metadata.fromAddress) ||
        normalize(mergedActivity.metadata.toAddress) ||
        null;
      const action = (mergedActivity.metadata.txAction || mergedActivity.metadata.tweetKind || null) as string | null;
      const dedupKey = eventId;
      const txHashLower = normalize(mergedActivity.metadata.txHash);
      const trackedAddressLower = normalize(mergedActivity.metadata.trackedAddress);

      let originalPayload: unknown = buildFallbackOriginalPayload(mergedActivity, ingestSource);

      if (mergedActivity.metadata.tweetId) {
        const rawTweet = twitterOriginalStmt.get(mergedActivity.metadata.tweetId.trim()) as
          | {
              tweet_id: string;
              author_handle: string;
              author_name: string | null;
              full_text: string;
              created_at_ms: number;
              lane: string;
              conversation_id: string | null;
              in_reply_to_tweet_id: string | null;
              quoted_tweet_id: string | null;
              metrics_reply_count: number;
              metrics_retweet_count: number;
              metrics_like_count: number;
              metrics_view_count: number;
              source_json: string | null;
            }
          | undefined;

        if (rawTweet) {
          originalPayload = {
            schemaVersion: 1,
            ingestSource,
            originalType: 'twitter-tweet',
            tweetId: rawTweet.tweet_id,
            fullText: rawTweet.full_text,
            source: parseJson<unknown>(rawTweet.source_json) ?? rawTweet.source_json,
            storedTweet: {
              authorHandle: rawTweet.author_handle,
              authorName: rawTweet.author_name,
              createdAtMs: rawTweet.created_at_ms,
              lane: rawTweet.lane,
              conversationId: rawTweet.conversation_id,
              replyToTweetId: rawTweet.in_reply_to_tweet_id,
              quoteTweetId: rawTweet.quoted_tweet_id,
              metrics: {
                replies: rawTweet.metrics_reply_count,
                retweets: rawTweet.metrics_retweet_count,
                likes: rawTweet.metrics_like_count,
                views: rawTweet.metrics_view_count,
              },
            },
          };
        }
      } else if (chain && txHashLower && isTelegramMonitorActivity(mergedActivity, ingestSource)) {
        const rawTelegram = telegramMonitorStmt.get(
          chain,
          txHashLower,
          trackedAddressLower || '',
          trackedAddressLower || ''
        ) as
          | {
              provider: string;
              source_chat_id: string | null;
              source_message_id: number | null;
              update_id: number | null;
              tracked_wallet_address: string | null;
              event_time_ms: number | null;
              raw_text: string | null;
              payload_json: string | null;
            }
          | undefined;

        if (rawTelegram) {
          originalPayload = {
            schemaVersion: 1,
            ingestSource,
            originalType: 'telegram-monitor-message',
            rawText: rawTelegram.raw_text || mergedActivity.metadata.rawText || null,
            payload: parseJson<unknown>(rawTelegram.payload_json) ?? rawTelegram.payload_json,
            lookup: {
              provider: rawTelegram.provider,
              sourceChatId: rawTelegram.source_chat_id,
              sourceMessageId: rawTelegram.source_message_id,
              updateId: rawTelegram.update_id,
              trackedWalletAddress: rawTelegram.tracked_wallet_address,
              eventTimeMs: rawTelegram.event_time_ms,
            },
          };
        }
      } else if (chain && txHashLower) {
        const rawTransaction =
          (
            trackedAddressLower
              ? rawTransactionStmt.get(chain, trackedAddressLower, txHashLower)
              : rawTransactionByHashStmt.get(chain, txHashLower)
          ) as
            | {
                tracked_address: string;
                tx_time: number | null;
                payload_json: string;
              }
            | undefined;

        if (rawTransaction) {
          originalPayload = {
            schemaVersion: 1,
            ingestSource,
            originalType: 'blockchain-transaction',
            chain,
            txHash: mergedActivity.metadata.txHash || null,
            trackedAddress: rawTransaction.tracked_address,
            txTime: rawTransaction.tx_time,
            payload: parseJson<unknown>(rawTransaction.payload_json) ?? rawTransaction.payload_json,
          };
        }
      }

      stmt.run(
        eventId,
        mergedActivity.source,
        mergedActivity.type,
        mergedActivity.timestamp,
        user.id,
        user.name,
        chain,
        address,
        mergedActivity.content,
        extractUrl(mergedActivity),
        action,
        mergedActivity.metadata.token || null,
        mergedActivity.metadata.tweetId || null,
        mergedActivity.metadata.txHash || null,
        ingestSource,
        dedupKey,
        JSON.stringify(mergedActivity.metadata || {}),
        JSON.stringify(originalPayload),
        JSON.stringify(user),
        JSON.stringify(mergedActivity),
        now,
        now,
        now
      );

      if (monitorLogicalKey) {
        const chainLowerForDelete = normalize(mergedActivity.metadata.chain);
        const txHashLowerForDelete = normalize(mergedActivity.metadata.txHash);
        const trackedLowerForDelete = normalize(mergedActivity.metadata.trackedAddress);
        const tokenLowerForDelete = normalize(mergedActivity.metadata.tokenAddress);
        deleteDuplicateMonitorEventsStmt.run(
          user.id,
          chainLowerForDelete,
          txHashLowerForDelete,
          trackedLowerForDelete,
          eventId,
          chainLowerForDelete,
          trackedLowerForDelete,
          txHashLowerForDelete,
          tokenLowerForDelete,
          tokenLowerForDelete
        );
      }
    }

    return detectedConflictCount;
  });

  // 冲突通知 flush 必须在事务外：flushConflictNotifications 内部 sendTelegramTextMessage
  // 发起网络请求（即使 void fire-and-forget，async 回调仍会在事务关闭前执行），
  // 网络挂起 = 事务持写锁挂起 = 全库 database is locked（2026-10-02 锁雪崩根因）。
  // upsertConflictAndEnqueue 入队的事务已提交，这里只负责触发投递。
  if (transactionResult > 0) {
    void flushConflictNotifications(Math.min(20, transactionResult * 2));
  }

  bumpFeedRevision();

  if (ingestSource === 'telegram-monitor-ingest' || ingestSource === 'telegram-monitor-reconcile') {
    triggerBidFeedPush(rowsForUpsert);
  }
}

/**
 * CA 搜索扩展的 tweet_id 命中集。q 不是 CA（mentions 表查无此地址）时返回空集，
 * 所以无需前端做地址格式预判 —— 开关开着搜普通词也不会误扩展。
 * 上限保护：热门币 ticker 提及可能上千，IN 列表太大会拖垮 SQL；砍到最新 N 条。
 */
const EXPAND_TWEET_IDS_CAP = 400;

function resolveExpandTweetIds(
  db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } },
  q: string,
  expandTicker: boolean,
  expandOfficial: boolean
): string[] {
  if (!q || (!expandTicker && !expandOfficial)) return [];
  const qLower = q.toLowerCase();
  const ids = new Set<string>();

  // mentions 表 ~2 万行，等值扫可接受（无独立 token_address_lower 索引）
  if (expandTicker) {
    const rows = db
      .prepare(
        `SELECT tweet_id FROM twitter_tweet_token_mentions
         WHERE token_address_lower = ? AND match_source = 'ticker'
         ORDER BY created_at_ms DESC LIMIT ${EXPAND_TWEET_IDS_CAP}`
      )
      .all(qLower) as Array<{ tweet_id: string }>;
    for (const row of rows) ids.add(row.tweet_id);
  }

  if (expandOfficial) {
    // ① 正文 @ 官推 的推（enrichment 阶段用 officialTwitterByHandle 匹配出来的）
    const mentionRows = db
      .prepare(
        `SELECT tweet_id FROM twitter_tweet_token_mentions
         WHERE token_address_lower = ? AND match_source = 'official_twitter'
         ORDER BY created_at_ms DESC LIMIT ${EXPAND_TWEET_IDS_CAP}`
      )
      .all(qLower) as Array<{ tweet_id: string }>;
    for (const row of mentionRows) ids.add(row.tweet_id);

    // ② 官推自己发的推（author_handle = 官推 handle，可能完全不提币）
    const officialMap = getPrimaryPoolOfficialTwitterMap();
    const handles = new Set<string>();
    for (const [handle, tokens] of officialMap) {
      if (tokens.some((tok) => tok.address.toLowerCase() === qLower)) {
        handles.add(handle);
      }
    }
    if (handles.size > 0) {
      const placeholders = [...handles].map(() => '?').join(', ');
      const authorRows = db
        .prepare(
          `SELECT tweet_id FROM twitter_tweets
           WHERE lower(author_handle) IN (${placeholders})
           ORDER BY created_at_ms DESC LIMIT ${EXPAND_TWEET_IDS_CAP}`
        )
        .all(...handles) as Array<{ tweet_id: string }>;
      for (const row of authorRows) ids.add(row.tweet_id);
    }
  }

  return [...ids];
}

export function readEventsFeed(query: EventFeedQuery) {
  const db = getDb();
  const currentUsersById = new Map(listTrackedUsers().map((user) => [user.id, user] as const));
  // load-more 会要 400；上限别太大，单页 JSON 仍要可解析
  const safeLimit = Math.max(1, Math.min(400, Math.floor(query.limit || 50)));
  const cursor = decodeCursor(query.cursor || null);
  const q = (query.q || '').trim();
  const source = normalize(query.source);
  const userId = (query.userId || '').trim();
  const chain = normalize(query.chain);
  const fromMs = typeof query.fromMs === 'number' && Number.isFinite(query.fromMs) ? Math.floor(query.fromMs) : null;
  const toMs = typeof query.toMs === 'number' && Number.isFinite(query.toMs) ? Math.floor(query.toMs) : null;
  // Policy A: default Feed only shows Feishu-enabled people; search / user pin can still hit history.
  const monitoredOnly =
    query.monitoredOnly !== false && !userId && !q;

  const where: string[] = [];
  const params: Array<string | number> = [];

  if (monitoredOnly) {
    // 物化监控用户 id 列表，而不是把子查询塞进 WHERE。
    // 实测（2026-09-12）：`e.user_id IN (SELECT id FROM tracked_users …)` 让全局首页
    // COUNT 对 35.5 万行逐行求值 → 3.4s，且首个同步查询阻塞单线程 Bun，连带把
    // /api/users/*（持仓面板）的响应推到 0.3–4s。物化成 IN (?,?,…) 后 COUNT 走索引。
    const monitoredUserIds = (
      db
        .prepare(`SELECT id FROM tracked_users WHERE COALESCE(monitoring_enabled, 1) = 1`)
        .all() as Array<{ id: string }>
    ).map((row) => row.id);
    where.push(
      monitoredUserIds.length > 0
        ? `(e.user_id IS NULL OR e.user_id IN (${monitoredUserIds.map(() => '?').join(', ')}))`
        : 'e.user_id IS NULL',
    );
    params.push(...monitoredUserIds);
  }
  if (source) {
    where.push('e.source = ?');
    params.push(source);
  }
  if (userId) {
    where.push('e.user_id = ?');
    params.push(userId);
  }
  if (chain) {
    where.push('e.chain = ?');
    params.push(chain);
  }
  if (fromMs !== null) {
    where.push('e.timestamp >= ?');
    params.push(fromMs);
  }
  if (toMs !== null) {
    where.push('e.timestamp <= ?');
    params.push(toMs);
  }
  if (cursor) {
    where.push('(e.timestamp < ? OR (e.timestamp = ? AND e.event_id < ?))');
    params.push(cursor.timestamp, cursor.timestamp, cursor.eventId);
  }

  const actionTerm = q && TRADE_ACTION_KEYWORDS.has(q) ? q : null;
  const ftsMatch = !actionTerm && q ? parseQueryTerms(q) : null;

  // CA 搜索扩展：开关打开时把 ticker 提及 / 官推相关的推文并进命中集。
  // q 不是 CA（mentions 查无）时 expandTweetIds 为空集 → 行为与不扩展完全一致。
  const expandTweetIds =
    ftsMatch && (query.expandTicker === true || query.expandOfficialTweets === true)
      ? resolveExpandTweetIds(db, q, query.expandTicker === true, query.expandOfficialTweets === true)
      : [];
  // 搜索命中超上限时收窄到最近 N 天（Finn 2026-10-09 拍板「命中超 50 条只排最近 N 天」）：
  // FTS 驱动路径的 ORDER BY 是 TEMP B-TREE，排序成本随命中数线性涨（sol 3.7 万命中 2.6s，
  // 单字母前缀可上 5 万+）。先用纯 FTS 计数（只扫 doclist 不取行，5 万命中 ~0.05s）判断，
  // 命中 ≤ 50 不开窗（老 CA 全史可搜，排序便宜）；> 50 才开窗。
  // ⚠️ 必须在 fts MATCH 的 where/filterParams 之前 push：最终传参是 [...params, ...filterParams]，
  // SQL 占位符顺序（cursor → 窗口 → MATCH）必须与之一致。
  let searchTimeWindowMs: number | null = null;
  let searchTimeWindowParamIndex = -1;
  let searchTimeWindowWhereIndex = -1;
  if (ftsMatch && expandTweetIds.length === 0 && fromMs === null && toMs === null) {
    const ftsHitCount = (
      db.prepare('SELECT COUNT(*) AS count FROM events_fts WHERE events_fts MATCH ?').get(ftsMatch) as {
        count: number;
      }
    ).count;
    if (ftsHitCount > FTS_SEARCH_WINDOW_HIT_THRESHOLD) {
      searchTimeWindowMs = Date.now() - FTS_SEARCH_TIME_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      searchTimeWindowParamIndex = params.length;
      params.push(searchTimeWindowMs);
      searchTimeWindowWhereIndex = where.length;
      where.push('e.timestamp >= ?');
    }
  }
  let joinSql = '';
  // JOIN ON 追加谓词（FTS 的 MATCH 不能出现在 WHERE 的 OR 表达式里 —— FTS5 限制：
  // "unable to use function MATCH in the requested context"，MATCH 只能作为 JOIN ON
  // 或顶层 WHERE 谓词），放在 ON 里配合 LEFT JOIN 再用 WHERE 放行即可表达 OR 语义。
  const joinOnExtra: string[] = [];
  const filterParams: string[] = [];
  // 扩展段：CA 扩展开关命中、但 FTS 未覆盖的推文 id 集合（走 idx_events_tweet_id 直查）。
  let expandTweetIdUnion: string[] | null = null;

  // FTS 搜索走「FTS 表驱动 + rowid 回表」形态（2026-10-09）。
  // 旧形态 `FROM events e INNER JOIN events_fts ON events_fts.rowid = e.rowid` 会让 planner
  // 选 events 沿 idx_events_timestamp 扫全表（52.9 万行）逐行探测 FTS 匹配——
  // 哪怕命中只有 506 条（哈基米）也要 25.6s，正好吃满前端 25s 超时。
  // 倒转后由 FTS MATCH 输出命中 rowid 集合再按 rowid 精确回表：
  // 哈基米 25.6s→0.08s、pow 34.4s→0.85s、sol(3.7万命中) 16.9s→2.6s。
  // 代价是 ORDER BY 走 TEMP B-TREE（不再沿时间索引免排序），命中集超大时会变慢——
  // 由 FTS_SEARCH_TIME_WINDOW_DAYS 时间窗兜底（只排窗内命中，见上）。
  // 注意 ftsFromSql 必须用 CROSS JOIN 语法钉死驱动顺序，写 INNER JOIN planner 会翻回去。
  let ftsFromSql = '';
  if (ftsMatch) {
    if (expandTweetIds.length > 0) {
      // 扩展形态（2026-10-09 CA 扩展开关）：命中 = FTS ∪ 扩展推文。
      // ⚠️ 不能用单个 LEFT JOIN + (fts.rowid IS NOT NULL OR e.tweet_id IN (…)) 表达 OR：
      // planner 会 SCAN e USING idx_events_timestamp（沿时间索引全表 52.9 万行）
      // 逐行评估 OR 的两臂，产线实测 33.8s——正是「MATCH 不能进 WHERE 的 OR」
      // 硬约束把这条路径逼成 events 驱动的恶果。
      // 改为「FTS 命中 ∪ tweet_id 直查」两段各自走最优索引，应用层去重：
      // FTS 段由 MATCH 驱动（ftsFromSql），扩展段走 idx_events_tweet_id。
      // LIMIT 语义：两段各取 limit+1 行后合并排序裁剪，hasMore 判定下放 unionRows.length。
      ftsFromSql = 'FROM events_fts CROSS JOIN events e ON e.rowid = events_fts.rowid';
      where.push('events_fts MATCH ?');
      filterParams.push(ftsMatch);
      expandTweetIdUnion = expandTweetIds;
    } else {
      // 纯搜索快路径：FTS 表驱动 + rowid 回表（2026-10-09）。
      // 旧形态 `FROM events e INNER JOIN events_fts` 会让 planner 选 events 沿时间索引
      // 全表扫（52.9 万行）逐行探测 FTS——哈基米(命中506) 也要 25.6s，正好吃满前端超时。
      // 倒转后由 MATCH 输出命中 rowid 集合再按 rowid 精确回表：
      // 哈基米 25.6s→0.08s、pow 34.4s→0.85s、sol(3.7万命中) 16.9s→2.6s。
      // 代价 ORDER BY 走 TEMP B-TREE（命中集大时变慢）——由时间窗兜底（见上）。
      // ftsFromSql 必须用 CROSS JOIN 钉死驱动顺序，写 INNER JOIN planner 会翻回去。
      ftsFromSql = 'FROM events_fts CROSS JOIN events e ON e.rowid = events_fts.rowid';
      where.push('events_fts MATCH ?');
      filterParams.push(ftsMatch);
    }
  } else if (actionTerm) {
    where.push('(e.activity_json LIKE ? OR e.content LIKE ?)');
    filterParams.push(`%"txActionLabel":"${actionTerm}"%`, `%${actionTerm}%`);
  }

  const joinOnSql = joinOnExtra.length > 0 ? ` AND ${joinOnExtra.join(' AND ')}` : '';

  // 老热词兜底：开窗后若窗内命中为 0（比如老 CA 的提及都在 30 天前），回退全史排序——
  // 命中稀少时 B-TREE 排序本来就便宜，宁可慢一点也不返回假空结果。
  // 只在非 cursor 页做：cursor 页按定义是同一查询的后续页，窗判定已由首页锁死。
  if (ftsMatch && ftsFromSql !== '' && searchTimeWindowMs !== null && cursor === null) {
    // ⚠️ 形态必须用 CROSS JOIN（FTS 驱动）：rowid IN (SELECT rowid FROM events WHERE …)
    // 会让 planner 物化 30 天全量 rowid（几十万行 LIST SUBQUERY + bloom filter），
    // 产线实测 10.2s；CROSS JOIN 由 MATCH 先出命中集再回表判窗，4ms。
    const windowHitCount = (
      db
        .prepare(
          `SELECT COUNT(1) AS count FROM events_fts
           CROSS JOIN events e ON e.rowid = events_fts.rowid
           WHERE events_fts MATCH ? AND e.timestamp >= ?`,
        )
        .get(ftsMatch, searchTimeWindowMs) as { count: number }
    ).count;
    if (windowHitCount === 0) {
      params.splice(searchTimeWindowParamIndex, 1);
      where.splice(searchTimeWindowWhereIndex, 1);
      searchTimeWindowMs = null;
    }
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  // 全局时间线 SELECT 强制走 idx_events_timestamp。
  // 带 cursor 时 planner 会误选 idx_events_user_timestamp + TEMP B-TREE，page2 从 ~20ms 劣化到 6s+。
  // 但按 userId 过滤时必须走 idx_events_user_timestamp；硬绑 timestamp 会全表扫，
  // 稀有用户 LIMIT ~8s、COUNT ~6s，叠加后前端 25s 超时。
  // COUNT 绝不能绑 idx_events_timestamp：LIMIT 查询靠它秒回，但 COUNT 会沿时间索引扫 10万+ 行（实测 ~6s），
  // 首页并发一叠就 >25s 超时。COUNT 走 covering user 索引或让 planner 自选即可（~30–400ms）。
  // FTS join / 动作词 LIKE 路径不要 INDEXED BY，避免绑死错误索引。
  const forceUserIndex = !joinSql && !actionTerm && Boolean(userId);
  const forceTimestampIndex = !joinSql && !actionTerm && !userId;
  const fromSql = forceUserIndex
    ? 'FROM events e INDEXED BY idx_events_user_timestamp'
    : forceTimestampIndex
      ? 'FROM events e INDEXED BY idx_events_timestamp'
      : 'FROM events e';
  // COUNT 与 SELECT 拆开：全局首页 COUNT 绑 user covering 索引，避免 timestamp 全扫。
  const countFromSql = forceUserIndex || forceTimestampIndex
    ? 'FROM events e INDEXED BY idx_events_user_timestamp'
    : 'FROM events e';

  // baseSql：FTS 场景（纯搜索+扩展）都由 ftsFromSql 驱动；非 FTS 时间线走 fromSql。
  const baseSql =
    ftsMatch
      ? `SELECT e.event_id, e.timestamp, e.user_id, e.user_json, e.activity_json
       ${ftsFromSql}
       ${whereSql}
       ORDER BY e.timestamp DESC, e.event_id DESC
       LIMIT ?`
      : `SELECT e.event_id, e.timestamp, e.user_id, e.user_json, e.activity_json
       ${fromSql}
       ${joinSql}${joinOnSql}
       ${whereSql}
       ORDER BY e.timestamp DESC, e.event_id DESC
       LIMIT ?`;

  // countSql 与 baseSql 同构拆分：纯搜索/扩展都走 FTS 驱动形态（ftsFromSql，
  // 扩展场景的 tweet_id 段在应用层并集，不参与 COUNT——total 只是展示数字，
  // 前端缺失时回退 feed.length）。非 FTS（普通时间线）走 events 驱动形态。
  const countSql =
    ftsMatch
      ? `SELECT COUNT(1) AS count
       ${ftsFromSql}
       ${whereSql}`
      : `SELECT COUNT(1) AS count
       ${countFromSql}
       ${joinSql}${joinOnSql}
       ${whereSql}`;

  const finalParams = [...params, ...filterParams, safeLimit + 1];

  let rows = db.prepare(baseSql).all(...finalParams) as Array<{
    event_id: string;
    timestamp: number;
    user_id: string | null;
    user_json: string;
    activity_json: string;
  }>;

  // 扩展段并集：tweet_id 直查走 idx_events_tweet_id（实测 32ms），按 event_id 去重后
  // 合并排序再整体裁剪。两段各取 limit+1 只保证单段 hasMore 语义；合并后 hasMore
  // 以裁剪前的行数为准（union 后行数仍可能少于两段之和——去重），与旧行为一致。
  if (expandTweetIdUnion && expandTweetIdUnion.length > 0) {
    const placeholders = expandTweetIdUnion.map(() => '?').join(', ');
    const expandRows = db
      .prepare(
        `SELECT e.event_id, e.timestamp, e.user_id, e.user_json, e.activity_json
       FROM events e INDEXED BY idx_events_tweet_id
       WHERE e.tweet_id IN (${placeholders})
       ORDER BY e.timestamp DESC, e.event_id DESC
       LIMIT ?`,
      )
      .all(...expandTweetIdUnion, safeLimit + 1) as typeof rows;
    const seen = new Set(rows.map((row) => row.event_id));
    for (const row of expandRows) {
      if (!seen.has(row.event_id)) {
        seen.add(row.event_id);
        rows.push(row);
      }
    }
    rows = rows
      .sort((a, b) => (b.timestamp - a.timestamp) || (b.event_id > a.event_id ? 1 : b.event_id < a.event_id ? -1 : 0))
      .slice(0, safeLimit + 1);
  }

  const sliced = rows.slice(0, safeLimit);
  const parsedRows = sliced.flatMap((row) => {
    try {
      const user = mergeCurrentUserSnapshot(JSON.parse(row.user_json) as User, currentUsersById, row.user_id);
      const activity = JSON.parse(row.activity_json) as Activity;
      return [{ row, user, activity }];
    } catch {
      return [];
    }
  });
  const feed: EventFeedRow[] = [];
  for (const { row, user, activity } of parsedRows) {
    feed.push({
      user,
      activity,
      cursor: encodeCursor(row.timestamp, row.event_id),
    });
  }

  // 动作词 LIKE 全表 COUNT 很贵；cursor 页的 COUNT 也会扫大段索引（实测 ~5s）。
  // 分页只依赖 hasMore=limit+1；客户端缺失 total 时已回退到 feed.length。
  //
  // 全局首页的监控总数是纯展示数字，但 exact COUNT 要扫 35-40 万行索引（实测 2.6-4s），
  // 且 bun:sqlite 是同步的——它会阻塞单线程 Bun，把并发到达的 /api/users/*（持仓面板）
  // 响应推到 3-4s（2026-09-12 实测：计数期间 users 3.58s，空闲 0.09s）。
  // 因此全局无过滤的总数走进程内缓存（30min TTL）：同一进程的后续开页直接命中，
  // 代价是展示数字最多滞后 30 分钟——每次开页省一整次全表扫描。
  // includeTotal=false（poll 模式）不进缓存路径：调用方本就不要 total，保持 feed.length 回退。
  const cacheableGlobalTotal =
    query.includeTotal !== false &&
    monitoredOnly && !userId && !q && !source && !chain && fromMs === null && toMs === null && !cursor && !actionTerm;
  let cachedTotal: number | null = null;
  if (
    cacheableGlobalTotal &&
    feedTotalCache !== null &&
    Date.now() - feedTotalCache.at < FEED_TOTAL_TTL_MS
  ) {
    cachedTotal = feedTotalCache.value;
  }
  // 搜索（FTS）路径砍掉精确 COUNT（Finn 2026-10-09 拍板）：join 形态的 COUNT 要
  // 物化完整命中集（实测 2.4s/词），但 total 只是展示数字，前端缺失时已回退 feed.length，
  // 「≥N 条」的口径由 UI 层自行表达。动作词 LIKE 的 COUNT 早砍了，FTS 对齐。
  const totalRow =
    query.includeTotal === false || actionTerm || ftsMatch || cursor || cachedTotal !== null
      ? null
      : (db.prepare(countSql).get(...params, ...filterParams) as { count: number } | undefined);
  if (totalRow && cacheableGlobalTotal) {
    feedTotalCache = { value: totalRow.count, at: Date.now() };
  }

  return {
    feed,
    hasMore: rows.length > safeLimit,
    nextCursor: feed.length > 0 ? feed[feed.length - 1].cursor : null,
    total: cachedTotal ?? totalRow?.count ?? feed.length,
  };
}

const FEED_TOTAL_TTL_MS = 30 * 60_000;
let feedTotalCache: { value: number; at: number } | null = null;

let latestActivityCache: { data: Record<string, number>; ts: number; refreshing: boolean } | null = null;
const LATEST_ACTIVITY_TTL_MS = 30_000;

function refreshLatestActivityCache() {
  const db = getDb();
  // 26 万行 GROUP BY user_id 全表扫实测 ~1.1s；换 DISTINCT user_id（走索引，~30ms）
  // + 每个用户按 idx_events_user_timestamp 前缀取 MAX（进程内复用 prepared stmt），
  // 总计 ~100ms，比全表扫快一个量级。
  const userIds = db
    .prepare(`SELECT DISTINCT user_id FROM events WHERE user_id IS NOT NULL AND user_id != ''`)
    .all() as Array<{ user_id: string }>;
  const stmt = db.prepare(`SELECT timestamp FROM events WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1`);

  const latestByUser: Record<string, number> = {};
  for (const row of userIds) {
    const userId = (row.user_id || '').trim();
    if (!userId) {
      continue;
    }
    const latest = stmt.get(userId) as { timestamp?: number } | undefined;
    const ts = typeof latest?.timestamp === 'number' && Number.isFinite(latest.timestamp) ? latest.timestamp : 0;
    if (ts > 0) {
      latestByUser[userId] = ts;
    }
  }

  latestActivityCache = { data: latestByUser, ts: Date.now(), refreshing: false };
  return latestByUser;
}

/**
 * 侧栏红点用的按用户最新时间戳。GROUP BY 全表扫实测 ~1.1s，
 * 而 poll 每 5s 一次且 TTL 过期时恰好撞上会拖慢整个 feed 轮询。
 * 采用 stale-while-revalidate：过期时立即返回旧缓存，后台异步刷新，
 * 保证 poll 路径永远是内存读（~µs）。
 */
export function readLatestActivityAtByUser() {
  const now = Date.now();
  if (latestActivityCache && now - latestActivityCache.ts < LATEST_ACTIVITY_TTL_MS) {
    return latestActivityCache.data;
  }

  if (latestActivityCache) {
    if (!latestActivityCache.refreshing) {
      latestActivityCache.refreshing = true;
      // refreshLatestActivityCache 是同步全表扫（~1.1s），必须真正异步调度，
      // 否则 void 包装也会同步阻塞当前 poll 请求。
      setImmediate(() => {
        try {
          refreshLatestActivityCache();
        } catch {
          // 刷新失败保留旧缓存；必须复位 refreshing，否则标志永久卡 true、
          // 后续调用永远返回旧数据且不再重试。
          if (latestActivityCache) {
            latestActivityCache.refreshing = false;
          }
        }
      });
    }
    // 刷新中或刚过期：先返回旧缓存，不阻塞请求
    return latestActivityCache.data;
  }

  return refreshLatestActivityCache();
}

