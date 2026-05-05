import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import {
  MAX_FAILURES_WITHOUT_PROGRESS,
  createCompletenessMaintenanceService,
} from '@/lib/server/completenessMaintenanceService';
import type {
  CompletenessGlobalState,
  CompletenessSource,
  CompletenessSourceState,
  CompletenessStatus,
  CompletenessTrigger,
} from '@/lib/server/completenessTypes';
import type { SyncLogInput } from '@/lib/server/syncLogRepo';

const FIXED_NOW_MS = 1713000000000;
const CONFIGURED_START_MS = 1712000000000;

function makeGlobalState(overrides: Partial<CompletenessGlobalState> = {}): CompletenessGlobalState {
  return {
    configuredStartMs: CONFIGURED_START_MS,
    globalProvenStartMs: null,
    status: 'partial',
    activeRunId: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    ...overrides,
  };
}

function makeSourceState(
  source: CompletenessSource,
  overrides: Partial<CompletenessSourceState> = {}
): CompletenessSourceState {
  return {
    source,
    requestedStartMs: CONFIGURED_START_MS,
    provenStartMs: null,
    provenEndMs: null,
    status: 'partial',
    failureCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    blockedReason: null,
    checkpointJson: null,
    ...overrides,
  };
}

async function testOnlyIncompleteUnblockedSourcesAreRun() {
  const sourceStates = new Map<CompletenessSource, CompletenessSourceState>([
    ['blockchain', makeSourceState('blockchain', { provenStartMs: 1712600000000 })],
    ['twitter', makeSourceState('twitter', { status: 'complete', provenStartMs: 1711900000000 })],
    ['telegram-bridge', makeSourceState('telegram-bridge', { status: 'blocked', blockedReason: 'quota exhausted' })],
    ['telegram-channel', makeSourceState('telegram-channel', { provenStartMs: null })],
  ]);

  const runCalls: CompletenessSource[] = [];
  const savedSourceStates: CompletenessSourceState[] = [];
  const savedGlobalStates: CompletenessGlobalState[] = [];
  const logs: SyncLogInput[] = [];
  let releaseCount = 0;
  let globalState = makeGlobalState();

  const service = createCompletenessMaintenanceService({
    acquireLease: async () => true,
    releaseLease: async () => {
      releaseCount += 1;
    },
    readGlobalState: async () => globalState,
    readSourceStates: async () => Array.from(sourceStates.values()),
    saveGlobalState: async (nextState) => {
      globalState = nextState;
      savedGlobalStates.push(nextState);
    },
    saveSourceState: async (nextState) => {
      sourceStates.set(nextState.source, nextState);
      savedSourceStates.push(nextState);
    },
    runSource: async ({ source }) => {
      runCalls.push(source);
      if (source === 'blockchain') {
        return {
          status: 'complete',
          provenStartMs: 1711800000000,
          provenEndMs: FIXED_NOW_MS,
          fetchedCount: 10,
          storedCount: 10,
          projectedCount: 10,
          blockedReason: null,
          checkpointJson: '{"cursor":"b-1"}',
          madeProgress: true,
        };
      }

      return {
        status: 'partial',
        provenStartMs: null,
        provenEndMs: FIXED_NOW_MS,
        fetchedCount: 3,
        storedCount: 1,
        projectedCount: 1,
        blockedReason: null,
        checkpointJson: '{"cursor":"tc-1"}',
        madeProgress: false,
      };
    },
    appendSyncLog: async (input) => {
      logs.push(input);
    },
    now: () => FIXED_NOW_MS,
  });

  const result = await service.runOnce({
    trigger: 'interval',
    reason: 'scheduled pass',
  });

  assert.deepEqual(runCalls, ['blockchain', 'telegram-channel']);
  assert.equal(result.started, true);
  assert.equal(result.status, 'blocked');
  assert.equal(result.globalProvenStartMs, null);
  assert.equal(savedSourceStates.length, 2);
  assert.equal(savedGlobalStates.at(-1)?.status, 'blocked');
  assert.equal(logs.at(-1)?.runKind, 'completeness');
  assert.equal(releaseCount, 1);
}

