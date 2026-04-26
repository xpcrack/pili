import 'server-only';

import { groupTransactionsByHash } from '@/lib/parsing/core';
import { convertToActivity } from '@/lib/parsing/toActivity';
import {
  fetchOkxTransactionDetailByTxHash,
  fetchOkxTransactionsByAddress,
  type OkxTransaction,
  type OkxTransactionDetailTokenTransfer,
} from '@/lib/okx';
import { buildTelegramMonitorTxAggregateKey } from '@/lib/telegramMonitorIdentity';
import { buildTradeDisplayMetadata, formatDisplayTradeAmount } from '@/lib/tradeDisplay';
import { upsertEventsFromFeedRows } from '@/lib/server/eventsRepo';
import {
  claimTelegramMonitorTxStatesForRepair,
  getTelegramMonitorTxState,
  markTelegramMonitorTxStateFailed,
  markTelegramMonitorTxStateReconciled,
} from '@/lib/server/telegramMonitorTxStateRepo';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import type { Activity, AddressInfo, User } from '@/types';

const TX_RECONCILE_WINDOW_MS = 5 * 60 * 1000;
const MAX_PARALLEL_REPAIRS = 2;
const REPAIR_CLAIM_LEASE_MS = 60 * 1000;

const inFlightReconciliations = new Map<string, Promise<ReconcileTelegramMonitorTxResult>>();

function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

function makeInFlightKey(chain: string, trackedWalletAddress: string, txHash: string) {
  return `${normalize(chain)}|${normalize(trackedWalletAddress)}|${normalize(txHash)}`;
}

function findTrackedUser(state: {
  userId: string;
  chain: string;
  trackedWalletAddress: string;
}) {
  const users = listTrackedUsers();
  const user = users.find((candidate) => candidate.id === state.userId);
  if (!user) {
    return null;
  }

  const addressInfo =
    user.addresses.find(
      (address) =>
        normalize(address.chain) === normalize(state.chain) &&
        normalize(address.address) === normalize(state.trackedWalletAddress)
    ) || user.addresses.find((address) => normalize(address.address) === normalize(state.trackedWalletAddress));

  if (!addressInfo) {
    return null;
  }

  return {
    user,
    addressInfo,
  };
}

function createSyntheticTransactionsFromDetail(params: {
  txHash: string;
  txTimeMs: number;
  transfers: OkxTransactionDetailTokenTransfer[];
  trackedWalletAddress: string;
}) {
  const trackedLower = normalize(params.trackedWalletAddress);

  return params.transfers
    .filter((transfer) => {
      const amount = Number.parseFloat((transfer.amount || '').trim());
      if (!Number.isFinite(amount) || amount <= 0) {
        return false;
      }
      const fromLower = normalize(transfer.from);
      const toLower = normalize(transfer.to);
      return (fromLower === trackedLower) !== (toLower === trackedLower);
    })
    .map(
      (transfer) =>
        ({
          txHash: params.txHash,
          txTime: String(params.txTimeMs),
          iType: '2',
          symbol: (transfer.symbol || '').trim() || 'UNKNOWN',
          amount: transfer.amount || '',
          tokenContractAddress: transfer.tokenContractAddress || '',
          from: [
            {
              address: transfer.from || '',
              amount: transfer.amount || '',
            },
          ],
          to: [
            {
              address: transfer.to || '',
              amount: transfer.amount || '',
            },
          ],
          txStatus: 'success',
        }) satisfies OkxTransaction
    );
}

async function buildCanonicalActivityFromTransactions(params: {
  user: User;
  addressInfo: AddressInfo;
  transactions: OkxTransaction[];
}) {
  const groups = groupTransactionsByHash(params.transactions).filter(
    (group) => normalize(group.txHash) === normalize(params.transactions[0]?.txHash)
  );
  if (groups.length === 0) {
    return null;
  }

  const activity = await convertToActivity({
    group: groups[0],
    user: params.user,
    addressInfo: params.addressInfo,
    requireTrackedInitiator: true,
  });

  return activity;
}

