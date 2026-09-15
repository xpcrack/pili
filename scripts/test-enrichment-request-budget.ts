import './server-only-shim.cjs';

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  NvidaQwenEnrichmentModel,
  resolveEnrichmentTimeoutMs,
} from '../lib/server/nvidiaEnrichmentModel';

/**
 * Offline tests for the enrichment request budget. No relay involved: a stub
 * HTTP server stands in for AxonHub so the timeout / error-surfacing behaviour
 * is deterministic (the mock-free tests in test-nvidia-enrichment-model.ts skip
 * whenever NVIDIA_API_KEY is unset, so they never covered this path).
 */

const TIMEOUT_MS = 400;

type Mode = 'stall-body' | 'stall-headers' | 'error-500' | 'ok';

function startStub(mode: Mode) {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url || '');
    if (mode === 'stall-headers') {
      // Accept the request but never send anything: the fetch itself never resolves.
      return;
    }
    if (mode === 'error-500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream exploded' }));
      return;
    }
    if (mode === 'stall-body') {
      // Headers arrive immediately, body never does. This is the regression:
      // the old code cleared the timeout as soon as fetch() resolved, so the
      // body read had no budget and the call hung until the socket died.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: '{"translation_zh":"好的","sentiments":[]}' } }],
      }),
    );
  });

  return new Promise<{ baseUrl: string; seen: string[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        seen,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

async function main() {
  // --- resolveEnrichmentTimeoutMs: defaults + env override ---
  delete process.env.ENRICHMENT_LLM_TIMEOUT_MS;
  delete process.env.ENRICHMENT_LLM_TIMEOUT_MS_TRANSLATE;
  delete process.env.ENRICHMENT_LLM_TIMEOUT_MS_ALIAS;
  assert.equal(resolveEnrichmentTimeoutMs('enrichTweet'), 60_000);
  assert.equal(resolveEnrichmentTimeoutMs('translateOnly'), 45_000);
  assert.equal(resolveEnrichmentTimeoutMs('confirmAlias'), 30_000);
  process.env.ENRICHMENT_LLM_TIMEOUT_MS = String(TIMEOUT_MS);
  assert.equal(resolveEnrichmentTimeoutMs('enrichTweet'), TIMEOUT_MS);
  // All three kinds must be overridden: leaving one at its default makes the
  // stall cases take 30-45s each and the whole test file times out.
  process.env.ENRICHMENT_LLM_TIMEOUT_MS_TRANSLATE = String(TIMEOUT_MS);
  process.env.ENRICHMENT_LLM_TIMEOUT_MS_ALIAS = String(TIMEOUT_MS);
  assert.equal(resolveEnrichmentTimeoutMs('translateOnly'), TIMEOUT_MS);
  assert.equal(resolveEnrichmentTimeoutMs('confirmAlias'), TIMEOUT_MS);
  process.env.ENRICHMENT_LLM_TIMEOUT_MS = 'not-a-number';
  assert.equal(resolveEnrichmentTimeoutMs('enrichTweet'), 60_000, 'garbage env falls back');
  process.env.ENRICHMENT_LLM_TIMEOUT_MS = String(TIMEOUT_MS);
  console.log('PASS timeout resolution (defaults + env override)');

  const mentions = [{ tokenSymbol: 'BTC', tokenAddress: null, matchSource: 'ticker' as const }];

  // --- stalled body must abort, and the reason must be surfaced ---
  {
    const stub = await startStub('stall-body');
    const model = new NvidaQwenEnrichmentModel({ apiKey: 'test', baseUrl: stub.baseUrl });
    const startedAt = Date.now();
    const result = await model.enrichTweet({ tweetId: 'stall-body-1', text: 'bullish on $BTC', mentions });
    const elapsed = Date.now() - startedAt;
    await stub.close();

    assert.ok(elapsed < 5_000, `must not hang; took ${elapsed}ms`);
    assert.equal(result.translationZh, null);
    assert.ok(result.error, 'timeout must be reported in result.error (feeds last_error)');
    assert.match(result.error, /timeout/, `expected a timeout reason, got: ${result.error}`);
    assert.ok(
      elapsed >= TIMEOUT_MS - 50,
      `should use the full budget before aborting; aborted after ${elapsed}ms`,
    );
    console.log(`PASS stalled body aborts in ${elapsed}ms with reason: ${result.error}`);
  }

  // --- never-answered request must also abort ---
  {
    const stub = await startStub('stall-headers');
    const model = new NvidaQwenEnrichmentModel({ apiKey: 'test', baseUrl: stub.baseUrl });
    const startedAt = Date.now();
    const result = await model.enrichTweet({ tweetId: 'stall-headers-1', text: 'bullish on $BTC', mentions });
    const elapsed = Date.now() - startedAt;
    await stub.close();
    assert.ok(result.error, 'unanswered request must be reported');
    assert.ok(elapsed < 5_000, `must not hang; took ${elapsed}ms`);
    console.log(`PASS unanswered request aborts in ${elapsed}ms`);
  }

  // --- upstream error response must be surfaced, not silently defaulted ---
  {
    const stub = await startStub('error-500');
    const model = new NvidaQwenEnrichmentModel({ apiKey: 'test', baseUrl: stub.baseUrl });
    const result = await model.enrichTweet({ tweetId: 'err-1', text: 'bullish on $BTC', mentions });
    await stub.close();
    assert.ok(result.error, '5xx must be reported');
    assert.match(result.error, /500/);
    console.log(`PASS upstream 500 surfaced: ${result.error}`);
  }

  // --- happy path must stay clean (no error field, translation returned) ---
  {
    const stub = await startStub('ok');
    const model = new NvidaQwenEnrichmentModel({ apiKey: 'test', baseUrl: stub.baseUrl });
    const result = await model.enrichTweet({ tweetId: 'ok-1', text: 'bullish on $BTC', mentions });
    await stub.close();
    assert.equal(result.error, undefined, 'success path must not carry an error');
    assert.equal(result.translationZh, '好的');
    console.log('PASS happy path unaffected');
  }

  // --- translateOnly: null + out-of-band failure reason for the caller ---
  {
    const stub = await startStub('stall-body');
    const model = new NvidaQwenEnrichmentModel({ apiKey: 'test', baseUrl: stub.baseUrl });
    const out = await model.translateOnly('rainy day in edinburgh');
    const reason = model.takeLastFailureReason();
    await stub.close();
    assert.equal(out, null);
    assert.ok(reason, 'translateOnly must record why it returned null');
    assert.match(reason, /timeout/);
    assert.equal(model.takeLastFailureReason(), null, 'reason is consumed once (no stale reuse)');
    console.log(`PASS translateOnly timeout reason recorded: ${reason}`);
  }

  // --- translateOnly success must not leave a stale reason behind ---
  {
    const stub = await startStub('ok');
    const model = new NvidaQwenEnrichmentModel({ apiKey: 'test', baseUrl: stub.baseUrl });
    const out = await model.translateOnly('rainy day in edinburgh');
    assert.equal(out, '好的');
    assert.equal(model.takeLastFailureReason(), null, 'no failure reason on success');
    await stub.close();
    console.log('PASS translateOnly success leaves no failure reason');
  }

  // --- alias confirm: timeout degrades to empty, never hangs ---
  {
    const stub = await startStub('stall-body');
    const model = new NvidaQwenEnrichmentModel({ apiKey: 'test', baseUrl: stub.baseUrl });
    const startedAt = Date.now();
    const out = await model.confirmAliasReferences({
      text: '$Z looks strong',
      candidates: [
        { symbol: 'Z', name: 'Z', address: '0xabc', chain: 'eth', matchedAlias: 'Z世代' },
      ],
    });
    const elapsed = Date.now() - startedAt;
    await stub.close();
    assert.deepEqual(out, []);
    assert.ok(elapsed < 5_000, `alias confirm must not hang; took ${elapsed}ms`);
    console.log(`PASS alias confirm degrades to [] in ${elapsed}ms`);
  }

  console.log('\nAll enrichment request-budget tests passed!');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
