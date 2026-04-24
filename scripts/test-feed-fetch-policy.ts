import assert from 'node:assert/strict';

import { resolveFeedSyncStrategy } from '@/lib/feed/fetchPolicy';

function main() {
  assert.equal(resolveFeedSyncStrategy(), 'local', 'implicit fetches should default to local snapshot reads');
  assert.equal(resolveFeedSyncStrategy('local'), 'local');
  assert.equal(resolveFeedSyncStrategy('refresh'), 'refresh');
  assert.equal(resolveFeedSyncStrategy('backfill'), 'backfill');

  console.log('feed fetch policy tests: ok');
}

main();
