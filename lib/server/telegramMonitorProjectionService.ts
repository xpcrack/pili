import 'server-only';

import {
  upsertEventsFromFeedRows,
  upsertTelegramMonitorProvisionalEventFast,
} from '@/lib/server/eventsRepo';
import { scoreFeedRowsAgainstDatabase } from '@/lib/server/activityImportanceService';
import { projectTelegramMonitorEvent, projectTelegramMonitorTxState } from '@/lib/server/telegramMonitorFeed';
import { triggerTelegramMonitorReconciliation } from '@/lib/server/telegramMonitorReconciler';
import {
  summarizeTelegramMonitorTxProvisional,
  updateTelegramMonitorEventProjectedActivity,
} from '@/lib/server/telegramMonitorRepo';
import {
  setTelegramMonitorTxStateCanonicalActivity,
  upsertTelegramMonitorTxStateProvisional,
  type TelegramMonitorTxState,
} from '@/lib/server/telegramMonitorTxStateRepo';
import { createTwitterFetcher } from '@/lib/server/twitterFetcher';
import { parseTweetIdFromUrl, upsertEventTweetRefAndFetchMissing } from '@/lib/server/twitterLinkRefs';
import { withSqliteBusyRetry } from '@/lib/server/sqlite';
import type { User } from '@/types';
import type { ParseXxyyTelegramResult } from '@/lib/server/xxyyTelegramParser';

type ValidatedXxyyTelegramResult = Omit<ParseXxyyTelegramResult, 'chain' | 'tokenAddress' | 'action'> & {
  chain: string;
  tokenAddress: string;
  action: NonNullable<ParseXxyyTelegramResult['action']>;
};

export interface ProjectAndPersistTelegramMonitorUpdateParams {
  parsed: ValidatedXxyyTelegramResult;
  user: User;
  sourceChatId: string | null;
  sourceMessageId: number | null;
  eventTimeMs: number;
  rawText: string;
  messageLinks: string[];
  feedMode: 'doorbell' | 'project';
  autoReconcile: boolean;
}

export interface ProjectAndPersistTelegramMonitorUpdateResult {
  projected: boolean;
  txState: TelegramMonitorTxState | null;
}

/**
 * Projects one already-validated XXYY event and persists the provisional feed.
 * The ordering is intentional: the doorbell path stays local and cheap, while
 * the legacy project path keeps scoring, tweet enrichment, and reconciliation.
 */
