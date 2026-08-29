import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-fomo-attrib-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'pili.sqlite');

  try {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { getDb } = await import(`../lib/server/sqlite.ts?m=${stamp}`);
    const {
      classifyFomoChannelPost,
      resolveFomoAttributionUser,
      getOrCreateFomoUser,
      matchTrackedUserByHandle,
    } = await import(`../lib/server/fomoChannelAttribution.ts?m=${stamp}`);

    // --- 判别 ---
    // 喊单(thesis)：72626 样本
    const thesisPost =
      '**$memestock thesis** **0xMo.eth 😂** (@MoEthWhale)\n\n$MEMESTOCK on BNB Chain is positioned to become...\nPosition: **$84,733.02**\nUnrealized PnL: **$69,631.30 (+461.08%)**\ngmgn · fomo';
    const c1 = classifyFomoChannelPost(thesisPost);
    assert.equal(c1.isFomoPumpPost, true);
    assert.equal(c1.kind, 'thesis');
    assert.equal(c1.traderHandle, 'moethwhale');

    // 交易(sell)：72629 样本
    const tradePost =
      '**$BISCOTTI**** sell** **memeticpower** (@memeticpower)\n\nProceeds: **$3,400.19**\nRemaining position: **$0.00**\nRealized PnL: **-$1,001.21 (-12.57%)**\nMarket cap: **$1.68M**\ngmgn · fomo';
    const c2 = classifyFomoChannelPost(tradePost);
    assert.equal(c2.isFomoPumpPost, true);
    assert.equal(c2.kind, 'trade');
    assert.equal(c2.traderHandle, 'memeticpower');

    // 普通频道帖（jiuyicall 风格）→ 非 fomo pump
    const normalPost = 'telegram hello world';
    const c3 = classifyFomoChannelPost(normalPost);
    assert.equal(c3.isFomoPumpPost, false);
    assert.equal(c3.decision, 'keep');

    // smart activity 帖（含 @handle + **$** 标题）→ fomo pump，默认 thesis
    const smartPost =
      '**$TOKEN**** smart activity** **Wizard Of SoHo (🍷,🍷)** (@wizardofsoho)\n\nSmart followers: 1530\n';
    const c4 = classifyFomoChannelPost(smartPost);
    assert.equal(c4.isFomoPumpPost, true);
    assert.equal(c4.kind, 'thesis');
    assert.equal(c4.traderHandle, 'wizardofsoho');

    // 普通社媒帖含 @handle 但标题非 **$** 开头（如 jiuyicall [yry] 格式）→ 不误判
    const jiuyicallPost = '[yry]\n🟢 Buy more ETH\nToken: 12345 [TSMI]';
    const c5 = classifyFomoChannelPost(jiuyicallPost);
    assert.equal(c5.isFomoPumpPost, false, 'non-fomo formatted post should not be fomo pump');

    // --- 归属 ---
    // 先建一个"关注的人"
    const db = getDb();
    const now = Date.now();
    const insertUser = db.prepare(
      `INSERT INTO tracked_users (id, name, handle, avatar, tags_json, total_asset_usd, historical_max_asset_usd, created_at, updated_at, monitoring_enabled, twitter)
       VALUES (?, ?, ?, '', '[]', 0, 0, ?, ?, 1, ?)`
    );
    insertUser.run('u-frank', 'Frank', 'frank', now, now, 'frankdegods');

    // 不匹配 handle → 归 fomo（thesis）
    const res1 = resolveFomoAttributionUser({ classification: c1 });
    assert.ok(res1.user, 'unmatched thesis should be kept');
    assert.equal(res1.user!.name, 'fomo');
    assert.equal(res1.user!.handle, 'fomo');

    // 不匹配 handle → 交易丢弃
    const res2 = resolveFomoAttributionUser({ classification: c2 });
    assert.equal(res2.user, null, 'unmatched trade should be dropped');

    // 匹配到关注的人 → 归属本人
    const frankPost =
      '**$FRANK thesis** **Frank** (@frankdegods)\n\nBullish on RWA.\nPosition: **$5,000**\ngmgn · fomo';
    const cf = classifyFomoChannelPost(frankPost);
    assert.equal(cf.traderHandle, 'frankdegods');
    assert.equal(matchTrackedUserByHandle('frankdegods')?.id, 'u-frank');
    const resF = resolveFomoAttributionUser({ classification: cf });
    assert.ok(resF.user);
    assert.equal(resF.user!.name, 'Frank', 'matched trader should be attributed to themselves');
    assert.equal(resF.user!.id, 'u-frank');

    // 匹配到关注的人 + 交易 → 也归属本人（全收）
    const frankSell =
      '**$FRANK sell** **Frank** (@frankdegods)\n\nProceeds: **$1,000**\nRealized PnL: **+50%**\ngmgn · fomo';
    const cfSell = classifyFomoChannelPost(frankSell);
    const resFS = resolveFomoAttributionUser({ classification: cfSell });
    assert.ok(resFS.user);
    assert.equal(resFS.user!.name, 'Frank', 'matched trader trade should also stay with them');

    // fomo user 幂等
    assert.equal(getOrCreateFomoUser().name, 'fomo');
    assert.equal(getOrCreateFomoUser().name, 'fomo');

    // non-fomo 帖 resolve 返回 user=null 表示"仅标记，归属走原逻辑"
    const res3 = resolveFomoAttributionUser({ classification: c3 });
    assert.equal(res3.user, null);

    console.log('OK fomo-channel-attribution');
  } finally {
    if (previousDbPath === undefined) delete process.env.PILIPILI_DB_PATH;
    else process.env.PILIPILI_DB_PATH = previousDbPath;
    if (previousDataDir === undefined) delete process.env.PILIPILI_DATA_DIR;
    else process.env.PILIPILI_DATA_DIR = previousDataDir;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
