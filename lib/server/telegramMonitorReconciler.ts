import 'server-only';

import {
  groupTransactionsByHash,
  collectTokenFlows,
  summarizeFlows,
  pickDominantFlow,
  isNativeAsset,
} from '@/lib/parsing/core';
import { convertToActivity } from '@/lib/parsing/toActivity';
import {
  fetchOkxTransactionDetailByTxHash,
  fetchOkxTransactionsByAddress,
  type OkxTransaction,
  type OkxTransactionDetailTokenTransfer,
} from '@/lib/okx';
import { buildTelegramMonitorTxAggregateKey } from '@/lib/telegramMonitorIdentity';
import { buildActivityFromSnapshotSync, repairCollapsedCanonicalActivity, type MonitorActivitySnapshot } from '@/lib/server/telegramMonitorActivity';
import { buildTradeDisplayMetadata, formatDisplayTradeAmount } from '@/lib/tradeDisplay';
import { liveMonitorOwnsWalletTx, upsertEventsFromFeedRows } from '@/lib/server/eventsRepo';
import { scoreFeedRowsAgainstDatabase } from '@/lib/server/activityImportanceService';
import { isSqliteBusyError } from '@/lib/server/sqlite';
import { isOnchainStockToken } from '@/lib/onchainStockTokens';
import {
  claimTelegramMonitorTxStatesForRepair,
  getTelegramMonitorTxState,
  markTelegramMonitorTxStateFailed,
  markTelegramMonitorTxStateReconciled,
} from '@/lib/server/telegramMonitorTxStateRepo';
import { listMonitoredUsers } from '@/lib/server/trackedUsersRepo';
import type { Activity, AddressInfo, User } from '@/types';
import type { TokenFlow } from '@/lib/parsing/types';

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
  const users = listMonitoredUsers();
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

function isStableFlow(flow: TokenFlow) {
  const symbol = (flow.symbol || '').trim().toLowerCase();
  return symbol === 'usdt' || symbol === 'usdc' || symbol === 'dai';
}

function findCounterFlow(
  primaryAction: 'buy' | 'sell' | 'send' | 'receive',
  transactions: OkxTransaction[],
  userAddressLower: string,
  chain: string
): { flow: TokenFlow; transactions: OkxTransaction[] } | null {
  const flows = collectTokenFlows(transactions, chain, userAddressLower);
  const summary = summarizeFlows(flows);

  const tradeFlows = (primaryAction === 'sell' || primaryAction === 'send'
    ? summary.incomingNonNative
    : summary.outgoingNonNative
  ).filter((flow) => !isStableFlow(flow));

  if (tradeFlows.length === 0) {
    return null;
  }

  const dominant = pickDominantFlow(tradeFlows);
  if (!dominant) {
    return null;
  }

  const counterTxHashes = new Set<string>();
  for (const tx of transactions) {
    const hash = (tx.txHash || '').trim().toLowerCase();
    if (hash) counterTxHashes.add(hash);
  }

  const counterTransactions = transactions.filter((tx) => {
    const txTokenAddr = (tx.tokenContractAddress || tx.tokenAddress || '').trim().toLowerCase();
    const txSymbol = (tx.symbol || '').trim().toLowerCase();
    const flowTokenAddr = (dominant.tokenAddress || '').trim().toLowerCase();
    const flowSymbol = (dominant.symbol || '').trim().toLowerCase();
    return (
      (txTokenAddr === flowTokenAddr) ||
      (!txTokenAddr && txSymbol === flowSymbol)
    );
  });

  return {
    flow: dominant,
    transactions: counterTransactions.length > 0 ? counterTransactions : transactions,
  };
}

