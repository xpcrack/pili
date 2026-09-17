import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Activity, User } from '@/types';

import './server-only-shim.cjs';

const VALID_SOLANA_WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

function makeUser(id: string): User {
  return {
    id,
    name: id,
    handle: id,
    avatar: '',
    twitter: id,
    addresses: [
      { address: VALID_SOLANA_WALLET, name: '#1', chain: 'solana', totalAssetUsd: null, assetUpdatedAt: null },
    ],
    totalAssetUsd: 250_000,
    historicalMaxAssetUsd: 250_000,
    mainstreamAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
  };
}

function makeChainActivity(id: string, userId: string, timestamp: number): Activity {
  return {
    id,
    userId,
    source: 'blockchain',
    type: 'transfer',
    title: id,
    content: id,
    timestamp,
    metadata: {
      txHash: `${id}-tx`,
      chain: 'solana',
      trackedAddress: VALID_SOLANA_WALLET,
      txAction: 'buy',
      token: 'TEST',
      value: '1',
    },
  };
}

/**
 * 分块写入回归（2026-09-03 事故的治理面）：
 * 单个写事务覆盖全量 feed 会把 WAL 写锁独占到几十分钟，所以批量写被切成
 * SQLITE_WRITE_CHUNK_ROWS 行一块。本测试把块大小压到 2，钉住两条契约：
 * 1) 跨块不丢行、不重行；
 * 2) upsertEventsFromFeedRows 对调用方数组的 in-place 同步语义（user/activity 被
 *    打分结果替换）在分块后仍然成立 —— 调用方（syncService）依赖它。
 */
async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-write-chunk-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');
  // 必须在 import 之前：块大小在模块加载时读取。
  process.env.PILI_SQLITE_WRITE_CHUNK_ROWS = '2';

  // 动态 import 是刻意的：块大小在模块加载时读 env，静态 import 会被提升到
  // 上面的 env 设置之前，就走不到分块路径了（runTests 以独立进程跑每个测试）。
  try {
    const { SQLITE_WRITE_CHUNK_ROWS, forEachWriteChunk, getDb } = await import('@/lib/server/sqlite');
    const { upsertEventsFromFeedRows } = await import('@/lib/server/eventsRepo');
    const { upsertFeedSnapshot } = await import('@/lib/server/feedSnapshotRepo');
    const { createTrackedUser } = await import('@/lib/server/trackedUsersRepo');

    assert.equal(SQLITE_WRITE_CHUNK_ROWS, 2, 'env override must be honoured');

    // 1) 分块器本身：5 项 / 每块 2 → 2+2+1
    const chunkSizes: number[] = [];
    forEachWriteChunk([1, 2, 3, 4, 5], (chunk) => chunkSizes.push(chunk.length));
    assert.deepEqual(chunkSizes, [2, 2, 1]);

    const user = createTrackedUser(makeUser('chunky'));
    const timestamp = 1_720_000_000_000;

    // 2) 5 行（> 块大小）跨 3 个事务写入 events：一行都不能丢
    const rows = [0, 1, 2, 3, 4].map((index) => ({
      user,
      activity: makeChainActivity(`chunked-${index}`, user.id, timestamp + index * 1_000),
    }));
    upsertEventsFromFeedRows(rows, 'test-chunked-ingest');

    const db = getDb();
    const eventCount = db
      .prepare('SELECT COUNT(1) AS count FROM events WHERE user_id = ?')
      .get(user.id) as { count: number };
    assert.equal(eventCount.count, rows.length, 'all rows must land across chunk transactions');

    // 3) in-place 同步语义：跨块后调用方数组里的 activity 仍被替换为打分结果
    for (const row of rows) {
      assert.ok(
        row.activity.metadata.importance?.score !== undefined,
        `row ${row.activity.id} must receive the scored activity in place`
      );
    }

    // 4) 同一行重复喂入不产生重复事件（分块不改变 upsert 幂等性）
    upsertEventsFromFeedRows(rows, 'test-chunked-ingest');
    const afterRepeat = db
      .prepare('SELECT COUNT(1) AS count FROM events WHERE user_id = ?')
      .get(user.id) as { count: number };
    assert.equal(afterRepeat.count, rows.length, 'chunked upsert must stay idempotent');

    // 5) upsertFeedSnapshot 同样分块：3 行全部落 activity_feed
    upsertFeedSnapshot(
      [0, 1, 2].map((index) => ({
        user,
        activity: makeChainActivity(`snapshot-${index}`, user.id, timestamp + 10_000 + index),
      }))
    );
    const snapshotCount = db
      .prepare('SELECT COUNT(1) AS count FROM activity_feed WHERE user_id = ?')
      .get(user.id) as { count: number };
    assert.equal(snapshotCount.count, 3, 'snapshot rows must all be written across chunks');

    console.log('test-sqlite-write-chunking: ok');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