async function testRetryingStatusWhenSourceReportsRetryingWithoutProgress() {
  const sourceStates = new Map<CompletenessSource, CompletenessSourceState>([
    ['blockchain', makeSourceState('blockchain', { status: 'complete', provenStartMs: 1711800000000 })],
    ['twitter', makeSourceState('twitter', { provenStartMs: 1712400000000 })],
    ['telegram-bridge', makeSourceState('telegram-bridge', { status: 'complete', provenStartMs: 1711700000000 })],
    ['telegram-channel', makeSourceState('telegram-channel', { status: 'complete', provenStartMs: 1711600000000 })],
  ]);

  let globalState = makeGlobalState();

  const service = createCompletenessMaintenanceService({
    acquireLease: async () => true,
    releaseLease: async () => {},
    readGlobalState: async () => globalState,
    readSourceStates: async () => Array.from(sourceStates.values()),
    saveGlobalState: async (nextState) => {
      globalState = nextState;
    },
    saveSourceState: async (nextState) => {
      sourceStates.set(nextState.source, nextState);
    },
    runSource: async ({ source }) => {
      assert.equal(source, 'twitter');
      return {
        status: 'retrying',
        provenStartMs: 1712400000000,
        provenEndMs: FIXED_NOW_MS,
        fetchedCount: 0,
        storedCount: 0,
        projectedCount: 0,
        blockedReason: null,
        checkpointJson: '{"cursor":"tw-1"}',
        madeProgress: false,
      };
    },
    appendSyncLog: async () => {},
    now: () => FIXED_NOW_MS,
  });

  const result = await service.runOnce({
    trigger: 'manual',
    reason: 'manual retry',
  });

  assert.equal(result.started, true);
  assert.equal(result.status, 'retrying');
  assert.equal(result.globalProvenStartMs, 1712400000000);
  assert.equal(sourceStates.get('twitter')?.failureCount, 1);
  assert.equal(sourceStates.get('twitter')?.status, 'retrying');
}

async function testGlobalProvenStartMsIsNullWhenAnySourceLacksProof() {
  const sourceStates = new Map<CompletenessSource, CompletenessSourceState>([
    ['blockchain', makeSourceState('blockchain', { status: 'complete', provenStartMs: 1711800000000 })],
    ['twitter', makeSourceState('twitter', { status: 'complete', provenStartMs: 1711700000000 })],
    ['telegram-bridge', makeSourceState('telegram-bridge', { status: 'complete', provenStartMs: 1711600000000 })],
    ['telegram-channel', makeSourceState('telegram-channel', { provenStartMs: null })],
  ]);

  let globalState = makeGlobalState();

  const service = createCompletenessMaintenanceService({
    acquireLease: async () => true,
    releaseLease: async () => {},
    readGlobalState: async () => globalState,
    readSourceStates: async () => Array.from(sourceStates.values()),
    saveGlobalState: async (nextState) => {
      globalState = nextState;
    },
    saveSourceState: async (nextState) => {
      sourceStates.set(nextState.source, nextState);
    },
    runSource: async ({ source }) => {
      assert.equal(source, 'telegram-channel');
      return {
        status: 'partial',
        provenStartMs: null,
        provenEndMs: FIXED_NOW_MS,
        fetchedCount: 1,
        storedCount: 0,
        projectedCount: 0,
        blockedReason: null,
        checkpointJson: null,
        madeProgress: false,
      };
    },
    appendSyncLog: async () => {},
    now: () => FIXED_NOW_MS,
  });

  const result = await service.runOnce({
    trigger: 'interval',
    reason: 'proof gap',
  });

  assert.equal(result.globalProvenStartMs, null);
  assert.equal(result.status, 'partial');
}

async function testTargetedSourceFiltering() {
  const runCalls: CompletenessSource[] = [];
  let globalState = makeGlobalState();

  const sourceStates = [
    makeSourceState('blockchain', { provenStartMs: 1712600000000 }),
    makeSourceState('twitter', { provenStartMs: 1712500000000 }),
    makeSourceState('telegram-bridge', { provenStartMs: 1712400000000 }),
    makeSourceState('telegram-channel', { provenStartMs: 1712300000000 }),
  ];

  const service = createCompletenessMaintenanceService({
    acquireLease: async () => true,
    releaseLease: async () => {},
    readGlobalState: async () => globalState,
    readSourceStates: async () => sourceStates,
    saveGlobalState: async (nextState) => {
      globalState = nextState;
    },
    saveSourceState: async () => {},
    runSource: async ({ source }) => {
      runCalls.push(source);
      return {
        status: 'complete',
        provenStartMs: 1711800000000,
        provenEndMs: FIXED_NOW_MS,
        fetchedCount: 2,
        storedCount: 2,
        projectedCount: 2,
        blockedReason: null,
        checkpointJson: null,
        madeProgress: true,
      };
    },
    appendSyncLog: async () => {},
    now: () => FIXED_NOW_MS,
  });

  await service.runOnce({
    trigger: 'manual',
    source: 'twitter',
    reason: 'targeted repair',
  });

  assert.deepEqual(runCalls, ['twitter']);
}