function decorateCanonicalMonitorActivity(params: {
  activity: Activity;
  trackedWalletAddress: string;
  txHash: string;
  status: 'reconciled';
  source: 'okx-address' | 'okx-detail';
  marketCapUsd: number | null;
  rawText: string | null;
  walletLabel: string | null;
  walletGroupLabel: string | null;
  walletAliasLabel: string | null;
}) {
  const aggregateKey = buildTelegramMonitorTxAggregateKey(
    params.activity.metadata.chain,
    params.trackedWalletAddress,
    params.txHash
  );
  const displayMetadata = buildTradeDisplayMetadata({
    walletLabel: params.walletAliasLabel || params.walletLabel,
    fallbackWalletLabel: params.walletAliasLabel || params.walletLabel || params.activity.metadata.displayWalletLabel,
    actionVariant: params.activity.metadata.txActionVariant,
    txActionLabel: params.activity.metadata.txActionLabel,
    quoteAmount: params.activity.metadata.quoteAmount || null,
    quoteToken: params.activity.metadata.quoteToken || null,
    value: params.activity.metadata.value || null,
    tokenSymbol: params.activity.metadata.token || null,
    marketCapUsd: params.marketCapUsd,
    tokenAddress: params.activity.metadata.tokenAddress || null,
  });

  return {
    ...params.activity,
    id: aggregateKey || params.activity.id,
    metadata: {
      ...params.activity.metadata,
      trackedAddress: params.trackedWalletAddress,
      rawText: params.rawText || undefined,
      monitorWalletLabel: params.walletLabel || undefined,
      monitorWalletGroupLabel: params.walletGroupLabel || undefined,
      monitorWalletAliasLabel: params.walletAliasLabel || undefined,
      marketCapAtTxUsd:
        typeof params.marketCapUsd === 'number' && Number.isFinite(params.marketCapUsd)
          ? params.marketCapUsd
          : params.activity.metadata.marketCapAtTxUsd,
      marketCapAtTxSource:
        typeof params.marketCapUsd === 'number' && Number.isFinite(params.marketCapUsd)
          ? 'telegram-monitor-exact'
          : params.activity.metadata.marketCapAtTxSource,
      monitorReconciliationStatus: params.status,
      monitorReconciledSource: params.source,
      monitorTxAggregateKey: aggregateKey || undefined,
      displayWalletLabel: displayMetadata.displayWalletLabel,
      displayActionVariantLabel: displayMetadata.displayActionVariantLabel,
      displayTradeAmountText:
        formatDisplayTradeAmount(params.activity.metadata.quoteAmount, params.activity.metadata.quoteToken) ||
        formatDisplayTradeAmount(params.activity.metadata.value, params.activity.metadata.token) ||
        params.activity.metadata.displayTradeAmountText,
      displayTokenSymbol: displayMetadata.displayTokenSymbol,
      displayMarketCapText: displayMetadata.displayMarketCapText,
      displayTokenAvatarTokenAddress: displayMetadata.displayTokenAvatarTokenAddress,
    },
  } satisfies Activity;
}

export interface ReconcileTelegramMonitorTxResult {
  ok: boolean;
  status: 'reconciled' | 'failed' | 'skipped';
  source?: 'okx-address' | 'okx-detail';
  error?: string;
}

