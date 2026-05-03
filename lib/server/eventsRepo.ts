import 'server-only';

import { createHash } from 'node:crypto';

import { type Activity, type User } from '@/types';
import { getBlockchainActivityIdentity } from '@/lib/activityIdentity';
import { buildTradeDisplayMetadata } from '@/lib/tradeDisplay';
import {
  chooseConflictWinner,
  detectConflictDomain,
  diffActivityForConflict,
  type ConflictFieldDiff,
} from '@/lib/server/sourceReconciliation';
import { upsertConflictAndEnqueue } from '@/lib/server/conflictRepo';
import { flushConflictNotifications } from '@/lib/server/conflictNotifier';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import { getDb, withTransaction } from '@/lib/server/sqlite';

export interface EventFeedQuery {
  limit: number;
  cursor?: string | null;
  q?: string | null;
  source?: string | null;
  userId?: string | null;
  chain?: string | null;
  fromMs?: number | null;
  toMs?: number | null;
}

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
  if (ingestSource.startsWith('telegram-monitor')) {
    return true;
  }

  if (activity.id.startsWith('xxyy-monitor:')) {
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

  const chain = normalize(activity.metadata.chain);
  const trackedAddress = normalize(activity.metadata.trackedAddress);
  const txHash = normalize(activity.metadata.txHash);
  if (!chain || !trackedAddress || !txHash) {
    return null;
  }

  return `${chain}|${trackedAddress}|${txHash}`;
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

  const mergedMetadata: Activity['metadata'] = {
    ...existing.metadata,
    ...incoming.metadata,
  };

  const displayMetadata = buildTradeDisplayMetadata({
    rawText: prefersCanonicalMonitorDisplay ? undefined : pickDisplaySeed(incoming.metadata.rawText, existing.metadata.rawText),
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
      rawText: pickDisplaySeed(incoming.metadata.rawText, existing.metadata.rawText),
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

  withTransaction(() => {
    const db = getDb();
    const now = Date.now();
    const existingStmt = db.prepare(`SELECT event_id, activity_json FROM events WHERE event_id = ? LIMIT 1`);
    const existingMonitorByLogicalTxStmt = db.prepare(
      `SELECT event_id, activity_json
       FROM events
       WHERE user_id = ?
         AND source = 'blockchain'
         AND chain = ?
         AND LOWER(COALESCE(tx_hash, '')) = ?
         AND address = ?
         AND ingest_source LIKE 'telegram-monitor%'
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
    const deleteDuplicateMonitorEventsStmt = db.prepare(
      `DELETE FROM events
       WHERE user_id = ?
         AND source = 'blockchain'
         AND chain = ?
         AND LOWER(COALESCE(tx_hash, '')) = ?
         AND address = ?
         AND ingest_source LIKE 'telegram-monitor%'
         AND event_id != ?`
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

    for (const row of rows) {
      const { user, activity } = row;
      const eventId = buildEventId(user, activity);
      const monitorLogicalKey = buildTelegramMonitorLogicalTxKey(activity);
      const exactExistingRow = existingStmt.get(eventId) as
        | { event_id: string; activity_json?: string }
        | undefined;
      const monitorLogicalExistingRow =
        !exactExistingRow && monitorLogicalKey
          ? ((existingMonitorByLogicalTxStmt.get(
              user.id,
              normalize(activity.metadata.chain),
              normalize(activity.metadata.txHash),
              normalize(activity.metadata.trackedAddress),
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
        deleteDuplicateMonitorEventsStmt.run(
          user.id,
          normalize(mergedActivity.metadata.chain),
          normalize(mergedActivity.metadata.txHash),
          normalize(mergedActivity.metadata.trackedAddress),
          eventId
        );
      }
    }
  });
}

export function readEventsFeed(query: EventFeedQuery) {
  const db = getDb();
  const currentUsersById = new Map(listTrackedUsers().map((user) => [user.id, user] as const));
  const safeLimit = Math.max(1, Math.min(200, Math.floor(query.limit || 50)));
  const cursor = decodeCursor(query.cursor || null);
  const q = (query.q || '').trim();
  const source = normalize(query.source);
  const userId = (query.userId || '').trim();
  const chain = normalize(query.chain);
  const fromMs = typeof query.fromMs === 'number' && Number.isFinite(query.fromMs) ? Math.floor(query.fromMs) : null;
  const toMs = typeof query.toMs === 'number' && Number.isFinite(query.toMs) ? Math.floor(query.toMs) : null;

  const where: string[] = [];
  const params: Array<string | number> = [];

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

  const ftsMatch = q ? parseQueryTerms(q) : null;

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const baseSql = ftsMatch
    ? `SELECT e.event_id, e.timestamp, e.user_json, e.activity_json
         FROM events e
         INNER JOIN events_fts ON events_fts.rowid = e.rowid
         ${whereSql ? `${whereSql} AND` : 'WHERE'} events_fts MATCH ?
         ORDER BY e.timestamp DESC, e.event_id DESC
         LIMIT ?`
    : `SELECT e.event_id, e.timestamp, e.user_json, e.activity_json
         FROM events e
         ${whereSql}
         ORDER BY e.timestamp DESC, e.event_id DESC
         LIMIT ?`;

  const countSql = ftsMatch
    ? `SELECT COUNT(1) AS count
         FROM events e
         INNER JOIN events_fts ON events_fts.rowid = e.rowid
         ${where.length > 0 ? `WHERE ${where.join(' AND ')} AND` : 'WHERE'} events_fts MATCH ?`
    : `SELECT COUNT(1) AS count
         FROM events e
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}`;

  const finalParams = [...params];
  if (ftsMatch) {
    finalParams.push(ftsMatch);
  }
  finalParams.push(safeLimit + 1);

  const rows = db.prepare(baseSql).all(...finalParams) as Array<{
    event_id: string;
    timestamp: number;
    user_json: string;
    activity_json: string;
  }>;

  const sliced = rows.slice(0, safeLimit);
  const feed: EventFeedRow[] = [];
  for (const row of sliced) {
    try {
      const user = mergeCurrentUserSnapshot(JSON.parse(row.user_json) as User, currentUsersById);
      const activity = JSON.parse(row.activity_json) as Activity;
      feed.push({
        user,
        activity,
        cursor: encodeCursor(row.timestamp, row.event_id),
      });
    } catch {
      continue;
    }
  }

  const countParams = [...params];
  if (ftsMatch) {
    countParams.push(ftsMatch);
  }
  const totalRow = db.prepare(countSql).get(...countParams) as { count: number } | undefined;

  return {
    feed,
    hasMore: rows.length > safeLimit,
    nextCursor: feed.length > 0 ? feed[feed.length - 1].cursor : null,
    total: totalRow?.count || 0,
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

export function readLatestActivityAtByUser() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT user_id, MAX(timestamp) AS latest_ts
       FROM events
       WHERE user_id IS NOT NULL AND user_id != ''
       GROUP BY user_id`
    )
    .all() as Array<{ user_id: string; latest_ts: number | null }>;

  const latestByUser: Record<string, number> = {};
  for (const row of rows) {
    const userId = (row.user_id || '').trim();
    if (!userId) {
      continue;
    }

    const ts = typeof row.latest_ts === 'number' && Number.isFinite(row.latest_ts) ? row.latest_ts : 0;
    if (ts > 0) {
      latestByUser[userId] = ts;
    }
  }

  return latestByUser;
}
