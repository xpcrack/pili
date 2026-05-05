import 'server-only';

import {
  normalizeCompletenessTimestamp,
  parseCompletenessCheckpoint,
  type CompletenessRunSourceResult,
  type CompletenessSourceAdapter,
} from '@/lib/server/completenessSourceAdapters/types';

interface TelegramBridgeTarget {
  chatId: string;
  mode: 'telegram-monitor' | 'twitter-relay';
}

interface TelegramBridgeHistoryChatResult {
  chatId: string;
  oldestScannedMessageId: number | null;
  oldestScannedMessageTimeMs: number | null;
  reachedHistoryBoundary: boolean;
  nextBeforeMessageId: number | null;
  fetchedCount: number;
  ingestedCount: number;
  ignoredCount: number;
}

interface TelegramBridgeHistoryResult {
  chatCount: number;
  fetchedCount: number;
  ingestedCount: number;
  ignoredCount: number;
  chatResults: TelegramBridgeHistoryChatResult[];
}

interface TelegramBridgeCompletenessAdapterDeps {
  readBridgeTargets: () => TelegramBridgeTarget[];
  backfillHistory: (input: {
    beforeByChatId: Record<string, number | null>;
    startMs: number;
    endMs: number | null;
  }) => Promise<TelegramBridgeHistoryResult>;
}

export function createTelegramBridgeCompletenessAdapter(
  deps: TelegramBridgeCompletenessAdapterDeps
): CompletenessSourceAdapter {
  return {
    source: 'telegram-bridge',
    async runStep(input) {
      const targets = deps.readBridgeTargets();
      if (targets.length === 0) {
        return {
          status: 'complete',
          provenStartMs: input.configuredStartMs,
          provenEndMs: null,
          fetchedCount: 0,
          storedCount: 0,
          projectedCount: 0,
          blockedReason: null,
          checkpointJson: JSON.stringify({ chats: {} }),
          madeProgress: false,
        };
      }

      const previousCheckpoint = parseCompletenessCheckpoint<{
        chats?: Record<string, { nextBeforeMessageId?: number | null; oldestScannedMessageTimeMs?: number | null }>;
      }>(input.state.checkpointJson);
      const beforeByChatId = Object.fromEntries(
        targets.map((target) => [
          target.chatId,
          normalizeCompletenessTimestamp(previousCheckpoint?.chats?.[target.chatId]?.nextBeforeMessageId ?? null),
        ])
      ) as Record<string, number | null>;

      const history = await deps.backfillHistory({
        beforeByChatId,
        startMs: input.configuredStartMs,
        endMs: null,
      });

      let provenStartMs: number | null = null;
      let provenEndMs: number | null = null;
      let madeProgress = false;
      const chats: Record<string, unknown> = {};

      for (const result of history.chatResults) {
        const previousChat = previousCheckpoint?.chats?.[result.chatId];
        const oldestScannedMessageTimeMs = normalizeCompletenessTimestamp(result.oldestScannedMessageTimeMs);
        const nextBeforeMessageId = normalizeCompletenessTimestamp(result.nextBeforeMessageId);
        chats[result.chatId] = {
          nextBeforeMessageId,
          oldestScannedMessageTimeMs,
          reachedHistoryBoundary: result.reachedHistoryBoundary,
        };

        if (typeof oldestScannedMessageTimeMs === 'number') {
          provenStartMs = provenStartMs === null ? oldestScannedMessageTimeMs : Math.max(provenStartMs, oldestScannedMessageTimeMs);
          provenEndMs = provenEndMs === null ? oldestScannedMessageTimeMs : Math.max(provenEndMs, oldestScannedMessageTimeMs);
        } else if (!result.reachedHistoryBoundary) {
          provenStartMs = null;
        }

        const previousOldest = normalizeCompletenessTimestamp(previousChat?.oldestScannedMessageTimeMs ?? null);
        if (
          typeof oldestScannedMessageTimeMs === 'number' &&
          (typeof previousOldest !== 'number' || oldestScannedMessageTimeMs < previousOldest)
        ) {
          madeProgress = true;
        }
        const previousBefore = normalizeCompletenessTimestamp(previousChat?.nextBeforeMessageId ?? null);
        if (typeof nextBeforeMessageId === 'number' && (typeof previousBefore !== 'number' || nextBeforeMessageId < previousBefore)) {
          madeProgress = true;
        }
      }

      const allTargetsCovered = history.chatResults.every((result) => {
        const oldestScannedMessageTimeMs = normalizeCompletenessTimestamp(result.oldestScannedMessageTimeMs);
        return result.reachedHistoryBoundary || (typeof oldestScannedMessageTimeMs === 'number' && oldestScannedMessageTimeMs <= input.configuredStartMs);
      });

      if (!allTargetsCovered) {
        provenStartMs = history.chatResults.every((result) => {
          const oldestScannedMessageTimeMs = normalizeCompletenessTimestamp(result.oldestScannedMessageTimeMs);
          return typeof oldestScannedMessageTimeMs === 'number';
        })
          ? provenStartMs
          : null;
      }

      return {
        status: allTargetsCovered ? 'complete' : 'partial',
        provenStartMs,
        provenEndMs,
        fetchedCount: history.fetchedCount,
        storedCount: history.ingestedCount,
        projectedCount: history.ingestedCount,
        blockedReason: null,
        checkpointJson: JSON.stringify({ chats }),
        madeProgress,
      } satisfies CompletenessRunSourceResult;
    },
  };
}
