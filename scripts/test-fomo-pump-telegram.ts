import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

const FOMO_CHAT_ID = '-5246366357';
const XXYY_CHAT_ID = '-5108676923';

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-fomo-pump-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'pili.sqlite');

  try {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { getDb } = await import(`../lib/server/sqlite.ts?m=${stamp}`);
    const { saveSystemConfig } = await import(`../lib/server/systemConfigRepo.ts?m=${stamp}`);
    const { parseFomoPumpTelegramText } = await import(
      `../lib/server/fomoPumpTelegramParser.ts?m=${stamp}`
    );
    const { ingestTelegramMonitorUpdate } = await import(
      `../lib/server/telegramMonitorIngest.ts?m=${stamp}`
    );

    // --- parser fixtures ---
    const t0 = new Date('2026-08-26T10:00:00+08:00').getTime();

    const single = parseFomoPumpTelegramText(
      '🟢 FlippingProfits 买入 Alawn\n≈$333 · 数量 41.0M · 付 USDC · 首次\n21:11:46 · solana',
      t0
    );
    assert.equal(single.trades.length, 1);
    assert.deepEqual(
      {
        person: single.trades[0]!.personLabel,
        action: single.trades[0]!.action,
        token: single.trades[0]!.tokenSymbol,
        usd: single.trades[0]!.amountUsd,
        qty: single.trades[0]!.quantityLabel,
        quote: single.trades[0]!.quoteSymbol,
        first: single.trades[0]!.isFirstBuy,
        chain: single.trades[0]!.chain,
      },
      {
        person: 'FlippingProfits',
        action: 'buy',
        token: 'Alawn',
        usd: 333,
        qty: '41.0M',
        quote: 'USDC',
        first: true,
        chain: 'solana',
      }
    );
    assert.equal(single.unrecognizedLines.length, 0);

    const digest = parseFomoPumpTelegramText(
      '2 条新动态:\n1. 【Rowdy】买入了代币 $DOLORES · ≈$9,999\n2. 【Cooker.hl | 版本之子 (Theo Arc)】转发了推文',
      t0
    );
    assert.equal(digest.trades.length, 1);
    assert.equal(digest.trades[0]!.personLabel, 'Rowdy');
    assert.equal(digest.trades[0]!.tokenSymbol, 'DOLORES');
    assert.equal(digest.trades[0]!.amountUsd, 9999);

    const social = parseFomoPumpTelegramText('【sling】新增了关注', t0);
    assert.equal(social.trades.length, 0);
    assert.equal(social.unrecognizedLines.length, 0);

    const sell = parseFomoPumpTelegramText(
      '🔴 Whaler 卖出 PEPE\n≈$1,200 · 数量 800M\n10:05:11 · bsc',
      t0
    );
    assert.equal(sell.trades.length, 1);
    assert.equal(sell.trades[0]!.action, 'sell');

    // --- 时间戳回归：平台标注时间是 UTC，不得产出"未来"事件时间 ---
    // 真实形状：标注时间(HH:MM:SS, UTC)早于消息到达，同一天 UTC 场景。
    const tNow = new Date('2026-08-26T11:05:00+08:00').getTime(); // 消息到达(本地 11:05 = UTC 03:05)
    // 标注 02:11:46 UTC（本地 10:11:46），早于消息到达，同一天 UTC。
    const real = parseFomoPumpTelegramText(
      '🟢 FlippingProfits 买入 Alawn\n≈$333 · 数量 41.0M\n02:11:46 · solana',
      tNow
    );
    assert.equal(real.trades.length, 1);
    const eventTimeMs = real.trades[0]!.eventTimeMs as number;
    assert.ok(
      typeof eventTimeMs === 'number' && Number.isFinite(eventTimeMs),
      'eventTimeMs should be a finite number'
    );
    assert.ok(
      eventTimeMs <= tNow,
      `eventTimeMs (${new Date(eventTimeMs).toISOString()}) must not be in the future relative to message arrival (${new Date(tNow).toISOString()})`
    );
    // 精确断言：标注 02:11:46 应为 UTC 当刻（本地 10:11:46）。
    const expectedUtc = new Date('2026-08-26T02:11:46Z').getTime();
    assert.equal(eventTimeMs, expectedUtc, 'annotated UTC time should be preserved exactly');
    // 极端：标注时间晚于消息到达（异常/跨日），兜底钳到消息时间。
    const cross = parseFomoPumpTelegramText(
      '🟢 FlippingProfits 买入 Alawn\n≈$333 · 数量 41.0M\n23:59:59 · solana',
      tNow
    );
    const crossMs = cross.trades[0]!.eventTimeMs as number;
    assert.ok(crossMs <= tNow, `cross-day eventTimeMs (${crossMs}) must be clamped to <= message arrival`);

    // --- DB fixtures ---
    const db = getDb();
    const now = Date.now();
    const insertUser = db.prepare(
      `INSERT INTO tracked_users (id, name, handle, avatar, tags_json, total_asset_usd, historical_max_asset_usd, created_at, updated_at, monitoring_enabled, twitter)
       VALUES (?, ?, ?, '', '[]', 0, 0, ?, ?, 1, ?)`
    );
    insertUser.run('u-rowdy', 'Rowdy', 'rowdy', now, now, 'rowdy');
    insertUser.run('u-flip', 'FlippingProfits', '', now, now, 'flippingprofits');

    saveSystemConfig({
      telegramTradeMonitorSourceChatId: XXYY_CHAT_ID,
      fomoPumpSourceChatId: FOMO_CHAT_ID,
    });

    const { findFomoPumpTrackedUser } = await import(`../lib/server/fomoPumpIngest.ts?m=${stamp}`);
    assert.equal(findFomoPumpTrackedUser('【Rowdy】')?.id, 'u-rowdy');
    assert.equal(findFomoPumpTrackedUser('Cooker.hl | 版本之子 (Theo Arc)'), null);

    // 别名映射：平台装饰名 → tracked name
    saveSystemConfig({ fomoPumpNameAliases: { Cookerhl: 'Rowdy' } });
    assert.equal(findFomoPumpTrackedUser('Cooker.hl | 版本之子 (Theo Arc)')?.id, 'u-rowdy');

    // --- 路由与入库 ---
    const fomoUpdate = {
      update_id: 1,
      message: {
        message_id: 101,
        date: Math.floor(t0 / 1000),
        chat: { id: Number(FOMO_CHAT_ID) },
        from: { is_bot: true },
        text: '2 条新动态:\n1. 【Rowdy】买入了代币 $DOLORES · ≈$9,999\n2. 【Cooker.hl】转发了推文',
      },
    };
    const routed = await ingestTelegramMonitorUpdate(fomoUpdate as never);
    assert.equal(routed.ok, true);
    assert.equal((routed as { ingestedCount?: number }).ingestedCount, 1);

    const rows = db
      .prepare(`SELECT event_id, ingest_source, user_id, activity_json FROM events WHERE ingest_source = 'fomo-pump-telegram'`)
      .all() as Array<{ event_id: string; ingest_source: string; user_id: string; activity_json: string }>;
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.event_id, /^u-rowdy:fomo:-5246366357:101:0$/);
    const meta = JSON.parse(rows[0]!.activity_json).metadata;
    assert.equal(meta.txAction, 'buy');
    assert.equal(meta.displayActionVariantLabel, '买入');
    assert.equal(meta.token, 'DOLORES');
    assert.equal(meta.displayTradeAmountText, '≈$9,999');

    // 幂等：同一条消息重复投递不产生重复事件
    await ingestTelegramMonitorUpdate(fomoUpdate as never);
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ingest_source = 'fomo-pump-telegram'`).get() as { n: number }).n,
      1
    );

    // 社媒动态（无交易行）被忽略，不入库
    const socialOnly = await ingestTelegramMonitorUpdate({
      update_id: 2,
      message: {
        message_id: 102,
        date: Math.floor(t0 / 1000),
        chat: { id: Number(FOMO_CHAT_ID) },
        from: { is_bot: true },
        text: '【sling】新增了关注',
      },
    } as never);
    assert.equal((socialOnly as { reason?: string }).reason, 'no-trade-lines');

    // 未匹配人名的交易行跳过且不报错
    const unmatched = await ingestTelegramMonitorUpdate({
      update_id: 3,
      message: {
        message_id: 103,
        date: Math.floor(t0 / 1000),
        chat: { id: Number(FOMO_CHAT_ID) },
        from: { is_bot: true },
        text: '🟢 StrangerGuy 买入 TESTCOIN\n≈$50 · solana',
      },
    } as never);
    assert.equal((unmatched as { unmatchedCount?: number }).unmatchedCount, 1);

    // 未配置的 chat 依旧拒绝
    const stranger = await ingestTelegramMonitorUpdate({
      update_id: 4,
      message: {
        message_id: 104,
        date: Math.floor(t0 / 1000),
        chat: { id: -9999999 },
        from: { is_bot: true },
        text: 'anything',
      },
    } as never);
    assert.equal((stranger as { reason?: string }).reason, 'chat-not-allowed');

    console.log('OK fomo-pump-telegram');
  } finally {
    if (previousDbPath === undefined) delete process.env.PILIPILI_DB_PATH;
    else process.env.PILIPILI_DB_PATH = previousDbPath;
    if (previousDataDir === undefined) delete process.env.PILIPILI_DATA_DIR;
    else process.env.PILIPILI_DATA_DIR = previousDataDir;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
