/**
 * 死信告警聚合回归（2026-10-06 事故）。
 *
 * 事故：442 个钱包在 1 分钟内进死信 → 434 条同题 Bark 刷屏，真正的事故信息被淹没。
 * 修复：窗口内累计的进死信事件聚合成一条摘要推送。
 *
 * 本测试断言：
 *   1. N 个钱包进死信只产生 1 条 Bark（而非 N 条）
 *   2. 摘要含钱包总数、链路分布、样本、首错原因
 *   3. 窗口结束后状态复位，下一批能再发一条
 *   4. body 长度不超 Bark 上限（500）
 *
 * 运行：NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' \
 *       ./node_modules/.bin/tsx scripts/test-deadletter-alert-digest.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

const MAX_BODY_LENGTH = 500;

type CapturedPush = { title: string; body: string; group?: string; level?: string };

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-deadletter-digest-'));
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousBarkUrls = process.env.PILI_BARK_URLS;

  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');
  // 指向一个必然失败的假地址，避免测试真的推到 Finn 手机。
  process.env.PILI_BARK_URLS = 'https://127.0.0.1:1/unreachable-bark-test';
  // 窗口压到最小，测试不用真等 5 分钟。
  process.env.HOLDINGS_DEAD_LETTER_ALERT_WINDOW_MS = '10000';
  // 关掉「最小刷新间隔」闸门，否则种子轮写入的 last_success_at_ms 会
  // 让钱包在窗口内无法被再次 claim（测试里时间不流逝，会卡住一个 job）。
  process.env.HOLDINGS_MIN_REFRESH_AGE_MS = '0';

  try {
    const { getDb } = await import('@/lib/server/sqlite');
    const { createTrackedUser } = await import('@/lib/server/trackedUsersRepo');
    const { runHoldingsRefreshQueueCycle, flushDeadLetterAlertsForTests } = await import(
      '@/lib/server/holdingsRefreshQueue'
    );

    const db = getDb();

    // 建表用的空跑 provider（不产生死信）。
    const alwaysFailSeed = async () => ({
      status: 'idle' as const,
      chain: null,
      holdingsRowCount: 0,
      filteredOutHoldingCount: 0,
      totalAssetUsd: null,
      lastError: null,
    });

    // 拦截 pushBark：holdingsRefreshQueue 通过 barkNotify 模块调用，
    // 用 fetch 层拦截最稳（barkNotify 内部走 globalThis.fetch）。
    // barkNotify 用 GET + query params 发送（不是 POST body），所以拦截后从 URL 解析。
    const captured: CapturedPush[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const urlStr = typeof input === 'string' ? input : input?.url ?? String(input);
      if (urlStr.includes('unreachable-bark-test')) {
        const u = new URL(urlStr);
        const title = decodeURIComponent(u.pathname.split('/').pop() ?? '');
        captured.push({
          title,
          body: u.searchParams.get('body') ?? '',
          group: u.searchParams.get('group') ?? undefined,
          level: u.searchParams.get('level') ?? undefined,
        });
        return new Response(JSON.stringify({ code: 200 }), { status: 200 });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    // 24 个钱包（12 solana + 12 evm），全部喂到死信阈值。
    const TOTAL_WALLETS = 24;
    const wallets: Array<{ walletChain: string; address: string; chain: string }> = [];
    for (let i = 0; i < TOTAL_WALLETS; i += 1) {
      const isEvm = i % 2 === 0;
      // EVM = 0x + 40 hex；solana = base58 [1-9A-HJ-NP-Za-km-z]（不含 0）。
      // 后缀直接取 1-9 两位组合（11..19,21..29,31..39），两字母表都合法且唯一。
      const hi = Math.floor(i / 9) + 1; // 1,2,3
      const lo = (i % 9) + 1; // 1..9
      const suffix = `${hi}${lo}`;
      const address = isEvm
        ? `0x${'a'.repeat(38)}${suffix}`
        : `So${'b'.repeat(38)}${suffix}`;
      wallets.push({
        walletChain: `${isEvm ? 'evm' : 'solana'}:${address.toLowerCase()}`,
        address,
        chain: isEvm ? 'evm' : 'solana',
      });
    }

    for (const w of wallets) {
      createTrackedUser({
        name: `dl-${w.address.slice(0, 6)}`,
        handle: `dl-${w.address.slice(0, 10).toLowerCase()}`,
        avatar: 'dl.png',
        tags: [],
        addresses: [
          {
            address: w.address,
            name: '#1',
            chain: w.chain as never,
            totalAssetUsd: 0,
            assetUpdatedAt: 0,
          },
        ],
        totalAssetUsd: 0,
        historicalMaxAssetUsd: 0,
        mainstreamAssetUsd: 0,
        assetUpdatedAt: 0,
        twitter: undefined,
        telegram: undefined,
      } as never);
    }

    // 表由队列首轮惰性创建；先跑一轮让 ensurePersistentQueue 建表。
    await runHoldingsRefreshQueueCycle({ db, refreshWallet: alwaysFailSeed as never });

    // 直接把 jobs 推到 attempts = 阈值-1，让下一轮失败即进死信。
    for (const w of wallets) {
      db.prepare(
        `INSERT INTO holdings_refresh_jobs
           (wallet_chain, address, chain, user_id, priority, due_at_ms, attempts,
            rerun_requested, last_success_at_ms, last_error, updated_at_ms, status)
         VALUES (?, ?, ?, 'test-user', 100, 0, 9, 0, NULL, NULL, 0, 'active')
         ON CONFLICT(wallet_chain) DO UPDATE SET
           attempts = 9, due_at_ms = 0, status = 'active',
           lease_token = NULL, lease_until_ms = NULL, last_error = NULL`
      ).run(w.walletChain, w.address, w.chain);
    }

    // 让 refreshWallet 恒定失败 → 每个钱包 attempts 9→10 → 进死信。
    const alwaysFail = async () => ({
      status: 'error' as const,
      chain: null,
      holdingsRowCount: 0,
      filteredOutHoldingCount: 0,
      totalAssetUsd: null,
      lastError: 'OKX 网络错误: fetch failed',
    });

    // 每轮只处理 1 个 job，多跑几轮确保全部钱包都到死信阈值。
    for (let i = 0; i < TOTAL_WALLETS + 3; i += 1) {
      await runHoldingsRefreshQueueCycle({
        db,
        refreshWallet: alwaysFail as never,
        now: () => Date.now(),
      });
    }

    const dead = db
      .prepare(`SELECT COUNT(*) AS n FROM holdings_refresh_jobs WHERE status = 'dead_letter'`)
      .get() as { n: number };
    if (dead.n !== TOTAL_WALLETS) {
      const leftover = db
        .prepare(
          `SELECT wallet_chain, attempts, status, lease_token IS NOT NULL AS leased, due_at_ms
           FROM holdings_refresh_jobs WHERE status != 'dead_letter'`
        )
        .all();
      console.error('LEFTOVER ROWS:', JSON.stringify(leftover, null, 1));
      console.error('TOTAL ROWS:', JSON.stringify(db.prepare(`SELECT COUNT(*) n FROM holdings_refresh_jobs`).get()));
    }
    assert.equal(dead.n, TOTAL_WALLETS, `all ${TOTAL_WALLETS} wallets should be dead-lettered`);

    // 关键断言：窗口未到期前，一条 Bark 都不该发。
    assert.equal(
      captured.length,
      0,
      `no Bark before the aggregation window closes (got ${captured.length})`
    );

    // 冲掉聚合窗口 → 应该只发 1 条摘要。
    flushDeadLetterAlertsForTests(db);
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(
      captured.length,
      1,
      `N wallets must yield exactly 1 aggregated Bark, got ${captured.length}`
    );

    const push = captured[0]!;
    assert.match(push.title, /24/, `title should carry the wallet count: ${push.title}`);
    assert.match(push.body, /24 个钱包进死信/, `body should state total count: ${push.body}`);
    assert.match(push.body, /solana 12/, `body should break down by chain: ${push.body}`);
    assert.match(push.body, /evm 12/, `body should break down by chain: ${push.body}`);
    assert.match(push.body, /首错：/, `body should include the first error: ${push.body}`);
    assert.equal(push.group, '运维');
    assert.equal(push.level, 'timeSensitive');
    assert.ok(
      push.body.length <= MAX_BODY_LENGTH,
      `body must stay under ${MAX_BODY_LENGTH} chars, got ${push.body.length}`
    );
    assert.ok(
      push.body.length > 0,
      'body must not be truncated to empty'
    );

    // 窗口复位后，下一批应能再发一条（不是被永久静音）。
    db.prepare(`UPDATE holdings_refresh_jobs SET status='active', attempts=9`).run();
    for (let i = 0; i < 6; i += 1) {
      await runHoldingsRefreshQueueCycle({
        db,
        refreshWallet: alwaysFail as never,
        now: () => Date.now(),
      });
    }
    flushDeadLetterAlertsForTests(db);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      captured.length,
      2,
      `a later burst must still alert (expected 2 total, got ${captured.length})`
    );
    // 第二波处理了几个就报几个（这里不硬编码数量，只验证它确实重新开始聚合）。
    assert.match(
      captured[1]!.body,
      /\d+ 个钱包进死信/,
      `second digest should report its own count: ${captured[1]!.body}`
    );
    assert.ok(
      !/24 个钱包进死信/.test(captured[1]!.body),
      'second digest must not re-report the first burst'
    );

    globalThis.fetch = realFetch;

    console.log('✅ dead-letter alert digest: all assertions passed');
    console.log(`   burst of ${TOTAL_WALLETS} wallets → ${captured.length - 1} aggregated Bark (was ${TOTAL_WALLETS})`);
    console.log(`   sample body: ${captured[0]!.body}`);
  } finally {
    process.env.PILIPILI_DATA_DIR = previousDataDir;
    process.env.PILIPILI_DB_PATH = previousDbPath;
    if (previousBarkUrls === undefined) delete process.env.PILI_BARK_URLS;
    else process.env.PILI_BARK_URLS = previousBarkUrls;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('❌ dead-letter alert digest test failed');
  console.error(error);
  process.exitCode = 1;
});
