import 'server-only';

import { getDb, withTransaction } from '@/lib/server/sqlite';
import { scoreFeedRowsAgainstDatabase, scoreFeedRowsChronologically, type FeedImportanceRow } from '@/lib/server/activityImportanceService';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import type { Activity, User } from '@/types';

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function currentUsersById() {
  return new Map(listTrackedUsers().map((user) => [user.id, user] as const));
}

function parseUserFallback(userJson: string, activity: Activity, usersById: Map<string, User>) {
  const parsedUser = parseJson<User>(userJson);
  return usersById.get(activity.userId) || usersById.get(parsedUser.id) || parsedUser;
}

function paddedStableId(prefix: string, id: number | string) {
  return `${prefix}-${String(id).padStart(12, '0')}`;
}

export async function backfillActivityImportance() {
  const db = getDb();
  const usersById = currentUsersById();

  const eventRows = db.prepare('SELECT event_id, user_json, metadata_json, activity_json, timestamp FROM events ORDER BY timestamp ASC, event_id ASC').all() as Array<{
    event_id: string;
    user_json: string;
    metadata_json: string;
    activity_json: string;
    timestamp: number;
  }>;
  const scoredEvents = scoreFeedRowsChronologically(
    eventRows.map((row) => {
      const activity = parseJson<Activity>(row.activity_json);
      return {
        user: parseUserFallback(row.user_json, activity, usersById),
        activity,
        stableId: row.event_id,
      } satisfies FeedImportanceRow;
    })
  );
  const eventRowByStableId = new Map(eventRows.map((row) => [row.event_id, row] as const));

  withTransaction(() => {
    const updateEventStmt = db.prepare(
      `UPDATE events
       SET metadata_json = ?,
           activity_json = ?,
           updated_at = ?
       WHERE event_id = ?`
    );

    let updatedCount = 0;
    for (const row of scoredEvents) {
      const stableId = row.stableId || '';
      const original = eventRowByStableId.get(stableId);
      if (!original) continue;
      const nextMetadataJson = JSON.stringify(row.activity.metadata);
      const nextActivityJson = JSON.stringify(row.activity);
      if (original.metadata_json === nextMetadataJson && original.activity_json === nextActivityJson) {
        continue;
      }
      updateEventStmt.run(
        nextMetadataJson,
        nextActivityJson,
        Date.now() + updatedCount,
        original.event_id
      );
      updatedCount += 1;
    }
  });

  const feedRows = db.prepare('SELECT id, user_json, activity_json, timestamp FROM activity_feed ORDER BY timestamp ASC, id ASC').all() as Array<{
    id: number;
    user_json: string;
    activity_json: string;
    timestamp: number;
  }>;
  const feedStableIdById = new Map<number, string>();
  const scoredFeedRows = scoreFeedRowsChronologically(
    feedRows.map((row) => {
      const activity = parseJson<Activity>(row.activity_json);
      const stableId = paddedStableId('feed', row.id);
      feedStableIdById.set(row.id, stableId);
      return {
        user: parseUserFallback(row.user_json, activity, usersById),
        activity,
        stableId,
      } satisfies FeedImportanceRow;
    })
  );
  const scoredFeedByStableId = new Map(scoredFeedRows.map((row) => [row.stableId || '', row] as const));

  withTransaction(() => {
    const updateFeedStmt = db.prepare(
      `UPDATE activity_feed
       SET activity_json = ?
       WHERE id = ?`
    );
    for (const row of feedRows) {
      const stableId = feedStableIdById.get(row.id);
      if (!stableId) continue;
      const scored = scoredFeedByStableId.get(stableId);
      if (!scored) continue;
      const nextActivityJson = JSON.stringify(scored.activity);
      if (row.activity_json === nextActivityJson) {
        continue;
      }
      updateFeedStmt.run(nextActivityJson, row.id);
    }
  });

  const txStateRows = db.prepare(
    `SELECT id, user_id, canonical_activity_json
     FROM telegram_monitor_tx_states
     WHERE canonical_activity_json IS NOT NULL
     ORDER BY COALESCE(event_time_ms, updated_at) ASC, id ASC`
  ).all() as Array<{ id: number; user_id: string; canonical_activity_json: string }>;
  const txStateStableIdById = new Map<number, string>();
  const txStateRowsToScore: FeedImportanceRow[] = [];
  for (const row of txStateRows) {
    const user = usersById.get(row.user_id);
    if (!user) continue;
    const stableId = paddedStableId('txstate', row.id);
    txStateStableIdById.set(row.id, stableId);
    txStateRowsToScore.push({
      user,
      activity: parseJson<Activity>(row.canonical_activity_json),
      stableId,
    });
  }
  const scoredTxStateRows =
    txStateRowsToScore.length > 0 ? scoreFeedRowsAgainstDatabase(txStateRowsToScore) : [];
  const scoredTxStateByStableId = new Map(scoredTxStateRows.map((row) => [row.stableId || '', row] as const));

  withTransaction(() => {
    const updateTxStateStmt = db.prepare(
      `UPDATE telegram_monitor_tx_states
       SET canonical_activity_json = ?,
           updated_at = ?
       WHERE id = ?`
    );

    let updatedCount = 0;
    for (const row of txStateRows) {
      const stableId = txStateStableIdById.get(row.id);
      if (!stableId) continue;
      const scored = scoredTxStateByStableId.get(stableId);
      if (!scored) continue;
      const nextActivityJson = JSON.stringify(scored.activity);
      if (row.canonical_activity_json === nextActivityJson) {
        continue;
      }
      updateTxStateStmt.run(nextActivityJson, Date.now() + updatedCount, row.id);
      updatedCount += 1;
    }
  });

  const fallbackRows = db.prepare(
    `SELECT id, projected_activity_json
     FROM telegram_monitor_events
     WHERE projected_activity_json IS NOT NULL
     ORDER BY COALESCE(event_time_ms, updated_at) ASC, id ASC`
  ).all() as Array<{ id: number; projected_activity_json: string }>;
  const fallbackStableIdById = new Map<number, string>();
  const fallbackRowsToScore: FeedImportanceRow[] = [];
  for (const row of fallbackRows) {
    const activity = parseJson<Activity>(row.projected_activity_json);
    const user = usersById.get(activity.userId);
    if (!user) continue;
    const stableId = paddedStableId('fallback', row.id);
    fallbackStableIdById.set(row.id, stableId);
    fallbackRowsToScore.push({
      user,
      activity,
      stableId,
    });
  }
  const scoredFallbackRows =
    fallbackRowsToScore.length > 0 ? scoreFeedRowsAgainstDatabase(fallbackRowsToScore) : [];
  const scoredFallbackByStableId = new Map(scoredFallbackRows.map((row) => [row.stableId || '', row] as const));

  withTransaction(() => {
    const updateFallbackStmt = db.prepare(
      `UPDATE telegram_monitor_events
       SET projected_activity_json = ?,
           updated_at = ?
       WHERE id = ?`
    );

    let updatedCount = 0;
    for (const row of fallbackRows) {
      const stableId = fallbackStableIdById.get(row.id);
      if (!stableId) continue;
      const scored = scoredFallbackByStableId.get(stableId);
      if (!scored) continue;
      const nextActivityJson = JSON.stringify(scored.activity);
      if (row.projected_activity_json === nextActivityJson) {
        continue;
      }
      updateFallbackStmt.run(nextActivityJson, Date.now() + updatedCount, row.id);
      updatedCount += 1;
    }
  });
}
