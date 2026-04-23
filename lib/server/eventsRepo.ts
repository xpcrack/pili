import 'server-only';

import { type Activity, type User } from '@/types';
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

function buildEventId(user: User, activity: Activity) {
  const tweetId = (activity.metadata.tweetId || '').trim();
  if (tweetId) {
    return `twitter:${tweetId}`;
  }

  const chain = normalize(activity.metadata.chain);
  const tracked = normalize(activity.metadata.trackedAddress);
  const txHash = normalize(activity.metadata.txHash);
  if (chain && tracked && txHash) {
    return `${chain}:${tracked}:${txHash}`;
  }

  return `${user.id}:${activity.id}`;
}

function extractUrl(activity: Activity) {
  return activity.metadata.tweetUrl || null;
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
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' AND ');
}

export function upsertEventsFromFeedRows(rows: Array<{ user: User; activity: Activity }>, ingestSource: string) {
  if (rows.length === 0) return;

  withTransaction(() => {
    const db = getDb();
    const now = Date.now();

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
      const chain = normalize(activity.metadata.chain) || null;
      const address =
        normalize(activity.metadata.trackedAddress) ||
        normalize(activity.metadata.fromAddress) ||
        normalize(activity.metadata.toAddress) ||
        null;
      const action = (activity.metadata.txAction || activity.metadata.tweetKind || null) as string | null;
      const dedupKey = eventId;

      stmt.run(
        eventId,
        activity.source,
        activity.type,
        activity.timestamp,
        user.id,
        user.name,
        chain,
        address,
        activity.content,
        extractUrl(activity),
        action,
        activity.metadata.token || null,
        activity.metadata.tweetId || null,
        activity.metadata.txHash || null,
        ingestSource,
        dedupKey,
        JSON.stringify(activity.metadata || {}),
        JSON.stringify({ userId: user.id, activityId: activity.id }),
        JSON.stringify(user),
        JSON.stringify(activity),
        now,
        now,
        now
      );
    }
  });
}

export function readEventsFeed(query: EventFeedQuery) {
  const db = getDb();
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
      const user = JSON.parse(row.user_json) as User;
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
