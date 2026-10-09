import './server-only-shim.cjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

// 独立数据目录，不碰产线库
process.env.PILIPILI_DATA_DIR = mkdtempSync(join(tmpdir(), 'pili-catchup-'));

async function main() {
  const { getDb } = await import('../lib/server/sqlite');
  const { syncTelegramChannelSource } = await import('../lib/server/telegramChannelSync');
  const { upsertTelegramChannelSource } = await import('../lib/server/telegramChannelSourceRepo');

  const db = getDb();
  // 外键：直接 SQL 建 tracked_user（repo 无 upsert 单测接口）
  db.prepare(`INSERT OR IGNORE INTO tracked_users (id, name, handle, avatar, telegrams_json, tags_json, total_asset_usd, historical_max_asset_usd, created_at, updated_at)
    VALUES ('catchup-user', 'Catchup User', 'catchup-user', '', '[]', '[]', 0, 0, ?, ?)`).run(Date.now(), Date.now());
  // 建源：游标停在 100（模拟断档前的位置）
  const created = upsertTelegramChannelSource({
    userId: 'catchup-user',
    channelRef: '@catchup-test',
    enabled: true,
  });
  const sourceRow = { id: created.id, last_message_id: created.lastMessageId };
  db.prepare(`UPDATE telegram_channel_sources SET last_message_id = 100 WHERE id = ?`).run(sourceRow.id);

  // Mock：频道里积压了 130 条（101~230），limit=50 → 需要 3 轮（50+50+30）
  const PER_PAGE = 50;
  const TOTAL_PENDING = 130;
  let callCount = 0;
  const minIdsSeen: Array<number | null> = [];

  const result = await syncTelegramChannelSource({
    sourceId: sourceRow.id,
    client: {
      async resolveChannel() {
        return {
          channelChatId: '-100999',
          channelUsername: 'catchup-test',
          channelTitle: 'Catchup Test',
          accessHash: 'hash-x',
        };
      },
      async listChannelMessages(input: { minMessageId: number | null; limit?: number }) {
        callCount += 1;
        minIdsSeen.push(input.minMessageId);
        const min = input.minMessageId ?? 0;
        const start = min + 1;
        const batch = Math.min(input.limit || PER_PAGE, 230 - min);
        const messages = [];
        for (let i = 0; i < batch; i++) {
          const id = start + i;
          if (id > 230) break;
          messages.push({
            messageId: id,
            groupedId: null,
            postedAtMs: Date.now() + id * 1000,
            editDateMs: null,
            text: `msg ${id}`,
            textEntities: [],
            media: [],
            linkUrls: [],
            forwardInfo: null,
            views: null,
            forwards: null,
            replies: null,
            raw: {},
          });
        }
        return messages;
      },
    },
  });

  // 断言1：循环拉了 3 轮（50+50+30），不是旧逻辑的 1 轮
  assert.equal(callCount, 3, `expected 3 rounds, got ${callCount}`);
  // 断言2：minId 逐轮推进（null/100 → 150 → 200）
  assert.equal(minIdsSeen[0], 100);
  assert.equal(minIdsSeen[1], 150);
  assert.equal(minIdsSeen[2], 200);
  // 断言3：130 条全部入库（不是旧逻辑只进最新 50 条）
  assert.equal(result.storedCount, TOTAL_PENDING, `expected ${TOTAL_PENDING} stored, got ${result.storedCount}`);
  // 断言4：终态游标 = 230（最新一条）
  assert.equal(result.lastMessageId, 230);
  // 断言5：库里行数一致
  const rowCount = (db.prepare(`SELECT COUNT(*) AS n FROM telegram_channel_posts WHERE channel_chat_id = '-100999'`).get() as { n: number }).n;
  assert.equal(rowCount, TOTAL_PENDING);
  // 断言6：源状态游标已推进
  const after = db.prepare(`SELECT last_message_id FROM telegram_channel_sources WHERE id = ?`).get(sourceRow.id) as { last_message_id: number };
  assert.equal(after.last_message_id, 230);

  console.log('channel sync catch-up tests: ok (3 rounds, 130/130 stored, cursor 100→230)');

  rmSync(process.env.PILIPILI_DATA_DIR!, { recursive: true, force: true });
  process.exit(0);
}

void main();
