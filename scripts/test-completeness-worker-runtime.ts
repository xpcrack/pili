import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import type { CompletenessPokeRow, CompletenessSourceState } from '@/lib/server/completenessTypes';
import { createCompletenessMaintenanceWorkerCycle } from '@/lib/server/completenessMaintenanceWorkerRuntime';

function makePoke(id: number): CompletenessPokeRow {
  return {
    id,
    trigger: 'manual',
    sourceHint: null,
    reason: `poke-${id}`,
    createdAt: 1_713_000_000_000 + id,
    claimedAt: null,
  };
}

function makeSourceState(status: CompletenessSourceState['status'], failureCount: number): CompletenessSourceState {
  return {
    source: 'twitter',
    requestedStartMs: 1_712_000_000_000,
    provenStartMs: 1_711_900_000_000,
    provenEndMs: 1_713_000_000_000,
    status,
    failureCount,
    lastSuccessAt: null,
    lastFailureAt: null,
    blockedReason: null,
    checkpointJson: null,
  };
}

async function testBusyCycleReleasesClaimedPokes() {
  const claimed: Array<{ ids: number[]; claimedAt: number }> = [];
  const released: Array<{ ids: number[]; claimedAt: number }> = [];
  const deleted: Array<{ ids: number[]; claimedAt: number }> = [];

  const runCycle = createCompletenessMaintenanceWorkerCycle({
    ensureGlobalStateConfiguredStartMs: () => 1_712_000_000_000,
    readCompletenessGlobalState: () => null,
    readPendingCompletenessPokes: () => [makePoke(1), makePoke(2)],
    claimCompletenessPokes: (ids, claimedAt) => {
      claimed.push({ ids, claimedAt });
      return ids;
    },
    releaseClaimedCompletenessPokes: (ids, claimedAt) => {
      released.push({ ids, claimedAt });
    },
    deleteClaimedCompletenessPokes: (ids, claimedAt) => {
      deleted.push({ ids, claimedAt });
    },
    runCompletenessMaintenancePass: async () => ({
      started: false,
      status: 'partial',
      globalProvenStartMs: null,
      sourceResults: [],
      busy: true,
    }),
    readCompletenessSourceStates: () => [],
  });

  const cycle = await runCycle();

  assert.equal(cycle.busy, true);
  assert.equal(cycle.claimedPokeCount, 2);
  assert.deepEqual(claimed, [{ ids: [1, 2], claimedAt: claimed[0]?.claimedAt ?? 0 }]);
  assert.deepEqual(released, [{ ids: [1, 2], claimedAt: claimed[0]?.claimedAt ?? 0 }]);
  assert.deepEqual(deleted, []);
}

async function testFailedCycleReleasesClaimedPokes() {
  const claimed: Array<{ ids: number[]; claimedAt: number }> = [];
  const released: Array<{ ids: number[]; claimedAt: number }> = [];
  const deleted: Array<{ ids: number[]; claimedAt: number }> = [];

  const runCycle = createCompletenessMaintenanceWorkerCycle({
    ensureGlobalStateConfiguredStartMs: () => 1_712_000_000_000,
    readCompletenessGlobalState: () => null,
    readPendingCompletenessPokes: () => [makePoke(3)],
    claimCompletenessPokes: (ids, claimedAt) => {
      claimed.push({ ids, claimedAt });
      return ids;
    },
    releaseClaimedCompletenessPokes: (ids, claimedAt) => {
      released.push({ ids, claimedAt });
    },
    deleteClaimedCompletenessPokes: (ids, claimedAt) => {
      deleted.push({ ids, claimedAt });
    },
    runCompletenessMaintenancePass: async () => {
      throw new Error('boom');
    },
    readCompletenessSourceStates: () => [],
  });

  await assert.rejects(runCycle(), /boom/);
  assert.deepEqual(claimed, [{ ids: [3], claimedAt: claimed[0]?.claimedAt ?? 0 }]);
  assert.deepEqual(released, [{ ids: [3], claimedAt: claimed[0]?.claimedAt ?? 0 }]);
  assert.deepEqual(deleted, []);
}

