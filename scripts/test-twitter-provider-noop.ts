/**
 * TWITTER_FETCH_PROVIDER=noop 回归测试（2026-10-07 事故后修复）。
 *
 * 事故：.env.local 设 TWITTER_FETCH_PROVIDER=noop 想停掉推特直抓，但
 * normalizeRealProviderMode 的白名单里没有 'noop' → 静默降级成 'auto'
 * → 只是回到 6551→xread 路由，opencli 那条路根本没被堵住（当时侥幸没触发
 * 是因为 6551 key 被注释 + xread 挂了）。本次修复让 'noop' 成为一等公民，
 * 且在 fetchUserTweets / fetchTweetsByIds 两个入口短路，不碰任何 provider。
 *
 * 本测试断言：
 *   1. 'noop' 解析为 'noop'（不是 'auto'）—— 直接跑 normalize 的等价逻辑
 *   2. noop 模式下 fetchUserTweets 返回空 + provider='noop'，且零 provider 调用
 *   3. noop 模式下 fetchTweetsByIds 同样零调用
 *   4. 对照组：'auto' 模式下 provider 会被调用（证明短路不是「什么都不做」的假象）
 *
 * 运行：NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' \
 *       ./node_modules/.bin/tsx scripts/test-twitter-provider-noop.ts
 */
import assert from 'node:assert/strict';

import './server-only-shim.cjs';

async function run() {
  // ── 1. 白名单：'noop' 必须原样通过 ───────────────────────────────
  // normalizeRealProviderMode 未 export，用 createTwitterFetcher 的行为间接验证：
  // 在 noop 下 provider 路由必须完全不被走到。
  const { createTwitterFetcher } = await import('../lib/server/twitterFetcher');

  // routeChooser 是所有 structured provider（6551/xread）的必经入口，
  // 也是 fetchUserTweets 里第一批被调用的依赖 —— 用它当「有没有走到 provider
  // 路由」的探针最干净（不必伪造客户端内部形状）。
  function makeSpyDeps(label: string) {
    const calls: string[] = [];
    const routeChooser = ((input: unknown) => {
      calls.push(`${label}:routeChooser`);
      // 返回空 provider 列表 = 无可用 provider，调用方自然回落到 noop，
      // 不会真的去打网络。重点是「有没有被调用」。
      return { primaryProvider: null, orderedProviders: [] };
    }) as never;
    return { calls, deps: { routeChooser } };
  }

  // ── 2. noop 模式：两个入口都零调用 ───────────────────────────────
  process.env.TWITTER_FETCH_PROVIDER = 'noop';
  {
    const { calls, deps } = makeSpyDeps('noop');
    const fetcher = createTwitterFetcher(undefined, deps);
    const byHandle = await fetcher.fetchUserTweets({
      handle: 'somebody',
      lane: 'timeline',
      sinceMs: 0,
      maxItems: 10,
    });
    assert.equal(byHandle.provider, 'noop', 'noop 模式 fetchUserTweets 应返回 provider=noop');
    assert.deepEqual(byHandle.tweets, [], 'noop 模式不应返回推文');
    assert.deepEqual(calls, [], `noop 模式不应进入 provider 路由，实际: ${calls.join(',')}`);

    const byIds = await fetcher.fetchTweetsByIds({ ids: ['1234567890', '9876543210'] });
    assert.equal(byIds.provider, 'noop', 'noop 模式 fetchTweetsByIds 应返回 provider=noop');
    assert.deepEqual(byIds.tweets, [], 'noop 模式按 id 不应返回推文');
    assert.deepEqual(calls, [], `noop 模式按 id 不应进入 provider 路由，实际: ${calls.join(',')}`);
  }

  // ── 3. 对照组：auto 模式必须真的去调 provider ────────────────────
  // 否则「零调用」可能只是因为我没构造出会调用的场景（假绿）。
  process.env.TWITTER_FETCH_PROVIDER = 'auto';
  {
    const { calls, deps } = makeSpyDeps('auto');
    const fetcher = createTwitterFetcher(undefined, deps);
    await fetcher.fetchUserTweets({
      handle: 'somebody',
      lane: 'timeline',
      sinceMs: 0,
      maxItems: 10,
    }).catch(() => undefined);
    assert.ok(
      calls.length > 0,
      'auto 模式必须调用 provider（否则上面的「零调用」断言无意义）'
    );
  }

  // ── 4. 非法值仍降级 auto（保持既有语义）─────────────────────────
  process.env.TWITTER_FETCH_PROVIDER = 'definitely-not-a-provider';
  {
    const { calls, deps } = makeSpyDeps('bogus');
    const fetcher = createTwitterFetcher(undefined, deps);
    await fetcher.fetchUserTweets({
      handle: 'somebody',
      lane: 'timeline',
      sinceMs: 0,
      maxItems: 10,
    }).catch(() => undefined);
    assert.ok(calls.length > 0, '未知 provider 值仍应降级为 auto（调 provider）');
  }

  console.log('ok: TWITTER_FETCH_PROVIDER=noop 短路生效（两个入口零 provider 调用）；auto/非法值仍正常路由');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
