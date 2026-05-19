import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import {
  applyRefreshWindowState,
  createDefaultWindowState,
  mergeRefreshWindowState,
  normalizeSyncOptions,
} from '@/lib/server/syncWindowState';

function run() {
  assert.deepEqual(normalizeSyncOptions(undefined), {
    mode: 'refresh',
    scope: 'global',
    userId: null,
  });

  assert.deepEqual(
    normalizeSyncOptions({
      mode: 'backfill',
      scope: 'user',
      userId: '  user-1  ',
    }),
    {
      mode: 'backfill',
      scope: 'user',
      userId: 'user-1',
    }
  );

  assert.equal(createDefaultWindowState().globalEarliestMs, null);

  assert.equal(
    applyRefreshWindowState([{ id: 'u1' }, { id: 'u2' }], 1000).globalEarliestMs,
    1000
  );

  assert.equal(
    mergeRefreshWindowState(createDefaultWindowState(), [{ id: 'u1' }, { id: 'u2' }], 1000, [
      { userId: 'u1', ok: false },
    ]).globalAlignment,
    'partial'
  );

  console.log('sync window state tests: ok');
}

run();