export async function projectAndPersistTelegramMonitorUpdate(
  params: ProjectAndPersistTelegramMonitorUpdateParams
): Promise<ProjectAndPersistTelegramMonitorUpdateResult> {
  const { parsed } = params;
  const provisionalSummary =
    parsed.txHash && parsed.trackedWalletAddress
      ? summarizeTelegramMonitorTxProvisional({
          chain: parsed.chain,
          trackedWalletAddress: parsed.trackedWalletAddress,
          txHash: parsed.txHash,
          tokenAddress: parsed.tokenAddress,
        })
      : null;

  const txState = provisionalSummary
    ? withSqliteBusyRetry(
        () =>
          upsertTelegramMonitorTxStateProvisional({
            userId: params.user.id,
            chain: provisionalSummary.chain,
            trackedWalletAddress: provisionalSummary.trackedWalletAddress,
            txHash: provisionalSummary.txHash,
            tokenAddress: provisionalSummary.tokenAddress,
            tokenSymbol: provisionalSummary.tokenSymbol,
            provisionalAction: provisionalSummary.action,
            provisionalActionLabel: provisionalSummary.actionLabel,
            provisionalActionVariant: provisionalSummary.actionVariant,
            provisionalQuoteAmount: provisionalSummary.quoteAmount,
            provisionalQuoteSymbol: provisionalSummary.quoteSymbol,
            provisionalTokenAmount: provisionalSummary.tokenAmount,
            provisionalTokenSymbol: provisionalSummary.tokenSymbol,
            provisionalPriceUsd: provisionalSummary.priceUsd,
            provisionalMarketCapUsd: provisionalSummary.marketCapUsd,
            provisionalRawText: provisionalSummary.rawText,
            provisionalMessageLinks: provisionalSummary.messageLinks,
            provisionalWalletLabel: provisionalSummary.walletLabel,
            provisionalWalletGroupLabel: provisionalSummary.walletGroupLabel,
            provisionalWalletAliasLabel: provisionalSummary.walletAliasLabel,
            eventTimeMs: provisionalSummary.eventTimeMs,
          }),
        { attempts: 3, label: 'telegram-doorbell-tx-state' }
      )
    : null;

  const projected = txState
    ? await projectTelegramMonitorTxState({
        state: txState,
        users: [params.user],
        projectionOptions: { resolveTradeAmountUsdAtTx: false },
      })
    : await projectTelegramMonitorEvent({
        event: {
          sourceChatId: params.sourceChatId,
          sourceMessageId: params.sourceMessageId,
          chain: parsed.chain,
          tokenAddress: parsed.tokenAddress,
          tokenSymbol: parsed.tokenSymbol,
          txHash: parsed.txHash,
          marketCapUsd: parsed.marketCapUsd,
          priceUsd: parsed.priceUsd,
          quoteAmount: parsed.quoteAmount,
          quoteSymbol: parsed.quoteSymbol,
          action: parsed.action,
          actionLabel: parsed.actionLabel,
          actionVariant: parsed.actionVariant,
          walletLabel: parsed.walletLabel,
          walletGroupLabel: parsed.walletGroupLabel,
          walletAliasLabel: parsed.walletAliasLabel,
          trackedWalletAddress: parsed.trackedWalletAddress,
          eventTimeMs: params.eventTimeMs,
          rawText: params.rawText,
          messageLinks: params.messageLinks,
          updatedAt: Date.now(),
        },
        users: [params.user],
        projectionOptions: { resolveTradeAmountUsdAtTx: false },
      });

  const persistedProjection =
    params.feedMode === 'doorbell'
      ? projected
      : projected
        ? scoreFeedRowsAgainstDatabase([projected])[0] || null
        : null;

  if (persistedProjection && txState) {
    withSqliteBusyRetry(
      () =>
        setTelegramMonitorTxStateCanonicalActivity({
          chain: txState.chain,
          trackedWalletAddress: txState.trackedWalletAddress,
          txHash: txState.txHash,
          tokenAddress: txState.tokenAddress,
          activity: persistedProjection.activity,
        }),
      { attempts: 3, label: 'telegram-doorbell-canonical-state' }
    );
  }

  if (persistedProjection && !txState) {
    withSqliteBusyRetry(
      () =>
        updateTelegramMonitorEventProjectedActivity({
          sourceChatId: params.sourceChatId,
          sourceMessageId: params.sourceMessageId,
          txHash: parsed.txHash,
          activity: persistedProjection.activity,
        }),
      { attempts: 3, label: 'telegram-doorbell-event-projection' }
    );
  }

  if (persistedProjection) {
    if (params.feedMode === 'doorbell') {
      withSqliteBusyRetry(
        () => upsertTelegramMonitorProvisionalEventFast(persistedProjection),
        { attempts: 3, label: 'telegram-doorbell-fast-feed-upsert' }
      );
    } else {
      withSqliteBusyRetry(
        () => upsertEventsFromFeedRows([persistedProjection], 'telegram-monitor-ingest'),
        { attempts: 3, label: 'telegram-doorbell-feed-upsert' }
      );
    }

    const tweetUrls =
      params.feedMode === 'project'
        ? params.messageLinks.filter((item) => Boolean(parseTweetIdFromUrl(item)))
        : [];
    if (tweetUrls.length > 0) {
      await upsertEventTweetRefAndFetchMissing({
        eventId: persistedProjection.activity.id,
        tweetUrls,
        refSource: 'telegram-monitor',
        fetchTweetsByIds: async (ids) => {
          const fetcher = createTwitterFetcher();
          return fetcher.fetchTweetsByIds({ ids, intent: 'detail' });
        },
      });
    }
  }

  if (
    txState &&
    params.feedMode === 'project' &&
    txState.chain.trim().toLowerCase() !== 'robinhood' &&
    params.autoReconcile
  ) {
    void triggerTelegramMonitorReconciliation({
      chain: txState.chain,
      trackedWalletAddress: txState.trackedWalletAddress,
      txHash: txState.txHash,
    });
  }

  return {
    projected: Boolean(persistedProjection),
    txState,
  };
}
