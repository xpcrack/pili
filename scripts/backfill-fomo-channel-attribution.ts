#!/usr/bin/env node
/**
 * 回填 fomoleaderboardfeed 频道帖的归属（2026-08-29）。
 * 之前 projectTelegramChannelPostToFeed 把该频道全部帖子都投影给频道 owner（Finn），
 * 现在改为按 @handle 归属（见 lib/server/fomoChannelAttribution.ts）：
 *  - 匹配到已跟踪用户（关注的人）→ 归本人（喊单+交易全收）
 *  - 匹配不到 + thesis → 归新建 user:fomo
 *  - 匹配不到 + trade → 删除事件（不收录）
 *
 * 用法：加 --write 才写库；否则 dry-run 打印改动统计（dry-run 也确保 fomo user 存在，
 *      但绝不删/改 events）。
 */
import './server-only-shim.cjs';
import { getDb, withTransaction } from '../lib/server/sqlite';
import {
  classifyFomoChannelPost,
  resolveFomoAttributionUser,
  getOrCreateFomoUser,
} from '../lib/server/fomoChannelAttribution';
import { listTrackedUsers } from '../lib/server/trackedUsersRepo';

const WRITE = process.argv.includes('--write');
const FOMO_CHANNEL_USERNAME = 'fomoleaderboardfeed';

const db = getDb();

const rows = db
  .prepare(
    `SELECT event_id, user_id, user_name, activity_json
     FROM events
     WHERE json_extract(activity_json, '$.metadata.telegramChannelUsername') = ?
       AND json_extract(activity_json, '$.metadata.telegramSyncSource') = 'telegram-channel'`
  )
  .all(FOMO_CHANNEL_USERNAME) as Array<{
  event_id: string;
  user_id: string;
  user_name: string;
  activity_json: string;
}>;

console.log(`found ${rows.length} fomoleaderboardfeed events`);

// fomo user 是终态聚合用户：dry-run 也确保存在（幂等、无害），保证统计一致。
const allUsers = listTrackedUsers();
const fomoUser = getOrCreateFomoUser();

let toKeepOwn = 0;
let toKeepFomo = 0;
let toDrop = 0;
let unchanged = 0;
const stats: Record<string, number> = {};

// 先做完整计算（只读），再单事务写入，压缩锁窗口避免 SQLITE_BUSY。
const updates: Array<{ eventId: string; userId: string; userName: string; userJson: string; activityJson: string }> = [];
const deletes: string[] = [];

for (const row of rows) {
  const activity = JSON.parse(row.activity_json);
  const text = activity?.content || activity?.metadata?.rawText || '';
  const attribution = classifyFomoChannelPost(text);
  if (!attribution.isFomoPumpPost) {
    unchanged++;
    continue;
  }
  const resolved = resolveFomoAttributionUser({ classification: attribution });
  if (!resolved.user) {
    deletes.push(row.event_id);
    toDrop++;
    continue;
  }
  const newUserId = resolved.user.id;
  const newUserName = resolved.user.name;
  if (newUserId === row.user_id) {
    unchanged++;
    continue;
  }
  const newActivity = {
    ...activity,
    userId: newUserId,
    metadata: {
      ...activity.metadata,
      fomoPumpKind: attribution.kind,
      fomoTraderHandle: attribution.traderHandle || undefined,
    },
  };
  updates.push({
    eventId: row.event_id,
    userId: newUserId,
    userName: newUserName,
    userJson: JSON.stringify(resolved.user),
    activityJson: JSON.stringify(newActivity),
  });
  if (newUserId === fomoUser.id) toKeepFomo++;
  else {
    toKeepOwn++;
    stats[newUserName] = (stats[newUserName] || 0) + 1;
  }
}

if (WRITE && (updates.length > 0 || deletes.length > 0)) {
  withTransaction(() => {
    const upd = db.prepare(
      `UPDATE events SET user_id = ?, user_name = ?, user_json = ?, activity_json = ?, updated_at = ? WHERE event_id = ?`
    );
    for (const u of updates) {
      upd.run(u.userId, u.userName, u.userJson, u.activityJson, Date.now(), u.eventId);
    }
    const del = db.prepare(`DELETE FROM events WHERE event_id = ?`);
    for (const eventId of deletes) del.run(eventId);
  });
}

console.log(`\n${WRITE ? 'WROTE' : 'DRY-RUN'} attribution backfill:`);
console.log(`  归本人(关注的人): ${toKeepOwn} 条 ${JSON.stringify(stats)}`);
console.log(`  归 user:fomo(thesis): ${toKeepFomo} 条`);
console.log(`  删除(不认识的交易帖): ${toDrop} 条`);
console.log(`  不变: ${unchanged} 条`);
console.log(`  fomo user id: ${fomoUser.id}`);
