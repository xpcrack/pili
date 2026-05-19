import assert from 'node:assert/strict';

import { scheduleBackfillCompanionAfterPrimarySync } from '@/lib/server/feedBackfillScheduler';

async function testDeferredScheduling() {
  let companionRuns = 0;
  let waitCalls = 0;
  let releasePrimarySync!: () => void;

  const primarySyncGate = new Promise<void>((resolve) => {
    releasePrimarySync = resolve;
  });

  const waitForPrimarySync = () => {
    waitCalls += 1;
    return primarySyncGate;
  };

  const result = scheduleBackfillCompanionAfterPrimarySync({
    waitForPrimarySync,
    runCompanionSyncs: () => {
      companionRuns += 1;
      return {
        twitter: {
          ok: true,
          started: true,
          background: true,
          windowDays: 14,
          userId: 'user-1',
        },
      };
    },
  });

  assert.equal(waitCalls, 1, 'should start waiting immediately');
  assert.deepEqual(result, {
    twitter: {
      ok: true,
      started: true,
      background: true,
      deferredUntilPrimarySyncIdle: true,
    },
  });
  assert.equal(companionRuns, 0, 'should not run companion syncs before primary sync settles');

  releasePrimarySync();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(companionRuns, 1, 'should run companion syncs after primary sync settles');
}

async function main() {
  await testDeferredScheduling();
  console.log('feed backfill scheduler tests: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
