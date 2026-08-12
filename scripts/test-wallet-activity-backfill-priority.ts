import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import { fetchWalletActivitySince } from '@/lib/server/walletActivityBackfill';

async function main() {
  const result = await fetchWalletActivitySince({
    chain: 'sol',
    wallet: '11111111111111111111111111111111',
    afterTsSec: 0,
    async: true,
    shouldPause: () => true,
  });

  assert.equal(result.rawCount, 0);
  assert.equal(result.pages, 0);
  assert.equal(result.truncated, true);
  assert.equal(result.lastError, 'live-doorbells-pending');

  console.log('wallet activity backfill priority tests: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
