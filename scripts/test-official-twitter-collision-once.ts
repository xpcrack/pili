import assert from 'node:assert/strict';

import './server-only-shim.cjs';

async function main() {
  const {
    officialTwitterCollisionKey,
    barkOfficialTwitterCollisionOnce,
    clearOfficialTwitterCollisionAlertCache,
  } = await import('../lib/server/primaryPoolSymbols');

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response('ok', { status: 200 });
  }) as typeof fetch;

  try {
    clearOfficialTwitterCollisionAlertCache();
    const tokens = [
      { symbol: 'AAA', address: '0xAAA' },
      { symbol: 'BBB', address: '0xBBB' },
    ];
    assert.equal(officialTwitterCollisionKey(tokens), '0xaaa|0xbbb');
    assert.equal(
      officialTwitterCollisionKey([...tokens].reverse()),
      '0xaaa|0xbbb',
    );

    const first = await barkOfficialTwitterCollisionOnce({
      handle: 'shared',
      tokens,
    });
    const second = await barkOfficialTwitterCollisionOnce({
      handle: 'shared',
      tokens: [...tokens].reverse(),
    });
    const third = await barkOfficialTwitterCollisionOnce({
      handle: 'other',
      tokens: [
        { symbol: 'CCC', address: '0xCCC' },
        { symbol: 'DDD', address: '0xDDD' },
      ],
    });

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(third, true);
    // dual bark endpoints → 2 fetch per send, 2 sends → 4
    assert.equal(calls, 4);
    console.log('PASS official-twitter-collision-once');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
