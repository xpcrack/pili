import assert from 'node:assert/strict';

import './server-only-shim.cjs';

async function main() {
  const { parseTwitterHandleFromUrl } = await import(
    '../lib/server/primaryPoolSymbols'
  );

  // 具体推文 URL 不能当账号主页——否则推文里 @<user> 会被误判为提及该代币
  const tweetUrls: Array<string | null> = [
    'https://x.com/elonmusk/status/2083031205864239157',
    'https://x.com/i/status/2083031205864239157',
    'https://twitter.com/elonmusk/status/123',
    'https://mobile.twitter.com/elonmusk/status/123',
  ];
  for (const url of tweetUrls) {
    assert.equal(
      parseTwitterHandleFromUrl(url),
      null,
      `tweet URL should be rejected: ${url}`,
    );
  }

  // 账号主页 / @handle / 其它子路径不能被误伤
  const accountCases: Array<[string, string]> = [
    ['https://x.com/elonmusk', 'elonmusk'],
    ['https://x.com/elonmusk/with_replies', 'elonmusk'],
    ['https://x.com/runecrypto_', 'runecrypto_'],
    ['@elonmusk', 'elonmusk'],
    ['https://twitter.com/SomeToken', 'sometoken'],
  ];
  for (const [url, want] of accountCases) {
    assert.equal(
      parseTwitterHandleFromUrl(url),
      want,
      `account URL should resolve: ${url}`,
    );
  }

  assert.equal(parseTwitterHandleFromUrl(''), null);
  assert.equal(parseTwitterHandleFromUrl(null), null);
  assert.equal(parseTwitterHandleFromUrl('https://t.co/abc'), null);

  console.log('PASS parse-twitter-handle');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
