import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import { apiError, apiOk } from '@/lib/server/apiResponse';

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function run() {
  // ---- apiOk ----
  {
    const res = apiOk();
    assert.equal(res.status, 200);
    assert.deepEqual(await readJson(res.clone()), { ok: true });
  }

  {
    const res = apiOk({ status: { running: true }, lastId: 42 });
    assert.equal(res.status, 200);
    assert.deepEqual(await readJson(res.clone()), { ok: true, status: { running: true }, lastId: 42 });
  }

  // ---- apiError: bare string default 500 ----
  {
    const res = apiError('boom');
    assert.equal(res.status, 500);
    assert.deepEqual(await readJson(res.clone()), { ok: false, error: 'boom' });
  }

  // ---- apiError: validation 400 ----
  {
    const res = apiError('请求体必须是 JSON 对象', { status: 400 });
    assert.equal(res.status, 400);
    assert.deepEqual(await readJson(res.clone()), { ok: false, error: '请求体必须是 JSON 对象' });
  }

  // ---- apiError: Error instance uses message ----
  {
    const res = apiError(new Error('triggered failure'), { fallback: '触发同步失败' });
    assert.equal(res.status, 500);
    assert.deepEqual(await readJson(res.clone()), { ok: false, error: 'triggered failure' });
  }

  // ---- apiError: non-Error non-string falls back ----
  {
    const res = apiError(null, { fallback: '触发同步失败' });
    assert.equal(res.status, 500);
    assert.deepEqual(await readJson(res.clone()), { ok: false, error: '触发同步失败' });
  }

  // ---- apiError: empty Error.message also falls back ----
  {
    const res = apiError(new Error(''), { fallback: 'fallback msg' });
    assert.equal(res.status, 500);
    assert.deepEqual(await readJson(res.clone()), { ok: false, error: 'fallback msg' });
  }

  // ---- apiError: extra fields merged ----
  {
    const res = apiError('rate_limited', {
      status: 429,
      extra: { retryAfterSeconds: 30 },
      headers: { 'Retry-After': '30' },
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '30');
    assert.deepEqual(await readJson(res.clone()), {
      ok: false,
      error: 'rate_limited',
      retryAfterSeconds: 30,
    });
  }

  // ---- byte-equivalent shape vs old NextResponse.json call ----
  {
    const oldShape = { ok: true, trigger: { id: 1 }, status: { running: false } };
    const newRes = apiOk({ trigger: { id: 1 }, status: { running: false } });
    assert.deepEqual(await readJson(newRes.clone()), oldShape);
  }

  console.log('apiResponse runtime smoke tests: ok');
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