async function persistCounterFlowEvent(
  primaryAction: 'buy' | 'sell',
  transactions: OkxTransaction[],
  params: {
    user: User;
    addressInfo: AddressInfo;
    state: {
      chain: string;
      trackedWalletAddress: string;
      txHash: string;
      provisionalRawText: string | null;
      provisionalWalletLabel: string | null;
      provisionalWalletGroupLabel: string | null;
      provisionalWalletAliasLabel: string | null;
      eventTimeMs: number;
    };
  }
): Promise<boolean> {
  // live-monitor already recorded this wallet+tx (usually the real meme leg).
  // Counter-flow often invents the opposite native/stable leg (e.g. buy WETH for a sell).
  if (
    liveMonitorOwnsWalletTx({
      userId: params.user.id,
      chain: params.state.chain,
      trackedAddress: params.state.trackedWalletAddress,
      txHash: params.state.txHash,
    })
  ) {
    return false;
  }

  const userAddressLower = normalize(params.addressInfo.address);
  const counterFlow = findCounterFlow(primaryAction, transactions, userAddressLower, params.state.chain);
  if (!counterFlow) {
    return false;
  }

  const tokenAddress = (counterFlow.flow.tokenAddress || '').trim();
  // Drop on-chain stock tokens (tokenized stock, e.g. SPCXB 借道 Routing) — 这条 counter-flow
  // 常把 swap 借道的股票代币当成"另一腿"产出来,不是监控人物的 meme 意图,不进 feed。
  if (isOnchainStockToken({ tokenAddress })) {
    return false;
  }
  const primaryTransactions = transactions.filter((tx) => {
    const txTokenAddr = (tx.tokenContractAddress || tx.tokenAddress || '').trim().toLowerCase();
    const txSymbol = (tx.symbol || '').trim().toLowerCase();
    const flowTokenAddr = tokenAddress.toLowerCase();
    const flowSymbol = (counterFlow.flow.symbol || '').trim().toLowerCase();
    return (
      (txTokenAddr === flowTokenAddr) ||
      (!txTokenAddr && txSymbol === flowSymbol)
    );
  });

  const canonicalCounter = primaryTransactions.length > 0
    ? await buildCanonicalActivityFromTransactions({
        user: params.user,
        addressInfo: params.addressInfo,
        transactions: primaryTransactions,
      })
    : null;

  if (!canonicalCounter) {
    return false;
  }

  const snapshot: MonitorActivitySnapshot = {
    user: params.user,
    chain: params.state.chain,
    tokenAddress,
    tokenSymbol: counterFlow.flow.symbol || null,
    txHash: params.state.txHash,
    marketCapUsd: null,
    quoteAmount: null,
    quoteSymbol: null,
    tokenAmount: counterFlow.flow.amount,
    explicitPriceUsd: null,
    rawText: params.state.provisionalRawText,
    action: primaryAction === 'sell' ? 'buy' : 'sell',
    actionLabel: primaryAction === 'sell' ? '建仓' : '减仓',
    actionVariant: primaryAction === 'sell' ? 'open' : 'reduce',
    walletLabel: params.state.provisionalWalletLabel,
    walletGroupLabel: params.state.provisionalWalletGroupLabel,
    walletAliasLabel: params.state.provisionalWalletAliasLabel,
    eventTimeMs: params.state.eventTimeMs,
    trackedAddress: params.state.trackedWalletAddress,
    monitorReconciliationStatus: 'reconciled',
    monitorReconciledSource: 'okx-address',
  };

  const counterActivity = buildActivityFromSnapshotSync(snapshot, { tradeAmountUsdAtTx: null });

  const aggregateKey = buildTelegramMonitorTxAggregateKey(
    params.state.chain,
    params.state.trackedWalletAddress,
    params.state.txHash,
    tokenAddress
  );

  const counterWithId: Activity = {
    ...counterActivity,
    id: aggregateKey || counterActivity.id,
  };

  const [scored] = scoreFeedRowsAgainstDatabase([{ user: params.user, activity: counterWithId }]);
  upsertEventsFromFeedRows([scored || { user: params.user, activity: counterWithId }], 'telegram-monitor-reconcile');
  return true;
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
    .map((transfer) => {
      const tokenContractAddress = (transfer.tokenContractAddress || '').trim();
      const rawSymbol = (transfer.symbol || '').trim();
      // Prefer real transfer symbol; if OKX omits it for WSOL/SOL mint, label as SOL
      // so downstream collapse repair can recognize native assets (not "UNKNOWN").
      let symbol = rawSymbol;
      if (!symbol) {
        if (isNativeAsset('solana', '', tokenContractAddress)) {
          symbol = 'SOL';
        } else {
          symbol = 'UNKNOWN';
        }
      }
      return {
        txHash: params.txHash,
        txTime: String(params.txTimeMs),
        iType: '2',
        symbol,
        amount: transfer.amount || '',
        tokenContractAddress,
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
      } satisfies OkxTransaction;
    });
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

async function persistReconciledMonitorActivity(params: {
  state: {
    chain: string;
    tokenAddress: string | null;
    tokenSymbol: string | null;
    trackedWalletAddress: string;
    txHash: string;
    provisionalAction: 'buy' | 'sell' | 'send' | null;
    provisionalActionLabel: '建仓' | '加仓' | '减仓' | '清仓' | '发送' | null;
    provisionalActionVariant: 'open' | 'add' | 'reduce' | 'close' | 'send' | null;
    provisionalQuoteAmount: number | null;
    provisionalQuoteSymbol: string | null;
    provisionalTokenAmount: number | null;
    provisionalTokenSymbol: string | null;
    provisionalPriceUsd: number | null;
    provisionalMarketCapUsd: number | null;
    provisionalRawText: string | null;
    provisionalWalletLabel: string | null;
    provisionalWalletGroupLabel: string | null;
    provisionalWalletAliasLabel: string | null;
    eventTimeMs: number;
    reconciliationStatus: 'pending' | 'reconciled' | 'failed';
    reconciledSource: 'xxyy' | 'okx-address' | 'okx-detail' | null;
  };
  user: User;
  activity: Activity;
  source: 'okx-address' | 'okx-detail';
}) {
  const reconciliationMarketCapUsd = resolveReconciliationMarketCapUsd({
    provisionalMarketCapUsd: params.state.provisionalMarketCapUsd,
    provisionalPriceUsd: params.state.provisionalPriceUsd,
    activity: params.activity,
  });
  const decoratedActivity = decorateCanonicalMonitorActivity({
    activity: params.activity,
    trackedWalletAddress: params.state.trackedWalletAddress,
    txHash: params.state.txHash,
    status: 'reconciled',
    source: params.source,
    marketCapUsd: reconciliationMarketCapUsd,
    rawText: params.state.provisionalRawText,
    walletLabel: params.state.provisionalWalletLabel,
    walletGroupLabel: params.state.provisionalWalletGroupLabel,
    walletAliasLabel: params.state.provisionalWalletAliasLabel,
  });
  const repairedActivity = await repairCollapsedCanonicalActivity({
    user: params.user,
    state: {
      chain: params.state.chain,
      trackedWalletAddress: params.state.trackedWalletAddress,
      txHash: params.state.txHash,
      tokenAddress: params.state.tokenAddress,
      tokenSymbol: params.state.tokenSymbol,
      provisionalAction: params.state.provisionalAction,
      provisionalActionLabel: params.state.provisionalActionLabel,
      provisionalActionVariant: params.state.provisionalActionVariant,
      provisionalQuoteAmount: params.state.provisionalQuoteAmount,
      provisionalQuoteSymbol: params.state.provisionalQuoteSymbol,
      provisionalTokenAmount: params.state.provisionalTokenAmount,
      provisionalTokenSymbol: params.state.provisionalTokenSymbol,
      provisionalPriceUsd:
        reconciliationMarketCapUsd == null ? null : params.state.provisionalPriceUsd,
      provisionalMarketCapUsd: reconciliationMarketCapUsd,
      provisionalRawText: params.state.provisionalRawText,
      provisionalWalletLabel: params.state.provisionalWalletLabel,
      provisionalWalletGroupLabel: params.state.provisionalWalletGroupLabel,
      provisionalWalletAliasLabel: params.state.provisionalWalletAliasLabel,
      eventTimeMs: params.state.eventTimeMs,
      reconciliationStatus: 'reconciled',
      reconciledSource: params.source,
    },
    canonicalActivity: decoratedActivity,
  });
  const [scoredCanonical] = scoreFeedRowsAgainstDatabase([{ user: params.user, activity: repairedActivity }]);
  const canonicalForWrite = scoredCanonical || { user: params.user, activity: repairedActivity };

  markTelegramMonitorTxStateReconciled({
    chain: params.state.chain,
    trackedWalletAddress: params.state.trackedWalletAddress,
    txHash: params.state.txHash,
    tokenAddress: params.state.tokenAddress,
    activity: canonicalForWrite.activity,
    source: params.source,
  });
  upsertEventsFromFeedRows([canonicalForWrite], 'telegram-monitor-reconcile');

  return {
    ok: true,
    status: 'reconciled' as const,
    source: params.source,
  };
}

/**
 * XXYY 推送的 MCAP/价格只反映它抓到的那一条成交腿。聚合器拆单(一笔 tx 拆
 * 多个池同时买入)时推送会整体低估:实测案例 0xb488abd3(2026-09-29 BSC),
 * 2 BNB 拆 3 腿共 ~1510 USDT,推送只报 0.66 BNB 一腿,MC 78.6K(真实 ~234.8K)。
 * 对账拿到了链上真实成交价(tradeAmountUsdAtTx / tokenAmount),推送价与
 * 链上价偏差超过容差即视为推送只覆盖部分腿,MC 置空,让下游走估算兜底。
 */
const PROVISIONAL_MARKET_CAP_TOLERANCE = 0.25;

function resolveReconciliationMarketCapUsd(params: {
  provisionalMarketCapUsd: number | null;
  provisionalPriceUsd: number | null;
  activity: Activity;
}): number | null {
  const { provisionalMarketCapUsd, provisionalPriceUsd, activity } = params;
  if (
    provisionalMarketCapUsd == null ||
    !Number.isFinite(provisionalMarketCapUsd) ||
    provisionalMarketCapUsd <= 0
  ) {
    return null;
  }
  const tokenAmount = Number.parseFloat(String(activity.metadata.value ?? ''));
  const amountUsd = activity.metadata.tradeAmountUsdAtTx;
  if (
    !Number.isFinite(tokenAmount) ||
    tokenAmount <= 0 ||
    amountUsd == null ||
    !Number.isFinite(amountUsd) ||
    amountUsd <= 0
  ) {
    // 链上数据不完整,无法证伪 → 保守保留推送 MC(维持既有行为)
    return provisionalMarketCapUsd;
  }
  const provisionalPrice =
    provisionalPriceUsd != null && Number.isFinite(provisionalPriceUsd) && provisionalPriceUsd > 0
      ? provisionalPriceUsd
      : null;
  if (!provisionalPrice) {
    return provisionalMarketCapUsd;
  }
  const onchainPrice = amountUsd / tokenAmount;
  const ratio = provisionalPrice / onchainPrice;
  if (
    ratio >= 1 - PROVISIONAL_MARKET_CAP_TOLERANCE &&
    ratio <= 1 + PROVISIONAL_MARKET_CAP_TOLERANCE
  ) {
    return provisionalMarketCapUsd;
  }
  return null;
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
    params.txHash,
    params.activity.metadata.tokenAddress
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
      tokenAddress: state.tokenAddress,
      error: 'tracked-user-not-found',
    });
    return {
      ok: false,
      status: failed ? 'failed' : 'skipped',
      error: 'tracked-user-not-found',
    };
  }

  try {
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
          const primaryAction = canonicalFromDetail.metadata.txAction;
          const primaryResult = await persistReconciledMonitorActivity({
            state,
            user: trackedUser.user,
            activity: canonicalFromDetail,
            source: 'okx-detail',
          });

          if (primaryAction === 'buy' || primaryAction === 'sell') {
            void persistCounterFlowEvent(primaryAction, syntheticTransactions, {
              user: trackedUser.user,
              addressInfo: trackedUser.addressInfo,
              state: {
                chain: state.chain,
                trackedWalletAddress: state.trackedWalletAddress,
                txHash: state.txHash,
                provisionalRawText: state.provisionalRawText,
                provisionalWalletLabel: state.provisionalWalletLabel,
                provisionalWalletGroupLabel: state.provisionalWalletGroupLabel,
                provisionalWalletAliasLabel: state.provisionalWalletAliasLabel,
                eventTimeMs: state.eventTimeMs,
              },
            });
          }

          return primaryResult;
        }
      }
    }

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
          const primaryAction = canonicalFromAddress.metadata.txAction;
          const primaryResult = await persistReconciledMonitorActivity({
            state,
            user: trackedUser.user,
            activity: canonicalFromAddress,
            source: 'okx-address',
          });

          if (primaryAction === 'buy' || primaryAction === 'sell') {
            void persistCounterFlowEvent(primaryAction, matchingTransactions, {
              user: trackedUser.user,
              addressInfo: trackedUser.addressInfo,
              state: {
                chain: state.chain,
                trackedWalletAddress: state.trackedWalletAddress,
                txHash: state.txHash,
                provisionalRawText: state.provisionalRawText,
                provisionalWalletLabel: state.provisionalWalletLabel,
                provisionalWalletGroupLabel: state.provisionalWalletGroupLabel,
                provisionalWalletAliasLabel: state.provisionalWalletAliasLabel,
                eventTimeMs: state.eventTimeMs,
              },
            });
          }

          return primaryResult;
        }
      }
    }

    const detailError = detailResult.ok ? 'detail-missing' : detailResult.error;
    const addressError = addressResult.ok ? 'address-missing' : addressResult.error;
    const errorText = [detailError, addressError].filter(Boolean).join('; ') || 'unable-to-build-canonical-activity';
    markTelegramMonitorTxStateFailed({
      chain: state.chain,
      trackedWalletAddress: state.trackedWalletAddress,
      txHash: state.txHash,
      tokenAddress: state.tokenAddress,
      error: errorText,
    });
    return {
      ok: false,
      status: 'failed',
      error: errorText,
    };
  } catch (error) {
    const errorText = error instanceof Error ? error.message : 'unknown-reconciliation-error';
    // SQLITE_BUSY:另一进程持有写锁,保持 pending 让循环下次重试;
    // 其余错误(API 超时、地址无效等)标 failed 停牌。
    if (!isSqliteBusyError(error)) {
      markTelegramMonitorTxStateFailed({
        chain: state.chain,
        trackedWalletAddress: state.trackedWalletAddress,
        txHash: state.txHash,
        tokenAddress: state.tokenAddress,
        error: errorText,
      });
      return {
        ok: false,
        status: 'failed',
        error: errorText,
      };
    }
    console.warn(
      `[reconcile] ${state.chain}:${state.txHash.slice(0, 10)} locked, skipping (will retry):`,
      errorText
    );
    return {
      ok: false,
      status: 'skipped',
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
    // Robinhood is feed-only and has no OKX reconciliation support.
    if (normalize(target.chain) === 'robinhood') {
      continue;
    }
    void triggerTelegramMonitorReconciliation({
      chain: target.chain,
      trackedWalletAddress: target.trackedWalletAddress,
      txHash: target.txHash,
    });
  }

  return targets.length;
}

