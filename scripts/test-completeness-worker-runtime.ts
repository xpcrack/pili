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
  const claimed: number[][] = [];
  const released: number[][] = [];
  const deleted: number[][] = [];

  const runCycle = createCompletenessMaintenanceWorkerCycle({
    ensureGlobalStateConfiguredStartMs: () => 1_712_000_000_000,
    readPendingCompletenessPokes: () => [makePoke(1), makePoke(2)],
    claimCompletenessPokes: (ids) => {
      claimed.push(ids);
    },
    releaseClaimedCompletenessPokes: (ids) => {
      released.push(ids);
    },
    deleteClaimedCompletenessPokes: (ids) => {
      deleted.push(ids);
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
  assert.deepEqual(claimed, [[1, 2]]);
  assert.deepEqual(released, [[1, 2]]);
  assert.deepEqual(deleted, []);
}

async function testFailedCycleReleasesClaimedPokes() {
  const claimed: number[][] = [];
  const released: number[][] = [];
  const deleted: number[][] = [];

  const runCycle = createCompletenessMaintenanceWorkerCycle({
    ensureGlobalStateConfiguredStartMs: () => 1_712_000_000_000,
    readPendingCompletenessPokes: () => [makePoke(3)],
    claimCompletenessPokes: (ids) => {
      claimed.push(ids);
    },
    releaseClaimedCompletenessPokes: (ids) => {
      released.push(ids);
    },
    deleteClaimedCompletenessPokes: (ids) => {
      deleted.push(ids);
    },
    runCompletenessMaintenancePass: async () => {
      throw new Error('boom');
    },
    readCompletenessSourceStates: () => [],
  });

  await assert.rejects(runCycle(), /boom/);
  assert.deepEqual(claimed, [[3]]);
  assert.deepEqual(released, [[3]]);
  assert.deepEqual(deleted, []);
}

async function testSuccessfulCycleAcknowledgesClaimedPokes() {
  const claimed: number[][] = [];
  const released: number[][] = [];
  const deleted: number[][] = [];

  const runCycle = createCompletenessMaintenanceWorkerCycle({
    ensureGlobalStateConfiguredStartMs: () => 1_712_000_000_000,
    readPendingCompletenessPokes: () => [makePoke(4)],
    claimCompletenessPokes: (ids) => {
      claimed.push(ids);
    },
    releaseClaimedCompletenessPokes: (ids) => {
      released.push(ids);
    },
    deleteClaimedCompletenessPokes: (ids) => {
      deleted.push(ids);
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
  assert.deepEqual(claimed, [[4]]);
  assert.deepEqual(released, []);
  assert.deepEqual(deleted, [[4]]);
  assert.equal(cycle.sleepMs > 0, true);
}

async function run() {
  await testBusyCycleReleasesClaimedPokes();
  await testFailedCycleReleasesClaimedPokes();
  await testSuccessfulCycleAcknowledgesClaimedPokes();
  console.log('completeness worker runtime tests: ok');
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
