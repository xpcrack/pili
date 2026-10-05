import assert from 'node:assert/strict';

import './server-only-shim.cjs';

/**
 * ensurePrimaryPoolForAddress 必须走 newone ingest API（POST /api/events,
 * social.mention），不得直写 newone sqlite（漂移事故根因）。这里 mock fetch 验证
 * 请求形状与四种返回映射：入池 / 黑名单拒绝 / 已在池 / HTTP 与网络失败。
 */
async function main() {
  const {
    ensurePrimaryPoolForAddress,
    resolveNewoneApiBase,
    clearPrimaryPoolSymbolCache,
  } = await import('../lib/server/primaryPoolSymbols');

  type CapturedCall = {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  };
  let calls: CapturedCall[] = [];
  let responder: (call: CapturedCall) => Response | Promise<Response> = () =>
    new Response('{"results":[]}', { status: 500 });
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.NEWONE_API_TOKEN;
  const originalBase = process.env.NEWONE_API_BASE_URL;
  delete process.env.NEWONE_API_TOKEN;
  delete process.env.NEWONE_API_BASE_URL;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of new Headers(init.headers as HeadersInit).entries()) {
        headers[k] = v;
      }
    }
    const call: CapturedCall = {
      url,
      method: init?.method || 'GET',
      headers,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;

  try {
    // --- resolveNewoneApiBase: 默认本机 + env 可配 ---
    assert.equal(resolveNewoneApiBase(), 'http://127.0.0.1:3200');
    process.env.NEWONE_API_BASE_URL = 'http://10.0.0.9:3200/';
    assert.equal(resolveNewoneApiBase(), 'http://10.0.0.9:3200');
    delete process.env.NEWONE_API_BASE_URL;

    // --- 空地址：不发起任何请求 ---
    clearPrimaryPoolSymbolCache();
    calls = [];
    const empty = await ensurePrimaryPoolForAddress({ address: '' });
    assert.deepEqual(empty, { ok: false, entered: false, error: 'empty_address' });
    assert.equal(calls.length, 0);

    // --- 入池成功：social.mention 事件形状 + tokenId 映射 ---
    clearPrimaryPoolSymbolCache();
    calls = [];
    responder = () =>
      new Response(
        JSON.stringify({
          results: [
            {
              event_id: 1,
              token_id: 555,
              duplicate: false,
              pool_entered: true,
              pool_membership_id: 123,
            },
          ],
        }),
        { status: 201 },
      );
    const entered = await ensurePrimaryPoolForAddress({
      address: 'So11111111111111111111111111111111111111112',
      symbol: 'TEST',
      reason: 'telegram_ca_mention',
    });
    assert.deepEqual(entered, { ok: true, entered: true, tokenId: 555 });
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, 'http://127.0.0.1:3200/api/events');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.equal(call.body.event_type, 'social.mention');
    assert.equal(call.body.chain, 'solana');
    assert.equal(call.body.token_address, 'So11111111111111111111111111111111111111112');
    assert.equal(call.body.symbol, 'TEST');
    assert.equal(typeof call.body.occurred_at, 'string');
    // dedupe_key is hour-bucketed (YYYY-MM-DDTHH) so later mentions are new events.
    const hourBucket = new Date().toISOString().slice(0, 13);
    assert.equal(
      call.body.dedupe_key,
      `social.mention:solana:so11111111111111111111111111111111111111112:telegram_ca_mention:${hourBucket}`,
    );

    // --- 永久删除黑名单：membership_id=0 → 保留原错误码 ---
    responder = () =>
      new Response(
        JSON.stringify({
          results: [
            {
              event_id: 2,
              token_id: 19010490,
              duplicate: false,
              pool_entered: false,
              pool_membership_id: 0,
            },
          ],
        }),
        { status: 201 },
      );
    const blocked = await ensurePrimaryPoolForAddress({
      address: 'pumpcmxqmfrsakq5r49wcjnrayyrqmxz6ae8h7h9dfn',
      reason: 'telegram_ca_mention',
    });
    assert.deepEqual(blocked, {
      ok: true,
      entered: false,
      error: 'permanent_delete_blocked',
    });

    // --- 已在池中：entered=false 且 membership_id>0 ---
    responder = () =>
      new Response(
        JSON.stringify({
          results: [
            {
              event_id: 3,
              token_id: 777,
              duplicate: true,
              pool_entered: false,
              pool_membership_id: 23271,
            },
          ],
        }),
        { status: 201 },
      );
    const already = await ensurePrimaryPoolForAddress({
      address: '0xabc',
      chain: 'bsc',
      reason: 'social_ca_mention',
    });
    assert.deepEqual(already, { ok: true, entered: false, tokenId: 777 });
    // caller 给了 chain 就不解析（0x 直传 bsc）
    assert.equal(calls[calls.length - 1]!.body.chain, 'bsc');

    // --- API 侧事件校验失败：results[].error → ok:false ---
    responder = () =>
      new Response(
        JSON.stringify({
          results: [
            { error: 'token_address, dedupe_key, event_type must be non-empty strings' },
          ],
        }),
        { status: 201 },
      );
    const rejected = await ensurePrimaryPoolForAddress({
      address: '0xdef',
      chain: 'bsc',
      reason: 'social_ca_mention',
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error || '', /non-empty strings/);

    // --- HTTP 失败 → ok:false，绝不 fallback 直写 ---
    responder = () => new Response('boom', { status: 500 });
    const httpFail = await ensurePrimaryPoolForAddress({
      address: '0xaaa',
      chain: 'bsc',
      reason: 'social_ca_mention',
    });
    assert.equal(httpFail.ok, false);
    assert.equal(httpFail.entered, false);
    assert.equal(httpFail.error, 'newone_api_500');

    // --- 网络错误 → ok:false，错误信息透出 ---
    responder = () => {
      throw new Error('connect ECONNREFUSED');
    };
    const netFail = await ensurePrimaryPoolForAddress({
      address: '0xbbb',
      chain: 'bsc',
      reason: 'social_ca_mention',
    });
    assert.equal(netFail.ok, false);
    assert.equal(netFail.error, 'connect ECONNREFUSED');

    // --- 可选 Bearer token（跨机部署预留） ---
    process.env.NEWONE_API_TOKEN = 'tok-xyz';
    calls = [];
    responder = () =>
      new Response(
        JSON.stringify({
          results: [
            {
              event_id: 4,
              token_id: 1,
              duplicate: false,
              pool_entered: true,
              pool_membership_id: 9,
            },
          ],
        }),
        { status: 201 },
      );
    await ensurePrimaryPoolForAddress({
      address: '0xccc',
      chain: 'base',
      reason: 'social_ca_mention',
    });
    assert.equal(calls[0]!.headers.authorization, 'Bearer tok-xyz');
    delete process.env.NEWONE_API_TOKEN;

    console.log('PASS primary-pool-api-ingest');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.NEWONE_API_TOKEN;
    else process.env.NEWONE_API_TOKEN = originalToken;
    if (originalBase === undefined) delete process.env.NEWONE_API_BASE_URL;
    else process.env.NEWONE_API_BASE_URL = originalBase;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
