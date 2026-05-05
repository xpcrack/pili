import 'server-only';

import type { TelegramChannelSource } from '@/lib/server/telegramChannelTypes';

import {
  normalizeCompletenessTimestamp,
  parseCompletenessCheckpoint,
  type CompletenessRunSourceResult,
  type CompletenessSourceAdapter,
} from '@/lib/server/completenessSourceAdapters/types';

interface TelegramChannelHistoryStepResult {
  sourceId: string;
  fetchedCount: number;
  storedCount: number;
  projectedCount: number;
  oldestScannedMessageId: number | null;
  oldestScannedMessageTimeMs: number | null;
  reachedHistoryBoundary: boolean;
  nextBeforeMessageId: number | null;
  lastMessageIdAfterRun: number | null;
}

interface TelegramChannelCompletenessAdapterDeps {
  listEnabledSources: () => TelegramChannelSource[];
  backfillSourceHistory: (input: {
    source: TelegramChannelSource;
    beforeMessageId: number | null;
    startMs: number;
    endMs: number | null;
  }) => Promise<TelegramChannelHistoryStepResult>;
}

export function createTelegramChannelCompletenessAdapter(
  deps: TelegramChannelCompletenessAdapterDeps
): CompletenessSourceAdapter {
  return {
    source: 'telegram-channel',
    async runStep(input) {
      const sources = deps.listEnabledSources();
      if (sources.length === 0) {
        return {
          status: 'complete',
          provenStartMs: input.configuredStartMs,
          provenEndMs: null,
          fetchedCount: 0,
          storedCount: 0,
          projectedCount: 0,
          blockedReason: null,
          checkpointJson: JSON.stringify({ sources: {} }),
          madeProgress: false,
        };
      }

      const previousCheckpoint = parseCompletenessCheckpoint<{
        sources?: Record<string, { nextBeforeMessageId?: number | null; oldestScannedMessageTimeMs?: number | null }>;
      }>(input.state.checkpointJson);

      const nextCheckpointSources: Record<string, unknown> = {};
      let fetchedCount = 0;
      let storedCount = 0;
      let projectedCount = 0;
      let provenStartMs: number | null = null;
      let madeProgress = false;
      const stepResults: TelegramChannelHistoryStepResult[] = [];

      for (const source of sources) {
        const previousSourceCheckpoint = previousCheckpoint?.sources?.[source.id];
        const result = await deps.backfillSourceHistory({
          source,
          beforeMessageId: normalizeCompletenessTimestamp(previousSourceCheckpoint?.nextBeforeMessageId ?? null),
          startMs: input.configuredStartMs,
          endMs: null,
        });
        stepResults.push(result);
        fetchedCount += result.fetchedCount;
        storedCount += result.storedCount;
        projectedCount += result.projectedCount;

        const oldestScannedMessageTimeMs = normalizeCompletenessTimestamp(result.oldestScannedMessageTimeMs);
        const nextBeforeMessageId = normalizeCompletenessTimestamp(result.nextBeforeMessageId);
        nextCheckpointSources[source.id] = {
          nextBeforeMessageId,
          oldestScannedMessageTimeMs,
          reachedHistoryBoundary: result.reachedHistoryBoundary,
          lastMessageIdAfterRun: result.lastMessageIdAfterRun,
        };

        if (typeof oldestScannedMessageTimeMs === 'number') {
          provenStartMs = provenStartMs === null ? oldestScannedMessageTimeMs : Math.max(provenStartMs, oldestScannedMessageTimeMs);
        } else if (!result.reachedHistoryBoundary) {
          provenStartMs = null;
        }

        const previousOldest = normalizeCompletenessTimestamp(previousSourceCheckpoint?.oldestScannedMessageTimeMs ?? null);
        if (
          typeof oldestScannedMessageTimeMs === 'number' &&
          (typeof previousOldest !== 'number' || oldestScannedMessageTimeMs < previousOldest)
        ) {
          madeProgress = true;
        }
        const previousBefore = normalizeCompletenessTimestamp(previousSourceCheckpoint?.nextBeforeMessageId ?? null);
        if (typeof nextBeforeMessageId === 'number' && (typeof previousBefore !== 'number' || nextBeforeMessageId < previousBefore)) {
          madeProgress = true;
        }
      }

      const allSourcesCovered = stepResults.every((result) => {
        const oldestScannedMessageTimeMs = normalizeCompletenessTimestamp(result.oldestScannedMessageTimeMs);
        return result.reachedHistoryBoundary || (typeof oldestScannedMessageTimeMs === 'number' && oldestScannedMessageTimeMs <= input.configuredStartMs);
      });
      if (!allSourcesCovered) {
        provenStartMs = stepResults.every(
          (result) =>
            result.reachedHistoryBoundary ||
            typeof normalizeCompletenessTimestamp(result.oldestScannedMessageTimeMs) === 'number'
        )
          ? provenStartMs
          : null;
      }

      return {
        status: allSourcesCovered ? 'complete' : 'partial',
        provenStartMs,
        provenEndMs: null,
        fetchedCount,
        storedCount,
        projectedCount,
        blockedReason: null,
        checkpointJson: JSON.stringify({ sources: nextCheckpointSources }),
        madeProgress,
      } satisfies CompletenessRunSourceResult;
    },
  };
}
