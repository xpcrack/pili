import 'server-only';

import { legacyFeedItemToCanonicalEvent } from '@/lib/canonical';
import { readEventsFeed } from '@/lib/server/eventsRepo';
import type { CanonicalTradeEvent, ChainType, User } from '@/types';

export type BidTradeCostDataStatus = 'complete' | 'missing-usd' | 'missing-market-cap' | 'partial';

export interface BidTradeExportRow {
  eventId: string;
  userId: string;
  userName: string;
  sourceAddressName: string | null;
  chain: ChainType;
  trackedWalletAddress: string;
  trackedWalletAddressRaw: string;
  tokenAddress: string;
  tokenSymbol: string;
  txHash: string;
  action: 'buy' | 'sell';
  actionVariant: 'open' | 'add' | 'reduce' | 'close';
  eventTimeMs: number;
  tokenAmount: number;
  amountUsd: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  quoteSymbol: string | null;
  quoteAmount: number | null;
  costDataStatus: BidTradeCostDataStatus;
}

export interface ReadBidTradeExportQuery {
  userIds?: string[];
  fromMs?: number | null;
  toMs?: number | null;
  cursor?: string | null;
  limit?: number;
}

function normalize(value: string | null | undefined) {
  return (value || '').trim();
}

function normalizeEvmLike(value: string) {
  return value.toLowerCase();
}

function normalizeChainAddress(chain: ChainType, value: string) {
  const trimmed = normalize(value);
  if (!trimmed) {
    return '';
  }
  return chain === 'solana' ? trimmed : normalizeEvmLike(trimmed);
}

function normalizeTxHash(chain: ChainType, value: string) {
  const trimmed = normalize(value);
  if (!trimmed) {
    return '';
  }
  return chain === 'solana' ? trimmed : normalizeEvmLike(trimmed);
}

function findSourceAddressName(user: User, chain: ChainType, trackedWalletAddress: string) {
  const normalizedTrackedAddress = normalizeChainAddress(chain, trackedWalletAddress);
  if (!normalizedTrackedAddress) {
    return null;
  }

  const exactMatch = user.addresses.find(
    (address) =>
      address.chain === chain &&
      normalizeChainAddress(address.chain, address.address) === normalizedTrackedAddress
  );
  if (exactMatch) {
    return exactMatch.name;
  }

  const fallbackMatch = user.addresses.find(
    (address) => normalizeChainAddress(address.chain, address.address) === normalizedTrackedAddress
  );
  return fallbackMatch?.name || null;
}

function getCostDataStatus(trade: CanonicalTradeEvent): BidTradeCostDataStatus {
  const hasUsd = trade.amountUsd !== null && trade.priceUsd !== null;
  const hasMarketCap = trade.marketCapUsd !== null;

  if (hasUsd && hasMarketCap) {
    return 'complete';
  }
  if (!hasUsd && hasMarketCap) {
    return 'missing-usd';
  }
  if (hasUsd && !hasMarketCap) {
    return 'missing-market-cap';
  }
  return 'partial';
}

function toBidTradeExportRow(params: {
  trade: CanonicalTradeEvent;
  user: User;
}): BidTradeExportRow | null {
  const { trade, user } = params;
  const trackedWalletAddressRaw = normalize(trade.walletAddress);
  const tokenAddressRaw = normalize(trade.tokenAddress);

  if (!trade.chain || !trackedWalletAddressRaw || !tokenAddressRaw || trade.tokenAmount <= 0) {
    return null;
  }

  return {
    eventId: trade.id,
    userId: user.id,
    userName: user.name,
    sourceAddressName: findSourceAddressName(user, trade.chain, trackedWalletAddressRaw),
    chain: trade.chain,
    trackedWalletAddress: normalizeChainAddress(trade.chain, trackedWalletAddressRaw),
    trackedWalletAddressRaw,
    tokenAddress: normalizeChainAddress(trade.chain, tokenAddressRaw),
    tokenSymbol: normalize(trade.tokenSymbol) || 'UNKNOWN',
    txHash: normalizeTxHash(trade.chain, trade.txHash || trade.id),
    action: trade.action === 'open' || trade.action === 'add' ? 'buy' : 'sell',
    actionVariant: trade.action,
    eventTimeMs: trade.timestamp,
    tokenAmount: trade.tokenAmount,
    amountUsd: trade.amountUsd,
    priceUsd: trade.priceUsd,
    marketCapUsd: trade.marketCapUsd,
    quoteSymbol: normalize(trade.quoteSymbol) || null,
    quoteAmount: trade.quoteAmount ?? null,
    costDataStatus: getCostDataStatus(trade),
  };
}

export function readBidTradeExport(query: ReadBidTradeExportQuery) {
  const requestedUserIds = new Set((query.userIds || []).map((value) => value.trim()).filter(Boolean));
  const limit = Math.max(1, Math.min(200, Math.floor(query.limit || 50)));
  const batchLimit = Math.max(limit, 50);
  const singleUserId = requestedUserIds.size === 1 ? Array.from(requestedUserIds)[0] || null : null;

  const trades: BidTradeExportRow[] = [];
  let cursor = query.cursor || null;

  for (;;) {
    const page = readEventsFeed({
      limit: batchLimit,
      cursor,
      source: 'blockchain',
      userId: singleUserId,
      fromMs: query.fromMs ?? null,
      toMs: query.toMs ?? null,
    });

    if (page.feed.length === 0) {
      return {
        trades,
        nextCursor: null,
      };
    }

    for (const row of page.feed) {
      if (requestedUserIds.size > 0 && !requestedUserIds.has(row.user.id)) {
        continue;
      }

      const canonicalEvent = legacyFeedItemToCanonicalEvent(row);
      if (!canonicalEvent || canonicalEvent.type !== 'trade') {
        continue;
      }

      const exportedTrade = toBidTradeExportRow({
        trade: canonicalEvent,
        user: row.user,
      });
      if (!exportedTrade) {
        continue;
      }

      trades.push(exportedTrade);
      if (trades.length >= limit) {
        return {
          trades,
          nextCursor: row.cursor,
        };
      }
    }

    if (!page.hasMore || !page.nextCursor) {
      return {
        trades,
        nextCursor: null,
      };
    }

    cursor = page.nextCursor;
  }
}
