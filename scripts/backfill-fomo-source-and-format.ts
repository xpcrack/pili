#!/usr/bin/env node
/**
 * 回填 fomoleaderboardfeed 帖的信源（2026-08-29, 第2轮）。
 * 规则：
 *  - 喊单 thesis → source='fomo'，content = @handle 喊单$token：正文
 *  - 关注的人的交易 buy/sell → source='blockchain', type='transfer',
 *    metadata.txAction = buy/sell（作为其本人链上交易记录，不标 FOMO）
 *  - 不认识的人的交易帖 → 已删除，无需处理
 *
 * 用法：加 --write 才写库；否则 dry-run 打印改动统计。
 */
import './server-only-shim.cjs';
import { getDb, withTransaction } from '../lib/server/sqlite';
import {
  buildFomoThesisContent,
  classifyFomoChannelPost,
  extractFomoTradeAction,
  getOrCreateFomoUser,
  resolveFomoAttributionUser,
} from '../lib/server/fomoChannelAttribution';

const WRITE = process.argv.includes('--write');
const FOMO_CHANNEL_USERNAME = 'fomoleaderboardfeed';

const db = getDb();

const rows = db
  .prepare(
    `SELECT event_id, user_id, user_name, source, content, activity_json
     FROM events
     WHERE json_extract(activity_json, '$.metadata.telegramChannelUsername') = ?
       AND json_extract(activity_json, '$.metadata.telegramSyncSource') = 'telegram-channel'`
  )
  .all(FOMO_CHANNEL_USERNAME) as Array<{
  event_id: string;
  user_id: string;
  user_name: string;
  source: string;
  content: string;
  activity_json: string;
}>;

console.log(`found ${rows.length} fomoleaderboardfeed events`);

const fomoUser = getOrCreateFomoUser();

type Update = {
  eventId: string;
  userId: string;
  userName: string;
  source: string;
  content: string;
  activityJson: string;
};
const updates: Update[] = [];

let thesisToFomo = 0;
let tradeToBlockchain = 0;
let unchanged = 0;

for (const row of rows) {
  const activity = JSON.parse(row.activity_json);
  const text = activity?.metadata?.rawText || activity?.content || row.content || '';
  const classification = classifyFomoChannelPost(text);
  const resolved = classification.isFomoPumpPost
    ? resolveFomoAttributionUser({ classification })
    : null;

  let nextSource: string;
  let nextType: string;
  let nextContent: string;
  let nextUserId: string;
  let nextUserName: string;

  if (classification.isFomoPumpPost && classification.kind === 'trade') {
    // 交易帖：归属到关注的人 → blockchain/transfer；不认识 → 保留（应已删，兜底不动）
    if (!resolved?.user) {
      unchanged++;
      continue;
    }
    const isFomoUser = resolved.user.id === fomoUser.id;
    if (isFomoUser) {
      unchanged++;
      continue;
    }
    const action = extractFomoTradeAction(text);
    nextSource = 'blockchain';
    nextType = 'transfer';
    nextContent = row.content;
    nextUserId = resolved.user.id;
    nextUserName = resolved.user.name;
    activity.source = 'blockchain';
    activity.type = 'transfer';
    activity.title = '链上监控交易';
    if (action) {
      activity.metadata = {
        ...activity.metadata,
        txAction: action,
        displayActionVariantLabel: action === 'buy' ? '买入' : '卖出',
      };
    }
    tradeToBlockchain++;
  } else if (classification.isFomoPumpPost && classification.kind === 'thesis') {
    nextSource = 'fomo';
    nextType = 'post';
    nextContent = buildFomoThesisContent(text, classification.traderHandle);
    nextUserId = resolved?.user ? resolved.user.id : fomoUser.id;
    nextUserName = resolved?.user ? resolved.user.name : fomoUser.name;
    activity.source = 'fomo';
    activity.type = 'post';
    activity.title = 'FOMO 喊单';
    activity.content = nextContent;
    thesisToFomo++;
  } else {
    unchanged++;
    continue;
  }

  const activityJson = JSON.stringify(activity);
  updates.push({
    eventId: row.event_id,
    userId: nextUserId,
    userName: nextUserName,
    source: nextSource,
    content: nextContent,
    activityJson,
  });
}

if (WRITE && updates.length > 0) {
  withTransaction(() => {
    const upd = db.prepare(
      `UPDATE events
       SET source = ?, content = ?, user_id = ?, user_name = ?, activity_json = ?, updated_at = ?
       WHERE event_id = ?`
    );
    for (const u of updates) {
      upd.run(u.source, u.content, u.userId, u.userName, u.activityJson, Date.now(), u.eventId);
    }
  });
}

console.log(`\n${WRITE ? 'WROTE' : 'DRY-RUN'} fomo source/format backfill v2:`);
console.log(`  thesis → fomo: ${thesisToFomo} 条`);
console.log(`  关注的人 trade → blockchain: ${tradeToBlockchain} 条`);
console.log(`  不变: ${unchanged} 条`);