async function testBlockedPromotionAtFailureThreshold() {
  assert.equal(MAX_FAILURES_WITHOUT_PROGRESS, 10);

  const sourceStates = new Map<CompletenessSource, CompletenessSourceState>([
    ['blockchain', makeSourceState('blockchain', { status: 'complete', provenStartMs: 1711800000000 })],
    ['twitter', makeSourceState('twitter', { failureCount: MAX_FAILURES_WITHOUT_PROGRESS - 1, status: 'retrying' })],
    ['telegram-bridge', makeSourceState('telegram-bridge', { status: 'complete', provenStartMs: 1711700000000 })],
    ['telegram-channel', makeSourceState('telegram-channel', { status: 'complete', provenStartMs: 1711600000000 })],
  ]);

  let globalState = makeGlobalState();

  const service = createCompletenessMaintenanceService({
    acquireLease: async () => true,
    releaseLease: async () => {},
    readGlobalState: async () => globalState,
    readSourceStates: async () => Array.from(sourceStates.values()),
    saveGlobalState: async (nextState) => {
      globalState = nextState;
    },
    saveSourceState: async (nextState) => {
      sourceStates.set(nextState.source, nextState);
    },
    runSource: async ({ source }) => {
      assert.equal(source, 'twitter');
      return {
        status: 'retrying',
        provenStartMs: null,
        provenEndMs: FIXED_NOW_MS,
        fetchedCount: 0,
        storedCount: 0,
        projectedCount: 0,
        blockedReason: null,
        checkpointJson: null,
        madeProgress: false,
      };
    },
    appendSyncLog: async () => {},
    now: () => FIXED_NOW_MS,
  });

  const result = await service.runOnce({
    trigger: 'recovery',
    reason: 'threshold promotion',
  });

  assert.equal(result.status, 'blocked');
  assert.equal(sourceStates.get('twitter')?.status, 'blocked');
  assert.equal(sourceStates.get('twitter')?.failureCount, MAX_FAILURES_WITHOUT_PROGRESS);
  assert.match(sourceStates.get('twitter')?.blockedReason || '', /10/);
}

async function testReadsStateOnlyAfterLeaseIsAcquired() {
  const callOrder: string[] = [];
  let leaseAcquired = false;
  const globalState = makeGlobalState({ configuredStartMs: 1711000000000, activeRunId: 77 });
  const sourceStates = [
    makeSourceState('blockchain', { status: 'complete', provenStartMs: 1710500000000 }),
    makeSourceState('twitter', { status: 'complete', provenStartMs: 1710400000000 }),
    makeSourceState('telegram-bridge', { status: 'complete', provenStartMs: 1710300000000 }),
    makeSourceState('telegram-channel', { status: 'complete', provenStartMs: 1710200000000 }),
  ];
  const logs: SyncLogInput[] = [];

  const service = createCompletenessMaintenanceService({
    acquireLease: async () => {
      callOrder.push('acquireLease');
      leaseAcquired = true;
      return true;
    },
    releaseLease: async () => {
      callOrder.push('releaseLease');
    },
    readGlobalState: async () => {
      callOrder.push('readGlobalState');
      assert.equal(leaseAcquired, true);
      return globalState;
    },
    readSourceStates: async () => {
      callOrder.push('readSourceStates');
      assert.equal(leaseAcquired, true);
      return sourceStates;
    },
    saveGlobalState: async () => {},
    saveSourceState: async () => {},
    runSource: async () => {
      throw new Error('runSource should not be called');
    },
    appendSyncLog: async (input) => {
      logs.push(input);
    },
    now: () => FIXED_NOW_MS,
  });

  const result = await service.runOnce({
    trigger: 'interval',
    reason: 'ordering check',
  });

  assert.equal(result.started, false);
  assert.equal(result.status, 'complete');
  assert.equal(result.globalProvenStartMs, 1710500000000);
  assert.deepEqual(callOrder.slice(0, 3), ['acquireLease', 'readGlobalState', 'readSourceStates']);
  assert.equal(logs.at(-1)?.runId, 77);
}

