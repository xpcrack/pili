import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import { createCompletenessMaintenanceService } from '@/lib/server/completenessMaintenanceService';
import { createBlockchainCompletenessAdapter } from '@/lib/server/completenessSourceAdapters/blockchain';
import { createTelegramBridgeCompletenessAdapter } from '@/lib/server/completenessSourceAdapters/telegramBridge';
import { createTelegramChannelCompletenessAdapter } from '@/lib/server/completenessSourceAdapters/telegramChannel';
import { createTwitterCompletenessAdapter } from '@/lib/server/completenessSourceAdapters/twitter';
import type { CompletenessGlobalState, CompletenessSource, CompletenessSourceState } from '@/lib/server/completenessTypes';

const FIXED_NOW_MS = 1_713_000_000_000;
const CONFIGURED_START_MS = 1_712_000_000_000;

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

async function testMaintenanceServiceUsesSourceAdapterDispatchByDefault() {
  const calls: CompletenessSource[] = [];
  let globalState = makeGlobalState();
  const sourceStates = [
    makeSourceState('blockchain', { status: 'complete', provenStartMs: CONFIGURED_START_MS - 1 }),
    makeSourceState('twitter', { provenStartMs: CONFIGURED_START_MS + 10_000 }),
    makeSourceState('telegram-bridge', { status: 'complete', provenStartMs: CONFIGURED_START_MS - 1 }),
    makeSourceState('telegram-channel', { status: 'complete', provenStartMs: CONFIGURED_START_MS - 1 }),
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
    sourceAdapters: {
      twitter: {
        source: 'twitter',
        runStep: async () => {
          calls.push('twitter');
          return {
            status: 'complete',
            provenStartMs: CONFIGURED_START_MS - 1,
            provenEndMs: FIXED_NOW_MS,
            fetchedCount: 5,
            storedCount: 5,
            projectedCount: 5,
            blockedReason: null,
            checkpointJson: '{"lane":"all"}',
            madeProgress: true,
          };
        },
      },
    },
    appendSyncLog: async () => {},
    now: () => FIXED_NOW_MS,
  });

  const result = await service.runOnce({
    trigger: 'manual',
    source: 'twitter',
    reason: 'dispatch-test',
  });

  assert.deepEqual(calls, ['twitter']);
  assert.equal(result.started, true);
  assert.equal(result.status, 'complete');
}

