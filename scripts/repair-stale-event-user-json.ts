#!/usr/bin/env node
/**
 * 修复 events / activity_feed 中 user_json 落后于 user_id 的行（2026-09-20）。
 *
 * 背景：2026-08-29 的 fomo 频道帖归属回填（backfill-fomo-channel-attribution.ts）
 * 只更新了 user_id / user_name / activity_json，漏了 user_json；而 feed 读路径
 * 旧逻辑按 user_json.id 取当前用户快照，导致这些帖在 feed 里仍显示为频道
 * owner（Finn）+ UNKNOWN 代币徽章。
 *
 * 修法：user_id 列是归属权威。
 *  - user_id 能在 tracked_users 找到 → 用当前用户快照重写 user_json，
 *    顺带对齐 user_name（events）与 activity_json.userId（两表）。
 *  - 找不到（用户已删除）→ 跳过并计数；读路径已兜底按 user_id 取人。
 *
 * 默认 dry-run；--write 才落库。分块小事务写，遵守 SQLite 写锁纪律。
 */
import './server-only-shim.cjs';
import { getDb, withSqliteBusyRetry, withTransaction } from '../lib/server/sqlite';
import { listTrackedUsers } from '../lib/server/trackedUsersRepo';

const WRITE = process.argv.includes('--write');

const db = getDb();
const usersById = new Map(listTrackedUsers().map((user) => [user.id, user] as const));

function rewriteActivityOwnerUserId(activityJson: string, ownerUserId: string): string {
  try {
    const parsed = JSON.parse(activityJson) as { userId?: string };
    if (parsed && typeof parsed === 'object' && parsed.userId !== ownerUserId) {
      return JSON.stringify({ ...parsed, userId: ownerUserId });
    }
  } catch {
    // activity_json 损坏：只修 user_json，不动它
  }
  return activityJson;
}

interface EventRow {
  event_id: string;
  user_id: string;
  user_name: string | null;
  user_json: string;
  activity_json: string;
}

interface FeedRow {
  activity_key: string;
  user_id: string;
  user_json: string;
  activity_json: string;
}

const eventRows = db
  .prepare(
    `SELECT event_id, user_id, user_name, user_json, activity_json
     FROM events
     WHERE user_id IS NOT NULL
       AND COALESCE(json_extract(user_json, '$.id'), '') != user_id`
  )
  .all() as unknown as EventRow[];

const feedRows = db
  .prepare(
    `SELECT activity_key, user_id, user_json, activity_json
     FROM activity_feed
     WHERE user_id IS NOT NULL
       AND COALESCE(json_extract(user_json, '$.id'), '') != user_id`
  )
  .all() as unknown as FeedRow[];

console.log(`stale rows: events=${eventRows.length} activity_feed=${feedRows.length}`);

const eventUpdates: Array<{
  eventId: string;
  userName: string;
  userJson: string;
  activityJson: string;
}> = [];
const feedUpdates: Array<{ activityKey: string; userJson: string; activityJson: string }> = [];
const fixedByUser = new Map<string, number>();
const missingUserIds = new Map<string, number>();

for (const row of eventRows) {
  const owner = usersById.get(row.user_id);
  if (!owner) {
    missingUserIds.set(row.user_id, (missingUserIds.get(row.user_id) || 0) + 1);
    continue;
  }
  eventUpdates.push({
    eventId: row.event_id,
    userName: owner.name,
    userJson: JSON.stringify(owner),
    activityJson: rewriteActivityOwnerUserId(row.activity_json, owner.id),
  });
  fixedByUser.set(owner.name, (fixedByUser.get(owner.name) || 0) + 1);
}

for (const row of feedRows) {
  const owner = usersById.get(row.user_id);
  if (!owner) {
    missingUserIds.set(row.user_id, (missingUserIds.get(row.user_id) || 0) + 1);
    continue;
  }
  feedUpdates.push({
    activityKey: row.activity_key,
    userJson: JSON.stringify(owner),
    activityJson: rewriteActivityOwnerUserId(row.activity_json, owner.id),
  });
}

console.log(`repairable: events=${eventUpdates.length} activity_feed=${feedUpdates.length}`);
for (const [name, count] of [...fixedByUser.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  → ${name}: ${count}`);
}
if (missingUserIds.size > 0) {
  const summary = [...missingUserIds.entries()]
    .map(([id, n]) => `${id.slice(0, 8)}…x${n}`)
    .join(', ');
  console.log(`skipped (user deleted): ${summary}`);
}

if (!WRITE) {
  console.log('\ndry-run only; pass --write to apply');
} else {
  const now = Date.now();
  const updateEventStmt = db.prepare(
    `UPDATE events
     SET user_name = ?, user_json = ?, activity_json = ?, updated_at = ?
     WHERE event_id = ?`
  );
  const updateFeedStmt = db.prepare(
    `UPDATE activity_feed
     SET user_json = ?, activity_json = ?
     WHERE activity_key = ?`
  );

  // 50 行/事务：每行 UPDATE 都触发 events_fts 触发器（对 activity_json 做 json_extract），
  // 500 行/事务实测持锁 8s+，在生产多写进程下直接 SQLITE_BUSY。整块 busy 重试。
  const chunkSize = 50;
  for (let start = 0; start < eventUpdates.length; start += chunkSize) {
    const chunk = eventUpdates.slice(start, start + chunkSize);
    withSqliteBusyRetry(
      () =>
        withTransaction(() => {
          for (const u of chunk) {
            updateEventStmt.run(u.userName, u.userJson, u.activityJson, now, u.eventId);
          }
        }),
      { label: 'repair-stale-user-json/events' }
    );
  }
  for (let start = 0; start < feedUpdates.length; start += chunkSize) {
    const chunk = feedUpdates.slice(start, start + chunkSize);
    withSqliteBusyRetry(
      () =>
        withTransaction(() => {
          for (const u of chunk) {
            updateFeedStmt.run(u.userJson, u.activityJson, u.activityKey);
          }
        }),
      { label: 'repair-stale-user-json/feed' }
    );
  }

  console.log(`WROTE: events=${eventUpdates.length} activity_feed=${feedUpdates.length}`);
}
