/**
 * FOMO 集成冒烟测试 —— 全部走临时 DB（PILIPILI_DATA_DIR）。
 * 运行: npx tsx scripts/test-fomo-integration.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pili-fomo-test-'));
process.env.PILIPILI_DATA_DIR = tmpDir;

const { getDb } = await import('@/lib/server/sqlite');

// --- 1. Schema 建立 ---
const db = getDb();
const tables = db
  .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fomo%'`)
  .all()
  .map((r: any) => r.name)
  .sort();
assert.deepEqual(tables, ['fomo_position_snapshots', 'fomo_trades', 'fomo_user_stats']);
console.log('✓ fomo 表已创建:', tables.join(', '));

const cols = (db.prepare(`PRAGMA table_info(tracked_users)`).all() as any[]).map((r) => r.name);
assert.ok(cols.includes('fomo_user_id'), 'tracked_users.fomo_user_id missing');
assert.ok(cols.includes('fomo_handle'), 'tracked_users.fomo_handle missing');
console.log('✓ tracked_users FOMO 身份列已加');

// --- 2. 绑定身份 + 读回 ---
const { bindFomoIdentity, listFomoBoundUsers, upsertFomoTrade, insertFomoPositionSnapshot, upsertFomoUserStats } =
  await import('@/lib/server/fomoRepo');

db.prepare(
  `INSERT INTO tracked_users (id, name, handle, avatar, tags_json, telegrams_json, total_asset_usd, historical_max_asset_usd, created_at, updated_at)
   VALUES ('u-test-1', '测试车头', 'chetou', '', '[]', '[]', 0, 0, ?, ?)`
).run(Date.now(), Date.now());

const bound = bindFomoIdentity({ userId: 'u-test-1', fomoUserId: 'fomo-uuid-1', fomoHandle: 'inarius' });
assert.ok(bound, 'bind failed');
const boundUsers = listFomoBoundUsers();
assert.equal(boundUsers.length, 1);
assert.equal(boundUsers[0].fomoUserId, 'fomo-uuid-1');
assert.equal(boundUsers[0].fomoHandle, 'inarius');
console.log('✓ 身份绑定 + 读回正常');

// --- 3. 成交落库 upsert ---
const first = upsertFomoTrade({
  id: 'trade-1',
  userId: 'u-test-1',
  userHandle: 'inarius',
  tokenAddress: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  tokenSymbol: 'WIF',
  networkId: 1399811149,
  side: 'closed',
  realizedPnlUsd: 123.45,
  closedAt: Date.now(),
});
assert.equal(first.inserted, 1);
const again = upsertFomoTrade({
  id: 'trade-1',
  userId: 'u-test-1',
  userHandle: 'inarius',
  tokenAddress: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  tokenSymbol: 'WIF',
  networkId: 1399811149,
  side: 'closed',
  realizedPnlUsd: 200,
  closedAt: Date.now(),
});
assert.equal(again.updated, 1);
const row = db.prepare(`SELECT * FROM fomo_trades WHERE id = 'trade-1'`).get() as any;
assert.equal(row.realized_pnl_usd, 200, 'upsert did not update');
assert.equal(row.chain, 'solana', 'networkId->chain mapping failed');
console.log('✓ 成交 upsert + chain 映射正常');

// --- 4. 持仓快照 + 战绩 ---
insertFomoPositionSnapshot({
  userId: 'u-test-1',
  tokenAddress: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  tokenSymbol: 'WIF',
  valueUsd: 5000,
  pnlUsd: 1200,
  networkId: 1399811149,
});
upsertFomoUserStats({
  userId: 'u-test-1',
  userHandle: 'inarius',
  realizedPnl7dUsd: 8888,
  winRate7d: 0.66,
  numTrades7d: 30,
  totalVolume7d: 100000,
});
const statRow = db.prepare(`SELECT * FROM fomo_user_stats WHERE user_id = 'u-test-1'`).get() as any;
assert.equal(statRow.realized_pnl_7d_usd, 8888);
console.log('✓ 持仓快照 + 战绩落库正常');

// --- 5. 轮询 cycle：无 JWT 时优雅报错，不崩 ---
const { runFomoTradesCycle } = await import('@/lib/server/fomoRuntime');
const cycleResult = await runFomoTradesCycle();
assert.equal(cycleResult.status, 'partial');
assert.equal((cycleResult.detail as any).errored, 1);
console.log('✓ trades cycle 无 JWT 时优雅报错 (partial, errored=1)');

// --- 6. JWT 写入 app_state + 读回（模拟 admin 推送） ---
const { setFomoJwt } = await import('@/lib/server/fomoClient');
await setFomoJwt('test-jwt-token-for-smoke-test');
const stateRow = db
  .prepare(`SELECT value_json FROM app_state WHERE key = 'fomo_jwt'`)
  .get() as any;
assert.ok(stateRow?.value_json.includes('test-jwt-token-for-smoke-test'));
console.log('✓ JWT 写入 app_state 正常（值不回显）');

// --- 7. 成交投影到 events feed ---
const { projectFomoTradeToFeed } = await import('@/lib/server/fomoRepo');
const { listTrackedUsers } = await import('@/lib/server/trackedUsersRepo');
const fullUser = listTrackedUsers().find((u) => u.id === 'u-test-1');
assert.ok(fullUser, 'full user not found');
projectFomoTradeToFeed({
  user: fullUser,
  tradeId: 'trade-1',
  content: 'fomo成交 WIF +$123.45',
  timestamp: Date.now(),
  metadata: {
    chain: 'solana',
    token: 'WIF',
    tokenAddress: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    txAction: 'sell',
    displayActionVariantLabel: '卖出',
    displayWalletLabel: 'inarius',
    displayTokenSymbol: 'WIF',
  },
});
const eventRow = db
  .prepare(`SELECT event_id, ingest_source, source, kind FROM events WHERE event_id LIKE '%fomo-api:trade-1'`)
  .get() as any;
assert.ok(eventRow, 'event not projected');
assert.equal(eventRow.ingest_source, 'fomo-api');
assert.equal(eventRow.source, 'blockchain');
assert.equal(eventRow.kind, 'transfer');
console.log('✓ 成交投影到 events feed 正常 (event_id=fomo-api:trade-1, ingest_source=fomo-api)');

// --- 清理 ---
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n全部通过 ✅');
