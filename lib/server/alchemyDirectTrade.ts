import 'server-only';

import { fetchFromDexScreener } from '@/lib/server/dexscreener';
import type { AlchemyInboxEvent } from '@/lib/server/alchemyInbox';
import type { NormalizedLiveTrade } from '@/lib/server/gmgnWalletActivity';

const MIN_LIQUIDITY_USD = 500;
const QUOTE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'SOL', 'WSOL', 'ETH', 'WETH', 'BNB', 'WBNB']);
const QUOTE_ADDRESSES = new Set(
  [
    'So11111111111111111111111111111111111111112',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    '0x4200000000000000000000000000000000000006',
    '0x833589fCD6EDB6E08f4c7C32D4f71b54bdA02913',
    '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    '0x55d398326f99059fF775485246999027B3197955',
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
  ].map((value) => value.toLowerCase())
);

type Market = Awaited<ReturnType<typeof fetchFromDexScreener>>;
type RawTransfer = {
  from: string | null;
  to: string | null;
  token: string;
  amount: number;
  txHash: string | null;
  symbol: string | null;
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function networkToChain(network: unknown): string | null {
  const value = String(network || '').toUpperCase();
  if (value.startsWith('SOL')) return 'solana';
  if (value.startsWith('ETH')) return 'ethereum';
  if (value.startsWith('BASE')) return 'base';
  if (value.startsWith('BSC') || value.startsWith('BNB')) return 'bsc';
  if (value.startsWith('ROBINHOOD')) return 'robinhood';
  return null;
}

function evmTransfers(eventNode: Record<string, unknown>): RawTransfer[] {
  if (!Array.isArray(eventNode.activity)) return [];
  const out: RawTransfer[] = [];
  for (const value of eventNode.activity) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    const rawContract = (item.rawContract || {}) as Record<string, unknown>;
    const token = text(rawContract.address);
    const amount = number(item.value);
    if (!token || amount == null || amount <= 0) continue;
    out.push({
      from: text(item.fromAddress),
      to: text(item.toAddress),
      token: token.toLowerCase(),
      amount,
      txHash: text(item.hash),
      symbol: text(item.asset),
    });
  }
  return out;
}

function collectSolTransfers(node: unknown, out: RawTransfer[], inheritedTx: string | null): string | null {
  if (Array.isArray(node)) {
    let tx = inheritedTx;
    for (const item of node) tx = collectSolTransfers(item, out, tx) ?? tx;
    return tx;
  }
  if (!node || typeof node !== 'object') return inheritedTx;
  const item = node as Record<string, unknown>;
  let tx = text(item.signature) ?? text(item.transactionHash) ?? text(item.hash) ?? inheritedTx;
  const from = text(item.fromOwner) ?? text(item.fromAddress) ?? text(item.from);
  const to = text(item.toOwner) ?? text(item.toAddress) ?? text(item.to);
  const token = text(item.mint) ?? text(item.tokenAddress) ?? text(item.contractAddress);
  const tokenAmount = item.uiTokenAmount as Record<string, unknown> | undefined;
  const amount =
    number(item.tokenAmount) ??
    number(item.amount) ??
    number(item.value) ??
    number(tokenAmount?.uiAmountString) ??
    number(tokenAmount?.uiAmount);
  if (from && to && token && amount != null && amount > 0) {
    out.push({ from, to, token, amount, txHash: tx, symbol: null });
  }
  for (const child of Object.values(item)) tx = collectSolTransfers(child, out, tx) ?? tx;
  return tx;
}

function isQuoteToken(token: string, symbol: string | null): boolean {
  return QUOTE_ADDRESSES.has(token.toLowerCase()) || Boolean(symbol && QUOTE_SYMBOLS.has(symbol.toUpperCase()));
}

function parseInboxTimestamp(value: string): number {
  const trimmed = value.trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  return Date.parse(normalized) || Date.now();
}

export async function parseAlchemyInboxTrades(params: {
  events: AlchemyInboxEvent[];
  watchedAddresses: string[];
  fetchMarket?: typeof fetchFromDexScreener;
  minCostUsd?: number;
}): Promise<NormalizedLiveTrade[]> {
  const fetchMarket = params.fetchMarket ?? fetchFromDexScreener;
  const minCostUsd = params.minCostUsd ?? 10;
  const watched = new Map(params.watchedAddresses.map((address) => [address.toLowerCase(), address]));
  const marketCache = new Map<string, Market>();
  const merged = new Map<string, NormalizedLiveTrade>();

  for (const inboxEvent of params.events) {
    const payload = inboxEvent.payload || {};
    const eventNode = ((payload.event as Record<string, unknown> | undefined) || payload) as Record<string, unknown>;
    const chain = networkToChain(eventNode.network ?? inboxEvent.network);
    if (!chain) continue;
    const transfers: RawTransfer[] = [];
    if (chain === 'solana') collectSolTransfers(eventNode, transfers, null);
    else transfers.push(...evmTransfers(eventNode));

    for (const transfer of transfers) {
      const toWallet = transfer.to ? watched.get(transfer.to.toLowerCase()) : null;
      const fromWallet = transfer.from ? watched.get(transfer.from.toLowerCase()) : null;
      const wallet = toWallet ?? fromWallet;
      const side = toWallet ? 'buy' : fromWallet ? 'sell' : null;
      if (!wallet || !side || !transfer.txHash || isQuoteToken(transfer.token, transfer.symbol)) continue;

      const marketKey = `${chain}:${chain === 'solana' ? transfer.token : transfer.token.toLowerCase()}`;
      let market = marketCache.get(marketKey);
      if (market === undefined) {
        market = await fetchMarket(transfer.token, chain);
        marketCache.set(marketKey, market);
      }
      if (market && (market.price <= 0 || market.liquidity < MIN_LIQUIDITY_USD)) continue;
      const priceUsd = market?.price ?? null;
      const costUsd = priceUsd == null ? null : transfer.amount * priceUsd;
      if (costUsd != null && costUsd < minCostUsd) continue;

      const tokenAddress = chain === 'solana' ? transfer.token : transfer.token.toLowerCase();
      const key = `${chain}:${wallet.toLowerCase()}:${transfer.txHash.toLowerCase()}:${tokenAddress}:${side}`;
      const existing = merged.get(key);
      if (existing) {
        existing.tokenAmount = (existing.tokenAmount ?? 0) + transfer.amount;
        existing.costUsd = priceUsd == null ? null : (existing.tokenAmount ?? 0) * priceUsd;
        continue;
      }
      merged.set(key, {
        dataSource: 'alchemy',
        chain,
        wallet,
        txHash: transfer.txHash,
        tokenAddress,
        tokenSymbol: market?.ticker || transfer.symbol,
        side,
        tokenAmount: transfer.amount,
        costUsd,
        priceUsd,
        marketCapUsd: market && market.marketCap > 0 ? market.marketCap : null,
        isOpenOrClose: null,
        eventTimeMs: parseInboxTimestamp(inboxEvent.received_at),
      });
    }
  }

  return [...merged.values()].sort((left, right) => left.eventTimeMs - right.eventTimeMs);
}