export async function reconcileTelegramMonitorTxState(params: {
  chain: string;
  trackedWalletAddress: string;
  txHash: string;
  force?: boolean;
}): Promise<ReconcileTelegramMonitorTxResult> {
  const state = getTelegramMonitorTxState(params);
  if (!state) {
    return {
      ok: false,
      status: 'skipped',
      error: 'tx-state-not-found',
    };
  }

  if (!params.force && state.reconciliationStatus === 'reconciled' && state.canonicalActivity) {
    return {
      ok: true,
      status: 'reconciled',
      source: state.reconciledSource === 'okx-detail' ? 'okx-detail' : 'okx-address',
    };
  }

  const trackedUser = findTrackedUser(state);
  if (!trackedUser) {
    const failed = markTelegramMonitorTxStateFailed({
      chain: state.chain,
      trackedWalletAddress: state.trackedWalletAddress,
      txHash: state.txHash,
      error: 'tracked-user-not-found',
    });
    return {
      ok: false,
      status: failed ? 'failed' : 'skipped',
      error: 'tracked-user-not-found',
    };
  }

  try {
    const beginMs = Math.max(0, state.eventTimeMs - TX_RECONCILE_WINDOW_MS);
    const endMs = state.eventTimeMs + TX_RECONCILE_WINDOW_MS;
    const addressResult = await fetchOkxTransactionsByAddress(state.trackedWalletAddress, state.chain, {
      beginMs,
      endMs,
    });

    if (addressResult.ok) {
      const matchingTransactions = addressResult.transactions.filter(
        (transaction) => normalize(transaction.txHash) === normalize(state.txHash)
      );
      if (matchingTransactions.length > 0) {
        const canonicalFromAddress = await buildCanonicalActivityFromTransactions({
          user: trackedUser.user,
          addressInfo: trackedUser.addressInfo,
          transactions: matchingTransactions,
        });

        if (canonicalFromAddress) {
          const activity = decorateCanonicalMonitorActivity({
            activity: canonicalFromAddress,
            trackedWalletAddress: state.trackedWalletAddress,
            txHash: state.txHash,
            status: 'reconciled',
            source: 'okx-address',
            marketCapUsd: state.provisionalMarketCapUsd,
            rawText: state.provisionalRawText,
            walletLabel: state.provisionalWalletLabel,
            walletGroupLabel: state.provisionalWalletGroupLabel,
            walletAliasLabel: state.provisionalWalletAliasLabel,
          });
          markTelegramMonitorTxStateReconciled({
            chain: state.chain,
            trackedWalletAddress: state.trackedWalletAddress,
            txHash: state.txHash,
            activity,
            source: 'okx-address',
          });
          upsertEventsFromFeedRows([{ user: trackedUser.user, activity }], 'telegram-monitor-reconcile');
          return {
            ok: true,
            status: 'reconciled',
            source: 'okx-address',
          };
        }
      }
    }

    const detailResult = await fetchOkxTransactionDetailByTxHash(state.txHash, state.chain);
    if (detailResult.ok && detailResult.detail) {
      const syntheticTransactions = createSyntheticTransactionsFromDetail({
        txHash: state.txHash,
        txTimeMs: state.eventTimeMs,
        transfers: detailResult.detail.tokenTransferDetails || [],
        trackedWalletAddress: state.trackedWalletAddress,
      });

      if (syntheticTransactions.length > 0) {
        const canonicalFromDetail = await buildCanonicalActivityFromTransactions({
          user: trackedUser.user,
          addressInfo: trackedUser.addressInfo,
          transactions: syntheticTransactions,
        });

        if (canonicalFromDetail) {
          const activity = decorateCanonicalMonitorActivity({
            activity: canonicalFromDetail,
            trackedWalletAddress: state.trackedWalletAddress,
            txHash: state.txHash,
            status: 'reconciled',
            source: 'okx-detail',
            marketCapUsd: state.provisionalMarketCapUsd,
            rawText: state.provisionalRawText,
            walletLabel: state.provisionalWalletLabel,
            walletGroupLabel: state.provisionalWalletGroupLabel,
            walletAliasLabel: state.provisionalWalletAliasLabel,
          });
          markTelegramMonitorTxStateReconciled({
            chain: state.chain,
            trackedWalletAddress: state.trackedWalletAddress,
            txHash: state.txHash,
            activity,
            source: 'okx-detail',
          });
          upsertEventsFromFeedRows([{ user: trackedUser.user, activity }], 'telegram-monitor-reconcile');
          return {
            ok: true,
            status: 'reconciled',
            source: 'okx-detail',
          };
        }
      }
    }

    const addressError = addressResult.ok ? null : addressResult.error;
    const detailError = detailResult.ok ? 'detail-missing' : detailResult.error;
    const errorText = [addressError, detailError].filter(Boolean).join('; ') || 'unable-to-build-canonical-activity';
    markTelegramMonitorTxStateFailed({
      chain: state.chain,
      trackedWalletAddress: state.trackedWalletAddress,
      txHash: state.txHash,
      error: errorText,
    });
    return {
      ok: false,
      status: 'failed',
      error: errorText,
    };
  } catch (error) {
    const errorText = error instanceof Error ? error.message : 'unknown-reconciliation-error';
    markTelegramMonitorTxStateFailed({
      chain: state.chain,
      trackedWalletAddress: state.trackedWalletAddress,
      txHash: state.txHash,
      error: errorText,
    });
    return {
      ok: false,
      status: 'failed',
      error: errorText,
    };
  }
}

export function triggerTelegramMonitorReconciliation(params: {
  chain: string;
  trackedWalletAddress: string;
  txHash: string;
  force?: boolean;
}) {
  const key = makeInFlightKey(params.chain, params.trackedWalletAddress, params.txHash);
  const existing = inFlightReconciliations.get(key);
  if (existing) {
    return existing;
  }

  const task = reconcileTelegramMonitorTxState(params).finally(() => {
    inFlightReconciliations.delete(key);
  });
  inFlightReconciliations.set(key, task);
  return task;
}

export function scheduleTelegramMonitorRepairBatch(limit = 5) {
  const targets = claimTelegramMonitorTxStatesForRepair({
    limit: Math.max(1, Math.min(MAX_PARALLEL_REPAIRS, Math.floor(limit))),
    leaseMs: REPAIR_CLAIM_LEASE_MS,
  });
  for (const target of targets) {
    void triggerTelegramMonitorReconciliation({
      chain: target.chain,
      trackedWalletAddress: target.trackedWalletAddress,
      txHash: target.txHash,
    });
  }

  return targets.length;
}
