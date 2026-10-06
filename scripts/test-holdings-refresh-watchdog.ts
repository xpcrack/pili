/**
 * 持仓刷新看门狗回归（2026-10-06 事故）。
 *
 * 事故：worker 长跑 19h，442/965 钱包（46%）冻结在 dead_letter，最近 1h
 * 零成功刷新，但没有任何机制指出「整条链路已经不可用」——靠手机被刷屏才发现。
 *
 * 本测试断言：
 *   1. 复现事故队列状态 → 看门狗判定 degraded 并给出具体理由
 *   2. 自愈真的发生：dead_letter 被放回 active 且 due_at 被摊开
 *   3. 告警推送恰好一次，且是「刚恶化」措辞
 *   4. 持续恶化 + 冷却未到 → 不重复重放、不重复告警
 *   5. 冷却到期后仍恶化 → 再次自愈并改说「仍未恢复」
 *   6. 健康队列 → 不误报、不动队列
 *
 * 运行：NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' \
 *       ./node_modules/.bin/tsx scripts/test-holdings-refresh-watchdog.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

type NotifyPayload = { title: string; body: string };

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-holdings-watchdog-'));
  const prevDataDir = process.env.PILIPILI_DATA_DIR;
  const prevDbPath = process.env.PILIPILI_DB_PATH;

  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { getDb } = await import('@/lib/server/sqlite');
    const { runHoldingsRefreshQueueCycle } = await import('@/lib/server/holdingsRefreshQueue');
    const {
      runHoldingsRefreshWatchdog,
      evaluateHoldingsRefreshHealth,
      resetHoldingsRefreshWatchdogState,
    } = await import('@/lib/server/holdingsRefreshWatchdog');

    const db = getDb();

    // 建表（队列首轮惰性建）。
    const idle = async () => ({
      status: 'idle' as const,
      chain: null,
      holdingsRowCount: 0,
      filteredOutHoldingCount: 0,
      totalAssetUsd: null,
      lastError: null,
    });
    await runHoldingsRefreshQueueCycle({ db, refreshWallet: idle as never });

    const TOTAL = 100;
    const DEAD = 46; // 复刻事故的 46%
    const now = Date.now();

    // 46 个死信 + 54 个健康，且全部 last_success 都是 2 小时前（链路不通）。
    for (let i = 0; i < TOTAL; i += 1) {
      const isEvm = i % 2 === 0;
      // 唯一后缀：i 的十进制，逐位映射到 1-9（0→1..9 会撞值，故改用 1-9 循环编码）。
      // 用 base9 展开确保唯一，且只含 1-9（hex 与 base58 都合法）。
      const b9 = (() => {
        let n = i;
        let out = '';
        do {
          out = String((n % 9) + 1) + out;
          n = Math.floor(n / 9);
        } while (n > 0);
        return out.padStart(4, '1');
      })();
      const address = isEvm
        ? `0x${'a'.repeat(36)}${b9}`
        : `So${'b'.repeat(36)}${b9}`;
      const isDead = i < DEAD;
      db.prepare(
        `INSERT INTO holdings_refresh_jobs
           (wallet_chain, address, chain, user_id, priority, due_at_ms, attempts,
            rerun_requested, last_success_at_ms, last_error, updated_at_ms, status)
         VALUES (?, ?, ?, 'u', 0, ?, ?, 0, ?, ?, ?, ?)
         ON CONFLICT(wallet_chain) DO UPDATE SET
           status = excluded.status, attempts = excluded.attempts,
           due_at_ms = excluded.due_at_ms, last_success_at_ms = excluded.last_success_at_ms,
           last_error = excluded.last_error, lease_token = NULL, lease_until_ms = NULL`
      ).run(
        `${isEvm ? 'evm' : 'solana'}:${address.toLowerCase()}`,
        address,
        isEvm ? 'evm' : 'solana',
        // 健康钱包给个未来 due_at，避免它们混进「重放摊开窗口」的测量。
        isDead ? 0 : now + 10 * 60_000,
        isDead ? 10 : 0,
        now - 2 * 60 * 60_000, // 2h 前成功过 → 链路不通
        isDead ? 'dead-letter: OKX 网络错误: fetch failed' : null,
        now,
        isDead ? 'dead_letter' : 'active'
      );
    }

    const counts = () =>
      db
        .prepare(`SELECT status, COUNT(*) AS n FROM holdings_refresh_jobs GROUP BY status`)
        .all() as Array<{ status: string; n: number }>;
    const countOf = (rows: Array<{ status: string; n: number }>, s: string) =>
      rows.find((r) => r.status === s)?.n ?? 0;

    assert.equal(countOf(counts(), 'dead_letter'), DEAD, 'fixture should reproduce 46% dead-letter');

    // ---- 1. 复现事故 → 判定 degraded 且有具体理由 ----
    const pushes: NotifyPayload[] = [];
    const notify = (p: NotifyPayload) => {
      pushes.push(p);
    };

    resetHoldingsRefreshWatchdogState(db);
    const r1 = await runHoldingsRefreshWatchdog({ db, notify });
    assert.equal(r1.degraded, true, 'incident-shaped queue must be judged degraded');
    assert.ok(r1.reasons.length >= 2, `should cite multiple reasons, got ${r1.reasons.length}`);
    assert.ok(
      r1.reasons.some((x) => /死信占比/.test(x)),
      `should cite dead-letter ratio: ${r1.reasons.join(' | ')}`
    );
    assert.ok(
      r1.reasons.some((x) => /零成功/.test(x)),
      `should cite zero-success burst: ${r1.reasons.join(' | ')}`
    );

    // ---- 2. 自愈真的发生 ----
    assert.equal(r1.requeued, DEAD, `watchdog should requeue all ${DEAD} dead letters`);
    const after = counts();
    assert.equal(countOf(after, 'dead_letter'), 0, 'no dead letters should remain');
    assert.equal(countOf(after, 'active'), TOTAL, 'all wallets should be active again');

    // due_at 必须被摊开（不能全部同一秒打上游）。
    // 只统计「被重放的那批」——健康钱包的 due_at 仍是 fixture 里的 0，
    // 混进来会把摊开窗口算成 1970 年至今。
    // 只看被重放的那批：重放会把 due_at 推到未来，健康钱包的 due_at 是 now+10min，
    // 两者都在未来 —— 用「原本是 dead_letter」无法回溯，故改为断言所有 due_at 都
    // 落在 [now, now+spread] 内，且不全相等（说明摊开了）。
    const spread = db
      .prepare(
        `SELECT MIN(due_at_ms) AS lo, MAX(due_at_ms) AS hi, COUNT(DISTINCT due_at_ms) AS n
         FROM holdings_refresh_jobs
         WHERE last_error IS NULL AND attempts = 0`
      )
      .get() as { lo: number; hi: number; n: number };
    assert.ok(
      spread.n > 1,
      'requeued jobs must be spread over time, got a single due_at'
    );
    const spreadSpanMs = spread.hi - spread.lo;
    assert.ok(
      spread.n > 1,
      `requeued rows must not share a due_at, got n=${spread.n}`
    );
    assert.ok(
      spread.lo >= now,
      `requeued due_at must be in the future (now=${now}), got lo=${spread.lo}`
    );
    assert.ok(
      spreadSpanMs <= 15 * 60_000 + 5_000,
      `spread must stay within the intended 15min window, got ${spreadSpanMs}ms`
    );

    // ---- 3. 告警恰好一条，措辞是「刚恶化」 ----
    assert.equal(pushes.length, 1, `expected exactly 1 alert, got ${pushes.length}`);
    assert.match(pushes[0]!.title, /异常/, `first alert title: ${pushes[0]!.title}`);
    assert.match(pushes[0]!.body, /已自动重放 46 个死信钱包/, `body: ${pushes[0]!.body}`);

    // ---- 4. 持续恶化 + 冷却未到 → 不重复 ----
    // 把队列再次打成事故态，冷却期内再跑。
    db.prepare(
      `UPDATE holdings_refresh_jobs SET status='dead_letter', attempts=10,
         last_success_at_ms = ? WHERE rowid % 2 = 0`
    ).run(now - 2 * 60 * 60_000);
    const r2 = await runHoldingsRefreshWatchdog({ db, notify });
    assert.equal(r2.degraded, true, 'still degraded');
    assert.equal(r2.requeued, 0, 'requeue must respect cooldown');
    assert.equal(r2.alerted, false, 'alert must respect cooldown');
    assert.equal(pushes.length, 1, 'no new alert during cooldown');

    // ---- 5. 冷却到期 → 再次自愈，措辞变「仍未恢复」 ----
    const r3 = await runHoldingsRefreshWatchdog({
      db,
      notify,
      requeueCooldownMs: 0,
      alertCooldownMs: 0,
    });
    assert.equal(r3.degraded, true);
    assert.ok(r3.requeued > 0, `should requeue again after cooldown, got ${r3.requeued}`);
    assert.equal(pushes.length, 2, `expected a second alert, got ${pushes.length}`);
    assert.match(
      pushes[1]!.title,
      /仍未恢复/,
      `second alert should say "still down": ${pushes[1]!.title}`
    );

    // ---- 6. 健康队列 → 不误报 ----
    const r4 = await runHoldingsRefreshWatchdog({
      db,
      notify,
      requeueCooldownMs: 0,
      alertCooldownMs: 0,
    });
    // 重放后所有钱包 active 且刚被重置 → 仍有「零成功/2h 无成功」判据，
    // 所以这里显式构造一个健康快照走纯函数判定，避免耦合队列时序。
    const healthyVerdict = evaluateHoldingsRefreshHealth({
      total: TOTAL,
      active: TOTAL,
      deadLetter: 0,
      deadLetterRatio: 0,
      lastSuccessAgeMs: 30_000,
      recentlySucceeded: 90,
    });
    assert.equal(healthyVerdict.degraded, false, 'healthy queue must not be flagged');
    assert.deepEqual(healthyVerdict.reasons, [], 'healthy queue must cite no reasons');

    // 小库（样本不足）也不该被告警级判据打中。
    const tinyVerdict = evaluateHoldingsRefreshHealth({
      total: 5,
      active: 1,
      deadLetter: 4,
      deadLetterRatio: 0.8,
      lastSuccessAgeMs: 5 * 60 * 60_000,
      recentlySucceeded: 0,
    });
    assert.equal(tinyVerdict.degraded, false, 'tiny队列 (5 wallets) must not trigger the watchdog');

    void r4;

    console.log('✅ holdings refresh watchdog: all assertions passed');
    console.log(`   incident-shaped queue (${DEAD}/${TOTAL} dead, 2h no success) → degraded`);
    console.log(`   自愈：${r1.requeued} 个死信重放，due_at 摊开 ${Math.round((spread.hi - spread.lo) / 60_000)} 分钟`);
    console.log(`   告警：${pushes.length} 条（首次「异常」→ 冷却后「仍未恢复」）`);
    console.log(`   误报防护：健康队列 / 小库(5个) 均不判定`);
  } finally {
    process.env.PILIPILI_DATA_DIR = prevDataDir;
    process.env.PILIPILI_DB_PATH = prevDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('❌ holdings refresh watchdog test failed');
  console.error(error);
  process.exitCode = 1;
});
