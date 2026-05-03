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

export async function backfillActivityImportance() {
  const db = getDb();
  const usersById = currentUsersById();

  const eventRows = db.prepare('SELECT event_id, user_json, activity_json, timestamp FROM events ORDER BY timestamp ASC, event_id ASC').all() as Array<{
    event_id: string;
    user_json: string;
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

  withTransaction(() => {
    const updateEventStmt = db.prepare(
      `UPDATE events
       SET metadata_json = ?,
           activity_json = ?,
           updated_at = ?
       WHERE event_id = ?`
    );

    scoredEvents.forEach((row, index) => {
      updateEventStmt.run(
        JSON.stringify(row.activity.metadata),
        JSON.stringify(row.activity),
        Date.now() + index,
        eventRows[index]!.event_id
      );
    });
  });

  const feedRows = db.prepare('SELECT id, user_json, activity_json, timestamp FROM activity_feed ORDER BY timestamp ASC, id ASC').all() as Array<{
    id: number;
    user_json: string;
    activity_json: string;
    timestamp: number;
  }>;
  const scoredFeedRows = scoreFeedRowsChronologically(
    feedRows.map((row) => {
      const activity = parseJson<Activity>(row.activity_json);
      return {
        user: parseUserFallback(row.user_json, activity, usersById),
        activity,
        stableId: String(row.id),
      } satisfies FeedImportanceRow;
    })
  );

  withTransaction(() => {
    const updateFeedStmt = db.prepare(
      `UPDATE activity_feed
       SET activity_json = ?
       WHERE id = ?`
    );
    scoredFeedRows.forEach((row, index) => {
      updateFeedStmt.run(JSON.stringify(row.activity), feedRows[index]!.id);
    });
  });

  const txStateRows = db.prepare(
    `SELECT id, user_id, canonical_activity_json
     FROM telegram_monitor_tx_states
     WHERE canonical_activity_json IS NOT NULL
     ORDER BY COALESCE(event_time_ms, updated_at) ASC, id ASC`
  ).all() as Array<{ id: number; user_id: string; canonical_activity_json: string }>;

  withTransaction(() => {
    const updateTxStateStmt = db.prepare(
      `UPDATE telegram_monitor_tx_states
       SET canonical_activity_json = ?,
           updated_at = ?
       WHERE id = ?`
    );

    txStateRows.forEach((row, index) => {
      const activity = parseJson<Activity>(row.canonical_activity_json);
      const user = usersById.get(row.user_id);
      if (!user) return;
      const scored = scoreFeedRowsAgainstDatabase([{ user, activity }])[0];
      if (!scored) return;
      updateTxStateStmt.run(JSON.stringify(scored.activity), Date.now() + index, row.id);
    });
  });

  const fallbackRows = db.prepare(
    `SELECT id, projected_activity_json
     FROM telegram_monitor_events
     WHERE projected_activity_json IS NOT NULL
     ORDER BY COALESCE(event_time_ms, updated_at) ASC, id ASC`
  ).all() as Array<{ id: number; projected_activity_json: string }>;

  withTransaction(() => {
    const updateFallbackStmt = db.prepare(
      `UPDATE telegram_monitor_events
       SET projected_activity_json = ?,
           updated_at = ?
       WHERE id = ?`
    );

    fallbackRows.forEach((row, index) => {
      const activity = parseJson<Activity>(row.projected_activity_json);
      const user = usersById.get(activity.userId);
      if (!user) return;
      const scored = scoreFeedRowsAgainstDatabase([{ user, activity }])[0];
      if (!scored) return;
      updateFallbackStmt.run(JSON.stringify(scored.activity), Date.now() + index, row.id);
    });
  });
}
