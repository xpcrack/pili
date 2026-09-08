import assert from 'node:assert/strict';

import { createTelegramBotApiClient } from '@/lib/server/telegramBotApi';

function makeNetworkError(code: string, message: string): Error {
  const err = new Error('fetch failed');
  (err as { cause?: unknown }).cause = { code, message };
  return err;
}

async function main() {
  const dispatcher = { kind: 'proxy-agent' };
  let requestedUrl = '';
  let requestedInit: Record<string, unknown> | undefined;
  const client = createTelegramBotApiClient({
    token: 'test-token',
    proxyUrl: 'http://127.0.0.1:7897',
    createProxyAgent: (proxyUrl) => {
      assert.equal(proxyUrl, 'http://127.0.0.1:7897');
      return dispatcher as never;
    },
    fetchImpl: async (url, init) => {
      requestedUrl = String(url);
      requestedInit = init as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true, result: { id: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const result = await client<{ id: number }>('getMe');
  assert.equal(result.id, 1);
  assert.equal(requestedUrl, 'https://api.telegram.org/bottest-token/getMe');
  assert.equal(requestedInit?.dispatcher, dispatcher);
  assert.ok(requestedInit?.signal instanceof AbortSignal);

  // 网络错误（ECONNRESET，Clash 切节点后的典型症状）应重建代理并重试成功。
  // 回归场景：8/12 起 bridge 的共享 ProxyAgent 连接池残留死连接，
  // 每次都取死连接 → 永远 ECONNRESET；手动新建 ProxyAgent 却能通。
  {
    let calls = 0;
    let agentCreates = 0;
    const retryClient = createTelegramBotApiClient({
      token: 'test-token',
      proxyUrl: 'http://127.0.0.1:7897',
      createProxyAgent: () => {
        agentCreates += 1;
        return { kind: 'proxy-agent', id: agentCreates } as never;
      },
      fetchImpl: async (_url, init) => {
        calls += 1;
        if (calls === 1) {
          throw makeNetworkError('ECONNRESET', 'Client network socket disconnected before secure TLS connection was established');
        }
        assert.ok(init?.dispatcher, '重试应携带新代理');
        return new Response(JSON.stringify({ ok: true, result: { update_id: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const retryResult = await retryClient<{ update_id: number }>('getUpdates');
    assert.equal(retryResult.update_id, 1);
    assert.ok(calls >= 2, '网络错误应重试');
    assert.ok(agentCreates >= 2, '网络错误后应重建代理');
  }

  // 连续网络错误超过 maxAttempts → 抛 network failed。
  {
    let calls = 0;
    const failClient = createTelegramBotApiClient({
      token: 'test-token',
      proxyUrl: 'http://127.0.0.1:7897',
      maxAttempts: 2,
      createProxyAgent: () => ({ kind: 'proxy-agent' }) as never,
      fetchImpl: async () => {
        calls += 1;
        throw makeNetworkError('ECONNRESET', 'socket reset');
      },
    });
    await assert.rejects(
      () => failClient('getUpdates'),
      /Telegram getUpdates network failed/,
      '超出重试次数应抛 network failed'
    );
    assert.equal(calls, 2, 'maxAttempts=2 应恰好尝试 2 次');
  }

  // 业务错误（409 Conflict）不重试，直接抛。
  {
    let calls = 0;
    const conflictClient = createTelegramBotApiClient({
      token: 'test-token',
      proxyUrl: 'http://127.0.0.1:7897',
      maxAttempts: 3,
      createProxyAgent: () => ({ kind: 'proxy-agent' }) as never,
      fetchImpl: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ ok: false, description: 'Conflict: terminated by other getUpdates request' }),
          { status: 409, headers: { 'content-type': 'application/json' } }
        );
      },
    });
    await assert.rejects(
      () => conflictClient('getUpdates'),
      /Telegram getUpdates failed: 409/,
      '409 是业务错误，不应重试'
    );
    assert.equal(calls, 1, '业务错误不应重试');
  }

  // 代理池 failover：第一根代理抽风 → 重建代理到池中第二个并成功。
  // 2026-09-08 补：bridge 由单一 7897 改为代理池后应自动切代理。
  {
    const agentLog: string[] = [];
    let calls = 0;
    const failoverClient = createTelegramBotApiClient({
      token: 'test-token',
      proxyUrl: ['http://127.0.0.1:7897', 'http://127.0.0.1:17890'],
      maxAttempts: 3,
      createProxyAgent: (url) => {
        agentLog.push(url);
        return { kind: 'proxy-agent', url } as never;
      },
      fetchImpl: async (_url, init) => {
        calls += 1;
        const current = agentLog[agentLog.length - 1];
        if (current === 'http://127.0.0.1:7897') {
          throw makeNetworkError('ECONNRESET', 'Client network socket disconnected before secure TLS connection was established');
        }
        assert.ok(init?.dispatcher, '切到新代理后应携带新 dispatcher');
        return new Response(JSON.stringify({ ok: true, result: { update_id: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const retryResult = await failoverClient<{ update_id: number }>('getUpdates');
    assert.equal(retryResult.update_id, 1);
    assert.ok(agentLog.includes('http://127.0.0.1:7897'), '应轮过第一根代理');
    assert.ok(agentLog.includes('http://127.0.0.1:17890'), '应切到第二根代理');
    assert.ok(calls >= 2, '网络错误后应重试');
  }

  console.log('telegram bot api tests: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
