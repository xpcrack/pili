import assert from 'node:assert/strict';

import { shouldShowGlobalCompletenessWindow } from '@/lib/feedCompletenessVisibility';

function run() {
  assert.equal(
    shouldShowGlobalCompletenessWindow({
      selectedUserId: null,
      completenessWindow: null,
    }),
    false
  );

  assert.equal(
    shouldShowGlobalCompletenessWindow({
      selectedUserId: 'user-1',
      completenessWindow: {
        complete: true,
      },
    }),
    false
  );

  assert.equal(
    shouldShowGlobalCompletenessWindow({
      selectedUserId: null,
      completenessWindow: {
        complete: false,
      },
    }),
    false
  );

  assert.equal(
    shouldShowGlobalCompletenessWindow({
      selectedUserId: null,
      completenessWindow: {
        complete: true,
      },
    }),
    true
  );

  console.log('feed completeness visibility tests: ok');
}

run();
