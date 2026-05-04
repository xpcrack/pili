import 'server-only';

import { buildTelegramMonitorTxAggregateKey } from '@/lib/telegramMonitorIdentity';
import { buildTradeDisplayMetadata } from '@/lib/tradeDisplay';
import { resolveTradeAmountUsdAtTx } from '@/lib/tradeUsd';
import type { Activity, User } from '@/types';

function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

function normalizeText(value: string | null | undefined) {
  return (value || '').trim();
}

function pickFirstText(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

const NATIVE_SYMBOLS_BY_CHAIN: Record<string, Set<string>> = {
  bsc: new Set(['bnb', 'wbnb']),
  solana: new Set(['sol', 'wsol']),
  ethereum: new Set(['eth', 'weth']),
  base: new Set(['eth', 'weth']),
};

function isNativeSymbol(chain: string | null | undefined, symbol: string | null | undefined) {
  const normalizedChain = normalize(chain);
  const normalizedSymbol = normalize(symbol);
  if (!normalizedChain || !normalizedSymbol) {
    return false;
  }
  return NATIVE_SYMBOLS_BY_CHAIN[normalizedChain]?.has(normalizedSymbol) ?? false;
}

export interface MonitorActivitySnapshot {
  user: User;
  chain: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  txHash: string | null;
  marketCapUsd: number | null;
  quoteAmount: number | null;
  quoteSymbol: string | null;
  tokenAmount: number | null;
  explicitPriceUsd: number | null;
  rawText: string | null;
  action: 'buy' | 'sell' | 'send' | null;
  actionLabel: '建仓' | '加仓' | '减仓' | '清仓' | '发送' | null;
  actionVariant: 'open' | 'add' | 'reduce' | 'close' | 'send' | null;
  walletLabel: string | null;
  walletGroupLabel: string | null;
  walletAliasLabel: string | null;
  eventTimeMs: number;
  trackedAddress: string | null;
  monitorReconciliationStatus?: 'pending' | 'reconciled' | 'failed';
  monitorReconciledSource?: 'xxyy' | 'okx-address' | 'okx-detail' | null;
}

export interface MonitorCanonicalRepairState {
  chain: string;
  trackedWalletAddress: string;
  txHash: string;
  tokenAddress: string | null;
  tokenSymbol: string | null;
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
}

function buildActivityFromSnapshotCore(params: MonitorActivitySnapshot, tradeAmountUsdAtTx: number | null) {
  const {
    user,
    chain,
    tokenAddress,
    tokenSymbol,
    txHash,
    marketCapUsd,
    quoteAmount,
    quoteSymbol,
    tokenAmount,
    rawText,
    action,
    actionLabel,
    actionVariant,
    walletLabel,
    walletGroupLabel,
    walletAliasLabel,
    eventTimeMs,
    trackedAddress,
    monitorReconciliationStatus,
    monitorReconciledSource,
  } = params;

  const aggregateKey = buildTelegramMonitorTxAggregateKey(chain, trackedAddress, txHash);
  const actionText =
    actionLabel || (action === 'sell' ? '减仓' : action === 'buy' ? '建仓' : action === 'send' ? '发送' : '交易');
  const quoteText =
    typeof quoteAmount === 'number' && Number.isFinite(quoteAmount) && quoteSymbol
      ? `${quoteAmount}${quoteSymbol.toUpperCase()}`
      : '';
  const symbolText = (tokenSymbol || 'TOKEN').toUpperCase();
  const fallbackTokenText =
    typeof tokenAmount === 'number' && Number.isFinite(tokenAmount) ? `${tokenAmount} ${symbolText}` : symbolText;
  const displayMetadata = buildTradeDisplayMetadata({
    rawText,
    walletLabel,
    fallbackWalletLabel: user.name,
    actionVariant,
    txActionLabel: actionLabel,
    quoteAmount,
    quoteToken: quoteSymbol,
    value: typeof tokenAmount === 'number' && Number.isFinite(tokenAmount) ? String(tokenAmount) : null,
    tokenSymbol,
    marketCapUsd,
    tokenAddress,
  });

  return {
    id: aggregateKey || `xxyy-monitor:${chain}:${txHash || tokenAddress}:${eventTimeMs}`,
    userId: user.id,
    source: 'blockchain',
    type: 'transfer',
    title: 'XXYY监控交易',
    content: `${actionText}${quoteText ? quoteText : ` ${fallbackTokenText}`}`.trim(),
    timestamp: eventTimeMs,
    metadata: {
      txHash: txHash || undefined,
      token: tokenSymbol || undefined,
      tokenAddress,
      quoteAmount:
        typeof quoteAmount === 'number' && Number.isFinite(quoteAmount) ? String(quoteAmount) : undefined,
      quoteToken: quoteSymbol || undefined,
      chain,
      txAction: action || undefined,
      txActionLabel: actionLabel || undefined,
      txActionVariant: actionVariant || undefined,
      value: typeof tokenAmount === 'number' && Number.isFinite(tokenAmount) ? String(tokenAmount) : undefined,
      trackedAddress: trackedAddress || undefined,
      rawText: rawText || undefined,
      monitorWalletLabel: walletLabel || undefined,
      monitorWalletGroupLabel: walletGroupLabel || undefined,
      monitorWalletAliasLabel: walletAliasLabel || undefined,
      marketCapAtTxUsd:
        typeof marketCapUsd === 'number' && Number.isFinite(marketCapUsd) ? marketCapUsd : undefined,
      tradeAmountUsdAtTx: tradeAmountUsdAtTx ?? undefined,
      marketCapAtTxSource:
        typeof marketCapUsd === 'number' && Number.isFinite(marketCapUsd) ? 'telegram-monitor-exact' : undefined,
      monitorReconciliationStatus: monitorReconciliationStatus || undefined,
      monitorReconciledSource: monitorReconciledSource || undefined,
      monitorTxAggregateKey: aggregateKey || undefined,
      ...displayMetadata,
    },
  } satisfies Activity;
}

function mergeRepairedCanonicalActivity(params: {
  canonicalActivity: Activity;
  repairedSnapshot: Activity;
}) {
  const { canonicalActivity, repairedSnapshot } = params;

  return {
    ...repairedSnapshot,
    id: canonicalActivity.id,
    timestamp: canonicalActivity.timestamp || repairedSnapshot.timestamp,
    metadata: {
      ...repairedSnapshot.metadata,
      fromAddress: canonicalActivity.metadata.fromAddress,
      toAddress: canonicalActivity.metadata.toAddress,
      txStatus: canonicalActivity.metadata.txStatus,
      uncertainFrom: canonicalActivity.metadata.uncertainFrom,
      importance: canonicalActivity.metadata.importance,
      tradeAmountUsdAtTx: canonicalActivity.metadata.tradeAmountUsdAtTx ?? repairedSnapshot.metadata.tradeAmountUsdAtTx,
    },
  } satisfies Activity;
}

function formatProvisionalAmount(value: number | null) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

function hasCompleteTradeQuote(metadata: Pick<Activity['metadata'], 'quoteAmount' | 'quoteToken'>) {
  return Boolean(normalizeText(metadata.quoteAmount)) && Boolean(normalizeText(metadata.quoteToken));
}

function hasUsableProvisionalTradeQuote(state: MonitorCanonicalRepairState) {
  return Boolean(formatProvisionalAmount(state.provisionalQuoteAmount)) && Boolean(normalizeText(state.provisionalQuoteSymbol));
}

function buildSnapshotFromRepairState(params: {
  user: User;
  state: MonitorCanonicalRepairState;
  canonicalActivity: Activity;
}) {
  const { user, state, canonicalActivity } = params;
  return {
    user,
    chain: state.chain,
    tokenAddress: pickFirstText(state.tokenAddress, canonicalActivity.metadata.tokenAddress) || '',
    tokenSymbol: state.provisionalTokenSymbol || state.tokenSymbol,
    txHash: state.txHash,
    marketCapUsd: state.provisionalMarketCapUsd,
    quoteAmount: state.provisionalQuoteAmount,
    quoteSymbol: state.provisionalQuoteSymbol,
    tokenAmount: state.provisionalTokenAmount,
    explicitPriceUsd: state.provisionalPriceUsd,
    rawText: state.provisionalRawText,
    action: state.provisionalAction,
    actionLabel: state.provisionalActionLabel,
    actionVariant: state.provisionalActionVariant,
    walletLabel: state.provisionalWalletLabel,
    walletGroupLabel: state.provisionalWalletGroupLabel,
    walletAliasLabel: state.provisionalWalletAliasLabel,
    eventTimeMs: state.eventTimeMs,
    trackedAddress: state.trackedWalletAddress,
    monitorReconciliationStatus: state.reconciliationStatus,
    monitorReconciledSource: state.reconciledSource,
  } satisfies MonitorActivitySnapshot;
}

export async function buildActivityFromSnapshot(params: MonitorActivitySnapshot) {
  const tradeAmountUsdAtTx =
    params.action === 'buy' || params.action === 'sell'
      ? await resolveTradeAmountUsdAtTx({
          chain: params.chain,
          txTimestampMs: params.eventTimeMs,
          token: params.tokenSymbol,
          value:
            typeof params.tokenAmount === 'number' && Number.isFinite(params.tokenAmount)
              ? String(params.tokenAmount)
              : null,
          quoteToken: params.quoteSymbol,
          quoteAmount:
            typeof params.quoteAmount === 'number' && Number.isFinite(params.quoteAmount)
              ? String(params.quoteAmount)
              : null,
          explicitPriceUsd: params.explicitPriceUsd,
        })
      : null;

  return buildActivityFromSnapshotCore(params, tradeAmountUsdAtTx);
}

export function buildActivityFromSnapshotSync(
  params: MonitorActivitySnapshot,
  options?: { tradeAmountUsdAtTx?: number | null }
) {
  return buildActivityFromSnapshotCore(params, options?.tradeAmountUsdAtTx ?? null);
}

function shouldRepairCollapsedCanonicalActivity(state: MonitorCanonicalRepairState, canonicalActivity: Activity) {
  const provisionalToken = (state.provisionalTokenSymbol || state.tokenSymbol || '').trim();
  const provisionalTokenAddress = (state.tokenAddress || '').trim();
  if (!provisionalToken || !provisionalTokenAddress || isNativeSymbol(state.chain, provisionalToken)) {
    return false;
  }

  const canonicalToken = (canonicalActivity.metadata.token || '').trim();
  const canonicalTokenAddress = (canonicalActivity.metadata.tokenAddress || '').trim();
  if (!canonicalToken || !canonicalTokenAddress) {
    return true;
  }

  return isNativeSymbol(state.chain, canonicalToken);
}

function shouldRepairMissingCanonicalTradeQuote(state: MonitorCanonicalRepairState, canonicalActivity: Activity) {
  const canonicalAction = canonicalActivity.metadata.txAction;
  if (canonicalAction !== 'buy' && canonicalAction !== 'sell') {
    return false;
  }

  if (hasCompleteTradeQuote(canonicalActivity.metadata)) {
    return false;
  }

  return hasUsableProvisionalTradeQuote(state);
}

function repairMissingCanonicalTradeQuote(
  state: MonitorCanonicalRepairState,
  canonicalActivity: Activity
): Activity {
  if (!shouldRepairMissingCanonicalTradeQuote(state, canonicalActivity)) {
    return canonicalActivity;
  }

  const nextQuoteAmount = pickFirstText(
    canonicalActivity.metadata.quoteAmount,
    formatProvisionalAmount(state.provisionalQuoteAmount)
  );
  const nextQuoteToken = pickFirstText(canonicalActivity.metadata.quoteToken, state.provisionalQuoteSymbol);
  const nextTxActionLabel: Activity['metadata']['txActionLabel'] =
    canonicalActivity.metadata.txActionLabel ?? state.provisionalActionLabel ?? undefined;
  const nextTxActionVariant: Activity['metadata']['txActionVariant'] =
    canonicalActivity.metadata.txActionVariant ?? state.provisionalActionVariant ?? undefined;
  const nextWalletLabel = pickFirstText(
    canonicalActivity.metadata.monitorWalletAliasLabel,
    canonicalActivity.metadata.monitorWalletLabel,
    state.provisionalWalletAliasLabel,
    state.provisionalWalletLabel
  );
  const displayMetadata = buildTradeDisplayMetadata({
    rawText: pickFirstText(canonicalActivity.metadata.rawText, state.provisionalRawText) || null,
    walletLabel: nextWalletLabel || null,
    fallbackWalletLabel:
      pickFirstText(
        canonicalActivity.metadata.displayWalletLabel,
        state.provisionalWalletAliasLabel,
        state.provisionalWalletLabel
      ) || null,
    actionVariant: nextTxActionVariant || null,
    txActionLabel: nextTxActionLabel || null,
    quoteAmount: nextQuoteAmount || null,
    quoteToken: nextQuoteToken || null,
    value: pickFirstText(canonicalActivity.metadata.value, formatProvisionalAmount(state.provisionalTokenAmount)) || null,
    tokenSymbol: pickFirstText(canonicalActivity.metadata.token, state.provisionalTokenSymbol, state.tokenSymbol) || null,
    marketCapText: canonicalActivity.metadata.displayMarketCapText || null,
    marketCapUsd:
      typeof canonicalActivity.metadata.marketCapAtTxUsd === 'number'
        ? canonicalActivity.metadata.marketCapAtTxUsd
        : state.provisionalMarketCapUsd,
    tokenAddress: pickFirstText(canonicalActivity.metadata.tokenAddress, state.tokenAddress) || null,
  });

  return {
    ...canonicalActivity,
    metadata: {
      ...canonicalActivity.metadata,
      quoteAmount: nextQuoteAmount || canonicalActivity.metadata.quoteAmount,
      quoteToken: nextQuoteToken || canonicalActivity.metadata.quoteToken,
      txActionLabel: nextTxActionLabel,
      txActionVariant: nextTxActionVariant,
      displayWalletLabel: canonicalActivity.metadata.displayWalletLabel || displayMetadata.displayWalletLabel,
      displayActionVariantLabel:
        canonicalActivity.metadata.displayActionVariantLabel || displayMetadata.displayActionVariantLabel,
      displayTradeAmountText: displayMetadata.displayTradeAmountText || canonicalActivity.metadata.displayTradeAmountText,
      displayTokenSymbol: canonicalActivity.metadata.displayTokenSymbol || displayMetadata.displayTokenSymbol,
      displayMarketCapText: canonicalActivity.metadata.displayMarketCapText || displayMetadata.displayMarketCapText,
      displayTokenAvatarTokenAddress:
        canonicalActivity.metadata.displayTokenAvatarTokenAddress || displayMetadata.displayTokenAvatarTokenAddress,
    },
  } satisfies Activity;
}

export async function repairCollapsedCanonicalActivity(params: {
  user: User;
  state: MonitorCanonicalRepairState;
  canonicalActivity: Activity;
}) {
  const { user, state, canonicalActivity } = params;
  if (!shouldRepairCollapsedCanonicalActivity(state, canonicalActivity)) {
    return repairMissingCanonicalTradeQuote(state, canonicalActivity);
  }

  const repairedSnapshot = await buildActivityFromSnapshot(
    buildSnapshotFromRepairState({
      user,
      state,
      canonicalActivity,
    })
  );

  return mergeRepairedCanonicalActivity({
    canonicalActivity,
    repairedSnapshot,
  });
}

export function repairCollapsedCanonicalActivitySync(params: {
  user: User;
  state: MonitorCanonicalRepairState;
  canonicalActivity: Activity;
}) {
  const { user, state, canonicalActivity } = params;
  if (!shouldRepairCollapsedCanonicalActivity(state, canonicalActivity)) {
    return repairMissingCanonicalTradeQuote(state, canonicalActivity);
  }

  const repairedSnapshot = buildActivityFromSnapshotSync(
    buildSnapshotFromRepairState({
      user,
      state,
      canonicalActivity,
    }),
    {
      tradeAmountUsdAtTx: canonicalActivity.metadata.tradeAmountUsdAtTx ?? null,
    }
  );

  return mergeRepairedCanonicalActivity({
    canonicalActivity,
    repairedSnapshot,
  });
}
