import assert from 'node:assert/strict';

import {
  fetchAllowedRedirects,
  isAllowedMediaUrl,
  normalizeSafeProxyImageContentType,
  readResponseBodyLimited,
} from '@/lib/mediaProxy';

async function main() {
  assert.equal(isAllowedMediaUrl('https://pbs.twimg.com/profile.jpg'), true);
  assert.equal(isAllowedMediaUrl('https://twimg.com.evil.example/profile.jpg'), false);
  assert.equal(isAllowedMediaUrl('http://127.0.0.1/profile.jpg'), false);
  assert.equal(normalizeSafeProxyImageContentType('image/png; charset=binary'), 'image/png');
  assert.equal(normalizeSafeProxyImageContentType('application/octet-stream'), 'image/png');
  assert.equal(normalizeSafeProxyImageContentType('image/svg+xml'), null, 'active SVG must not be served from the app origin');
  assert.equal(normalizeSafeProxyImageContentType('text/html'), null);

  const calls: string[] = [];
  const redirected = await fetchAllowedRedirects(
    'https://twimg.com/start',
    {},
    isAllowedMediaUrl,
    async (url) => {
      calls.push(String(url));
      return new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1:3000/private' },
      });
    }
  );
  assert.equal(redirected, null, 'redirects must be revalidated against the allowlist');
  assert.deepEqual(calls, ['https://twimg.com/start']);

  let safeRedirectCalls = 0;
  const finalResponse = await fetchAllowedRedirects(
    'https://twimg.com/start',
    {},
    isAllowedMediaUrl,
    async (url) => {
      safeRedirectCalls += 1;
      return safeRedirectCalls === 1
        ? new Response(null, { status: 302, headers: { location: 'https://unavatar.io/final' } })
        : new Response('ok', { status: 200, headers: { 'content-type': 'image/png' } });
    }
  );
  assert.equal(finalResponse?.status, 200);
  assert.equal(safeRedirectCalls, 2);

  const small = await readResponseBodyLimited(new Response('1234'), 4);
  assert.equal(new TextDecoder().decode(small!), '1234');
  const oversized = await readResponseBodyLimited(new Response('12345'), 4);
  assert.equal(oversized, null, 'body reads must stop at the configured byte limit');

  console.log('media proxy security tests: ok');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