const REPAIR_BATCH_SIZE_DEFAULT = 8;
const REPAIR_MAX_BATCH_SIZE = 32;

export interface TelegramMonitorRepairCycleResult {
  claimed: number;
  reconciled: number;
  failed: number;
  skipped: number;
  lastError: string | null;
}

/**
 * 修复积压的 pending monitor 状态。ingest 内联对账只覆盖新推送;这里按租约
 * 批量认领补偿历史积压。只认领 pending 且非 robinhood(链上对账不支持)的行:
 * failed 行重试只会反复烧 OKX 配额,保持停牌,除非新推送重新内联触发。
 */
export async function runTelegramMonitorRepairCycle(params?: {
  batchSize?: number;
}): Promise<TelegramMonitorRepairCycleResult> {
  const envBatch = Number(process.env.PILI_TELEGRAM_MONITOR_REPAIR_BATCH || '');
  const configured =
    Number.isFinite(envBatch) && envBatch > 0 ? Math.floor(envBatch) : REPAIR_BATCH_SIZE_DEFAULT;
  const batchSize = Math.max(1, Math.min(params?.batchSize ?? configured, REPAIR_MAX_BATCH_SIZE));

  const targets = claimTelegramMonitorTxStatesForRepair({
    limit: batchSize,
    leaseMs: REPAIR_CLAIM_LEASE_MS,
    backlogOnly: true,
  });

  const results = await Promise.all(
    targets.map((target) =>
      triggerTelegramMonitorReconciliation({
        chain: target.chain,
        trackedWalletAddress: target.trackedWalletAddress,
        txHash: target.txHash,
      })
    )
  );

  let reconciled = 0;
  let failed = 0;
  let skipped = 0;
  let lastError: string | null = null;
  for (const result of results) {
    if (result.status === 'reconciled') reconciled += 1;
    else if (result.status === 'failed') {
      failed += 1;
      lastError = result.error ?? lastError;
    } else {
      skipped += 1;
    }
  }

  return { claimed: targets.length, reconciled, failed, skipped, lastError };
}