async function testBlockchainAdapterOnlyCompletesWhenAlignedPastConfiguredStart() {
  let readCount = 0;
  const adapter = createBlockchainCompletenessAdapter({
    triggerBackfillStep: async () => ({
      started: true,
      running: true,
    }),
    waitForBackfillStep: async () => {},
    readWindowState: () => {
      readCount += 1;
      if (readCount === 1) {
        return {
          globalEarliestMs: CONFIGURED_START_MS + 86_400_000,
          perUserEarliestMs: {},
          perUserHistoryComplete: {},
          perUserLastBackfillAt: {},
          perUserLocalQualifiedCount: {},
          globalAlignment: 'aligned' as const,
          updatedAt: FIXED_NOW_MS - 10_000,
        };
      }

      return {
        globalEarliestMs: CONFIGURED_START_MS - 1,
        perUserEarliestMs: {},
        perUserHistoryComplete: {},
        perUserLastBackfillAt: {},
        perUserLocalQualifiedCount: {},
        globalAlignment: 'partial' as const,
        updatedAt: FIXED_NOW_MS,
      };
    },
    readSyncCompletedAtMs: () => FIXED_NOW_MS,
  });

  const result = await adapter.runStep({
    state: makeSourceState('blockchain'),
    configuredStartMs: CONFIGURED_START_MS,
    trigger: 'manual',
    reason: 'blockchain-test',
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.provenStartMs, null);
  assert.equal(result.provenEndMs, FIXED_NOW_MS);
  assert.equal(result.madeProgress, true);
  assert.match(result.checkpointJson || '', /globalEarliestMs/);
}

async function testTwitterAdapterUsesLaterLaneProofAndTreatsBudgetExhaustionAsPartial() {
  const adapter = createTwitterCompletenessAdapter({
    now: () => FIXED_NOW_MS,
    listTrackedUsers: () => [
      {
        id: 'user-1',
        name: 'User 1',
        handle: 'user-1',
        twitterHandle: 'user1',
        twitterUserId: null,
        twitterAvatarUrl: null,
      },
    ],
    runSyncAction: async () => ({
      ok: true as const,
      summary: {
        budgetExhausted: true,
        budgetReasons: ['provider_budget'],
      },
    }),
    readCursor: (userId, lane) => ({
      userId,
      lane,
      coveredSinceMs: lane === 'timeline' ? CONFIGURED_START_MS - 1_000 : CONFIGURED_START_MS - 500,
      watermarkCreatedAtMs: FIXED_NOW_MS - 5_000,
      watermarkTweetId: `${lane}-tweet`,
      lastSuccessAtMs: FIXED_NOW_MS - 2_000,
      updatedAtMs: FIXED_NOW_MS - 2_000,
    }),
  });

  const result = await adapter.runStep({
    state: makeSourceState('twitter'),
    configuredStartMs: CONFIGURED_START_MS,
    trigger: 'manual',
    reason: 'twitter-test',
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.provenStartMs, CONFIGURED_START_MS - 500);
  assert.equal(result.provenEndMs, FIXED_NOW_MS - 2_000);
  assert.equal(result.madeProgress, true);
}

async function testTelegramBridgeAdapterDoesNotTreatLatestNScanAsCompletenessProof() {
  const adapter = createTelegramBridgeCompletenessAdapter({
    readBridgeTargets: () => [
      { chatId: '-100123', mode: 'telegram-monitor' as const },
      { chatId: '-100456', mode: 'twitter-relay' as const },
    ],
    backfillHistory: async () => ({
      chatCount: 2,
      fetchedCount: 10,
      ingestedCount: 10,
      ignoredCount: 0,
      chatResults: [
        {
          chatId: '-100123',
          oldestScannedMessageId: 700,
          oldestScannedMessageTimeMs: CONFIGURED_START_MS + 10_000,
          reachedHistoryBoundary: false,
          nextBeforeMessageId: 700,
          fetchedCount: 5,
          ingestedCount: 5,
          ignoredCount: 0,
        },
        {
          chatId: '-100456',
          oldestScannedMessageId: null,
          oldestScannedMessageTimeMs: null,
          reachedHistoryBoundary: false,
          nextBeforeMessageId: null,
          fetchedCount: 0,
          ingestedCount: 0,
          ignoredCount: 0,
        },
      ],
    }),
  });

  const result = await adapter.runStep({
    state: makeSourceState('telegram-bridge'),
    configuredStartMs: CONFIGURED_START_MS,
    trigger: 'manual',
    reason: 'bridge-test',
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.provenStartMs, null);
  assert.equal(result.madeProgress, true);
  assert.match(result.checkpointJson || '', /nextBeforeMessageId/);
}

async function testTelegramChannelAdapterAggregatesWorstCoveredEnabledChannel() {
  const adapter = createTelegramChannelCompletenessAdapter({
    listEnabledSources: () => [
      {
        id: 'source-1',
        userId: 'user-1',
        channelRef: '@alpha',
        channelRefNormalized: 'alpha',
        channelTitle: 'Alpha',
        channelUsername: 'alpha',
        channelChatId: '-1001',
        accessHash: '11',
        sourceKind: 'manual',
        enabled: true,
        syncStatus: 'ready',
        lastMessageId: 900,
        lastSyncedAtMs: FIXED_NOW_MS - 1_000,
        lastError: null,
        createdAt: FIXED_NOW_MS - 10_000,
        updatedAt: FIXED_NOW_MS - 1_000,
      },
      {
        id: 'source-2',
        userId: 'user-2',
        channelRef: '@beta',
        channelRefNormalized: 'beta',
        channelTitle: 'Beta',
        channelUsername: 'beta',
        channelChatId: '-1002',
        accessHash: '22',
        sourceKind: 'manual',
        enabled: true,
        syncStatus: 'ready',
        lastMessageId: 950,
        lastSyncedAtMs: FIXED_NOW_MS - 1_000,
        lastError: null,
        createdAt: FIXED_NOW_MS - 10_000,
        updatedAt: FIXED_NOW_MS - 1_000,
      },
    ],
    backfillSourceHistory: async ({ source }) => ({
      sourceId: source.id,
      fetchedCount: 3,
      storedCount: 3,
      projectedCount: 3,
      oldestScannedMessageId: source.id === 'source-1' ? 400 : 500,
      oldestScannedMessageTimeMs:
        source.id === 'source-1' ? CONFIGURED_START_MS - 20_000 : CONFIGURED_START_MS + 20_000,
      reachedHistoryBoundary: source.id === 'source-1',
      nextBeforeMessageId: source.id === 'source-1' ? null : 500,
      lastMessageIdAfterRun: source.lastMessageId,
    }),
  });

  const result = await adapter.runStep({
    state: makeSourceState('telegram-channel'),
    configuredStartMs: CONFIGURED_START_MS,
    trigger: 'manual',
    reason: 'channel-test',
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.provenStartMs, CONFIGURED_START_MS + 20_000);
  assert.equal(result.projectedCount, 6);
  assert.match(result.checkpointJson || '', /source-2/);
}

async function run() {
  await testMaintenanceServiceUsesSourceAdapterDispatchByDefault();
  await testBlockchainAdapterOnlyCompletesWhenAlignedPastConfiguredStart();
  await testTwitterAdapterUsesLaterLaneProofAndTreatsBudgetExhaustionAsPartial();
  await testTelegramBridgeAdapterDoesNotTreatLatestNScanAsCompletenessProof();
  await testTelegramChannelAdapterAggregatesWorstCoveredEnabledChannel();
  console.log('completeness source adapter tests: ok');
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
