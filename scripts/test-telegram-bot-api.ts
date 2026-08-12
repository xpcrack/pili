import assert from 'node:assert/strict';

import { createTelegramBotApiClient } from '@/lib/server/telegramBotApi';

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

  console.log('telegram bot api tests: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