async function testPreservesCheckpointWhenRunnerOmitsNewCheckpoint() {
  const sourceStates = new Map<CompletenessSource, CompletenessSourceState>([
    ['blockchain', makeSourceState('blockchain', { status: 'complete', provenStartMs: 1711800000000 })],
    [
      'twitter',
      makeSourceState('twitter', {
        checkpointJson: '{"cursor":"existing"}',
      }),
    ],
    ['telegram-bridge', makeSourceState('telegram-bridge', { status: 'complete', provenStartMs: 1711700000000 })],
    ['telegram-channel', makeSourceState('telegram-channel', { status: 'complete', provenStartMs: 1711600000000 })],
  ]);

  let globalState = makeGlobalState();

  const service = createCompletenessMaintenanceService({
    acquireLease: async () => true,
    releaseLease: async () => {},
    readGlobalState: async () => globalState,
    readSourceStates: async () => Array.from(sourceStates.values()),
    saveGlobalState: async (nextState) => {
      globalState = nextState;
    },
    saveSourceState: async (nextState) => {
      sourceStates.set(nextState.source, nextState);
    },
    runSource: async ({ source }) => {
      assert.equal(source, 'twitter');
      return {
        status: 'retrying',
        provenStartMs: null,
        provenEndMs: FIXED_NOW_MS,
        fetchedCount: 0,
        storedCount: 0,
        projectedCount: 0,
        blockedReason: null,
        madeProgress: false,
      };
    },
    appendSyncLog: async () => {},
    now: () => FIXED_NOW_MS,
  });

  await service.runOnce({
    trigger: 'manual',
    source: 'twitter',
    reason: 'preserve checkpoint',
  });

  assert.equal(sourceStates.get('twitter')?.checkpointJson, '{"cursor":"existing"}');
}

async function testIncludesRunIdInLogsWhenActiveRunIdExists() {
  const logs: SyncLogInput[] = [];
  let globalState = makeGlobalState({ activeRunId: 456 });

  const service = createCompletenessMaintenanceService({
    acquireLease: async () => true,
    releaseLease: async () => {},
    readGlobalState: async () => globalState,
    readSourceStates: async () => [
      makeSourceState('blockchain', { status: 'complete', provenStartMs: 1711800000000 }),
      makeSourceState('twitter', { status: 'complete', provenStartMs: 1711700000000 }),
      makeSourceState('telegram-bridge', { status: 'complete', provenStartMs: 1711600000000 }),
      makeSourceState('telegram-channel', { status: 'complete', provenStartMs: 1711500000000 }),
    ],
    saveGlobalState: async (nextState) => {
      globalState = nextState;
    },
    saveSourceState: async () => {},
    runSource: async () => {
      throw new Error('runSource should not be called');
    },
    appendSyncLog: async (input) => {
      logs.push(input);
    },
    now: () => FIXED_NOW_MS,
  });

  await service.runOnce({
    trigger: 'interval',
    reason: 'log run id',
  });

  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.runKind, 'completeness');
  assert.equal(logs[0]?.runId, 456);
}

async function testBusyLeaseReturnsPersistedStateAndRunId() {
  const logs: SyncLogInput[] = [];
  const globalState = makeGlobalState({
    configuredStartMs: 1711000000000,
    activeRunId: 999,
  });
  const sourceStates = [
    makeSourceState('blockchain', { status: 'complete', provenStartMs: 1710500000000 }),
    makeSourceState('twitter', { status: 'complete', provenStartMs: 1710400000000 }),
    makeSourceState('telegram-bridge', { status: 'complete', provenStartMs: 1710300000000 }),
    makeSourceState('telegram-channel', { status: 'complete', provenStartMs: 1710200000000 }),
  ];

  const service = createCompletenessMaintenanceService({
    acquireLease: async () => false,
    releaseLease: async () => {
      throw new Error('releaseLease should not be called when lease is not acquired');
    },
    readGlobalState: async () => globalState,
    readSourceStates: async () => sourceStates,
    saveGlobalState: async () => {
      throw new Error('saveGlobalState should not be called');
    },
    saveSourceState: async () => {
      throw new Error('saveSourceState should not be called');
    },
    runSource: async () => {
      throw new Error('runSource should not be called');
    },
    appendSyncLog: async (input) => {
      logs.push(input);
    },
    now: () => FIXED_NOW_MS,
  });

  const result = await service.runOnce({
    trigger: 'interval',
    reason: 'lease busy',
  });

  assert.equal(result.started, false);
  assert.equal(result.status, 'complete');
  assert.equal(result.globalProvenStartMs, 1710500000000);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.runId, 999);
  assert.equal(logs[0]?.payload?.status, 'complete');
  assert.equal(logs[0]?.payload?.globalProvenStartMs, 1710500000000);
}

async function run() {
  await testOnlyIncompleteUnblockedSourcesAreRun();
  await testRetryingStatusWhenSourceReportsRetryingWithoutProgress();
  await testGlobalProvenStartMsIsNullWhenAnySourceLacksProof();
  await testTargetedSourceFiltering();
  await testBlockedPromotionAtFailureThreshold();
  await testReadsStateOnlyAfterLeaseIsAcquired();
  await testPreservesCheckpointWhenRunnerOmitsNewCheckpoint();
  await testIncludesRunIdInLogsWhenActiveRunIdExists();
  await testBusyLeaseReturnsPersistedStateAndRunId();

  console.log('completeness maintenance service tests: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
