/**
 * Feed 归属快照回归：user_id 列是权威，脏 user_json 不得把错误的人带进 feed。
 *
 * 背景：fomo 频道帖归属回填只更了 user_id/user_name/activity_json，漏了
 * user_json；readEventsFeed 旧逻辑按 user_json.id 取用户，导致帖子仍显示为
 * 频道 owner。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

// 静态 import 不行：lib/server/sqlite 在模块加载时就解析 DB 路径，
// 必须先把 PILIPILI_DB_PATH/PILIPILI_DATA_DIR 指到临时目录再加载（仓库测试既定模式）。
async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pili-feed-owner-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { createTrackedUser } = await import('../lib/server/trackedUsersRepo');
    const { upsertEventsFromFeedRows, readEventsFeed } = await import('../lib/server/eventsRepo');
    const { getDb } = await import('../lib/server/sqlite');

    const owner = createTrackedUser({
      name: 'Frank',
      handle: 'frank',
      avatar: '',
      twitter: undefined,
      telegram: undefined,
      addresses: [],
      totalAssetUsd: 0,
      historicalMaxAssetUsd: 0,
      mainstreamAssetUsd: 0,
      assetUpdatedAt: null,
      tags: [],
    });
    const stale = createTrackedUser({
      name: 'Finn',
      handle: 'finn',
      avatar: '',
      twitter: undefined,
      telegram: undefined,
      addresses: [],
      totalAssetUsd: 0,
      historicalMaxAssetUsd: 0,
      mainstreamAssetUsd: 0,
      assetUpdatedAt: null,
      tags: [],
    });

    const activity = {
      id: 'telegram:100:200',
      userId: owner.id,
      source: 'fomo' as const,
      type: 'post' as const,
      title: 'FOMO 喊单',
      content: '@frank 喊单$BONER：testing attribution',
      timestamp: Date.now(),
      metadata: {},
    };
    upsertEventsFromFeedRows([{ user: owner, activity }], 'test-owner-snapshot');

    // 模拟历史脏行：归属回填更了列，漏了 user_json / activity_json.userId
    const db = getDb();
    db.prepare(`UPDATE events SET user_json = ?, activity_json = ? WHERE user_id = ?`).run(
      JSON.stringify(stale),
      JSON.stringify({ ...activity, userId: stale.id }),
      owner.id
    );

    const feed = readEventsFeed({ limit: 10, userId: owner.id }).feed;
    assert.equal(feed.length, 1, 'event must still be found by its authoritative user_id');
    assert.equal(feed[0].user.id, owner.id, 'feed must merge by user_id column, not stale user_json');
    assert.equal(feed[0].user.name, 'Frank');

    console.log('ok - feed owner snapshot merges by user_id');
  } finally {
    if (previousDbPath === undefined) delete process.env.PILIPILI_DB_PATH;
    else process.env.PILIPILI_DB_PATH = previousDbPath;
    if (previousDataDir === undefined) delete process.env.PILIPILI_DATA_DIR;
    else process.env.PILIPILI_DATA_DIR = previousDataDir;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
