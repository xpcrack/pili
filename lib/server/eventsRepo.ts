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
import {
  buildTelegramMonitorTxStateLookupKey,
  listTelegramMonitorTxStatesByKeys,
  setTelegramMonitorTxStateCanonicalActivity,
  type TelegramMonitorTxState,
} from '@/lib/server/telegramMonitorTxStateRepo';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import { getDb, withTransaction } from '@/lib/server/sqlite';
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
}

const TRADE_ACTION_KEYWORDS = new Set<string>(TRADE_ACTION_LABEL_VALUES);

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

function mergeCurrentUserSnapshot(user: User, currentUsersById: Map<string, User>) {
  return currentUsersById.get(user.id) ?? user;
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
  const mergedRawText = prefersAggregatedMonitorDisplay
    ? pickDisplaySeed(incoming.metadata.rawText)
    : pickDisplaySeed(incoming.metadata.rawText, existing.metadata.rawText);

  const mergedMetadata: Activity['metadata'] = {
    ...existing.metadata,
    ...incoming.metadata,
  };

  const displayMetadata = buildTradeDisplayMetadata({
    rawText: prefersCanonicalMonitorDisplay || prefersAggregatedMonitorDisplay ? undefined : mergedRawText,
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

  withTransaction(() => {
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

          void flushConflictNotifications(10);

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
  });

  bumpFeedRevision();

  if (ingestSource === 'telegram-monitor-ingest' || ingestSource === 'telegram-monitor-reconcile') {
    triggerBidFeedPush(rowsForUpsert);
  }
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
    where.push(
      `(e.user_id IS NULL OR e.user_id IN (SELECT id FROM tracked_users WHERE COALESCE(monitoring_enabled, 1) = 1))`
    );
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

  let joinSql = '';
  const filterParams: string[] = [];

  if (ftsMatch) {
    joinSql = 'INNER JOIN events_fts ON events_fts.rowid = e.rowid';
    where.push('events_fts MATCH ?');
    filterParams.push(ftsMatch);
  } else if (actionTerm) {
    where.push('(e.activity_json LIKE ? OR e.content LIKE ?)');
    filterParams.push(`%"txActionLabel":"${actionTerm}"%`, `%${actionTerm}%`);
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

  const baseSql = `SELECT e.event_id, e.timestamp, e.user_json, e.activity_json
       ${fromSql}
       ${joinSql}
       ${whereSql}
       ORDER BY e.timestamp DESC, e.event_id DESC
       LIMIT ?`;

  const countSql = `SELECT COUNT(1) AS count
       ${countFromSql}
       ${joinSql}
       ${whereSql}`;

  const finalParams = [...params, ...filterParams, safeLimit + 1];

  const rows = db.prepare(baseSql).all(...finalParams) as Array<{
    event_id: string;
    timestamp: number;
    user_json: string;
    activity_json: string;
  }>;

  const sliced = rows.slice(0, safeLimit);
  const parsedRows = sliced.flatMap((row) => {
    try {
      const user = mergeCurrentUserSnapshot(JSON.parse(row.user_json) as User, currentUsersById);
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
  const totalRow =
    query.includeTotal === false || actionTerm || cursor
      ? null
      : (db.prepare(countSql).get(...params, ...filterParams) as { count: number } | undefined);

  return {
    feed,
    hasMore: rows.length > safeLimit,
    nextCursor: feed.length > 0 ? feed[feed.length - 1].cursor : null,
    total: totalRow?.count ?? feed.length,
  };
}

export function readEventStats() {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(1) AS count FROM events').get() as { count: number } | undefined)?.count || 0;
  const sourceRows = db.prepare('SELECT source, COUNT(1) AS count FROM events GROUP BY source').all() as Array<{ source: string; count: number }>;
  const timeRow = db.prepare('SELECT MIN(timestamp) AS min_ts, MAX(timestamp) AS max_ts FROM events').get() as { min_ts: number | null; max_ts: number | null } | undefined;
  return {
    total,
    bySource: sourceRows,
    earliestTimestamp: timeRow?.min_ts || null,
    latestTimestamp: timeRow?.max_ts || null,
  };
}

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

