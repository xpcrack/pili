import 'server-only';

import type { FeedBackfillWindowState } from '@/lib/server/feedSnapshotRepo';
import type { TriggerSyncOptions } from '@/lib/server/syncWindowState';

import {
  parseCompletenessCheckpoint,
  type CompletenessRunSourceResult,
  type CompletenessSourceAdapter,
} from '@/lib/server/completenessSourceAdapters/types';

interface BlockchainCompletenessAdapterDeps {
  triggerBackfillStep: (input: { reason: string; options: TriggerSyncOptions }) => Promise<{ started: boolean; running: boolean }> | { started: boolean; running: boolean };
  waitForBackfillStep: () => Promise<void>;
  readWindowState: () => FeedBackfillWindowState | null;
  readSyncCompletedAtMs: () => number | null;
}

function buildWindowCheckpoint(windowState: FeedBackfillWindowState | null) {
  return JSON.stringify({
    globalEarliestMs: windowState?.globalEarliestMs ?? null,
    globalAlignment: windowState?.globalAlignment ?? null,
    updatedAt: windowState?.updatedAt ?? null,
  });
}

export function createBlockchainCompletenessAdapter(
  deps: BlockchainCompletenessAdapterDeps
): CompletenessSourceAdapter {
  return {
    source: 'blockchain',
    async runStep(input) {
      const beforeWindowState = deps.readWindowState();
      const beforeCheckpoint = buildWindowCheckpoint(beforeWindowState);

      const triggerResult = await deps.triggerBackfillStep({
        reason: input.reason || 'completeness-maintenance',
        options: {
          mode: 'backfill',
          scope: 'global',
        },
      });

      if (triggerResult.started) {
        await deps.waitForBackfillStep();
      }

      const afterWindowState = deps.readWindowState();
      const checkpointJson = buildWindowCheckpoint(afterWindowState);
      const parsedBefore = parseCompletenessCheckpoint<{
        globalEarliestMs?: number | null;
      }>(beforeCheckpoint);
      const parsedAfter = parseCompletenessCheckpoint<{
        globalEarliestMs?: number | null;
      }>(checkpointJson);
      const beforeEarliest = parsedBefore?.globalEarliestMs ?? null;
      const afterEarliest = parsedAfter?.globalEarliestMs ?? null;
      const aligned = afterWindowState?.globalAlignment === 'aligned';
      const provenStartMs =
        aligned && typeof afterEarliest === 'number' && Number.isFinite(afterEarliest) ? afterEarliest : null;

      return {
        status:
          typeof provenStartMs === 'number' && provenStartMs <= input.configuredStartMs
            ? 'complete'
            : triggerResult.running
              ? 'partial'
              : 'retrying',
        provenStartMs,
        provenEndMs: deps.readSyncCompletedAtMs(),
        fetchedCount: 0,
        storedCount: 0,
        projectedCount: 0,
        blockedReason: null,
        checkpointJson,
        madeProgress:
          typeof afterEarliest === 'number' &&
          (typeof beforeEarliest !== 'number' || afterEarliest < beforeEarliest),
      } satisfies CompletenessRunSourceResult;
    },
  };
}