async function testSuccessfulCycleAcknowledgesClaimedPokes() {
  const claimed: Array<{ ids: number[]; claimedAt: number }> = [];
  const released: Array<{ ids: number[]; claimedAt: number }> = [];
  const deleted: Array<{ ids: number[]; claimedAt: number }> = [];

  const runCycle = createCompletenessMaintenanceWorkerCycle({
    ensureGlobalStateConfiguredStartMs: () => 1_712_000_000_000,
    readCompletenessGlobalState: () => null,
    readPendingCompletenessPokes: () => [makePoke(4)],
    claimCompletenessPokes: (ids, claimedAt) => {
      claimed.push({ ids, claimedAt });
      return ids;
    },
    releaseClaimedCompletenessPokes: (ids, claimedAt) => {
      released.push({ ids, claimedAt });
    },
    deleteClaimedCompletenessPokes: (ids, claimedAt) => {
      deleted.push({ ids, claimedAt });
    },
    runCompletenessMaintenancePass: async () => ({
      started: true,
      status: 'retrying',
      globalProvenStartMs: 1_711_900_000_000,
      sourceResults: [],
      busy: false,
    }),
    readCompletenessSourceStates: () => [makeSourceState('retrying', 2)],
  });

  const cycle = await runCycle();

  assert.equal(cycle.busy, false);
  assert.equal(cycle.claimedPokeCount, 1);
  assert.deepEqual(claimed, [{ ids: [4], claimedAt: claimed[0]?.claimedAt ?? 0 }]);
  assert.deepEqual(released, []);
  assert.deepEqual(deleted, [{ ids: [4], claimedAt: claimed[0]?.claimedAt ?? 0 }]);
  assert.equal(cycle.sleepMs > 0, true);
}

async function testContestedPokesDoNotRunOrCleanUpWithoutOwnership() {
  const claimed: Array<{ ids: number[]; claimedAt: number }> = [];
  const released: Array<{ ids: number[]; claimedAt: number }> = [];
  const deleted: Array<{ ids: number[]; claimedAt: number }> = [];
  let runPassCalls = 0;

  const runCycle = createCompletenessMaintenanceWorkerCycle({
    ensureGlobalStateConfiguredStartMs: () => 1_712_000_000_000,
    readCompletenessGlobalState: () => ({
      configuredStartMs: 1_712_000_000_000,
      globalProvenStartMs: 1_711_900_000_000,
      status: 'partial',
      activeRunId: null,
      lastSuccessAt: null,
      lastFailureAt: null,
    }),
    readPendingCompletenessPokes: () => [makePoke(5)],
    claimCompletenessPokes: (ids, claimedAt) => {
      claimed.push({ ids, claimedAt });
      return [];
    },
    releaseClaimedCompletenessPokes: (ids, claimedAt) => {
      released.push({ ids, claimedAt });
    },
    deleteClaimedCompletenessPokes: (ids, claimedAt) => {
      deleted.push({ ids, claimedAt });
    },
    runCompletenessMaintenancePass: async () => {
      runPassCalls += 1;
      return {
        started: false,
        status: 'partial',
        globalProvenStartMs: null,
        sourceResults: [],
        busy: true,
      };
    },
    readCompletenessSourceStates: () => [],
  });

  const cycle = await runCycle();

  assert.equal(cycle.busy, true);
  assert.equal(cycle.claimedPokeCount, 0);
  assert.equal(runPassCalls, 0);
  assert.deepEqual(claimed, [{ ids: [5], claimedAt: claimed[0]?.claimedAt ?? 0 }]);
  assert.deepEqual(released, []);
  assert.deepEqual(deleted, []);
}

async function run() {
  await testBusyCycleReleasesClaimedPokes();
  await testFailedCycleReleasesClaimedPokes();
  await testSuccessfulCycleAcknowledgesClaimedPokes();
  await testContestedPokesDoNotRunOrCleanUpWithoutOwnership();
  console.log('completeness worker runtime tests: ok');
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
