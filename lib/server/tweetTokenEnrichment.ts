import 'server-only';

import {
  fetchFromDexScreener,
  selectPreferredDexScreenerPair,
  type DexScreenerPair,
} from '@/lib/server/dexscreener';
import type {
  TweetMentionMarketCapSource,
  TweetMentionMatchSource,
  TweetMentionOrigin,
  TweetMentionSentiment,
} from '@/lib/server/twitterEnrichmentRepo';
import { resolveTransactionTimeMarketCap } from '@/lib/tokenLogo';
import { lookupPrimaryPoolAddressBySymbol } from '@/lib/server/primaryPoolSymbols';

const EVM_CA_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const SOL_CA_EXACT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEXSCREENER_API = 'https://api.dexscreener.com';
const EVM_CHAIN_CANDIDATES = ['ethereum', 'bsc', 'base'] as const;

export interface EnrichableMention {
  tokenAddress: string | null;
  tokenSymbol: string | null;
  chain: string | null;
  matchSource: TweetMentionMatchSource;
  sentiment: TweetMentionSentiment;
  confidence: number | null;
  rankInTweet: number;
  origin: TweetMentionOrigin;
  marketCapUsd: number | null;
  marketCapAtPostUsd: number | null;
  marketCapAtPostEstimated: boolean;
  marketCapSource: TweetMentionMarketCapSource;
  resolvedAtMs: number | null;
}

function isLikelySolAddress(value: string) {
  return value.length >= 32 && value.length <= 44 && SOL_CA_EXACT_PATTERN.test(value);
}

// Returns null on transport/HTTP error (ambiguous), [] when the address has 0
// DexScreener pairs (a wallet/EOA, not a token), or the pair list otherwise.
async function fetchDexPairsByToken(address: string): Promise<DexScreenerPair[] | null> {
  try {
    const url = `${DEXSCREENER_API}/latest/dex/tokens/${address}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { pairs?: DexScreenerPair[] | null };
    return Array.isArray(data.pairs) ? data.pairs : [];
  } catch {
    return null;
  }
}

function chainFromDexChainId(chainId: string | undefined): string | null {
  const value = (chainId || '').toLowerCase();
  if (value === 'solana') return 'solana';
  if (value === 'ethereum' || value === 'eth') return 'ethereum';
  if (value === 'bsc' || value === 'bnb') return 'bsc';
  if (value === 'base') return 'base';
  return null;
}

export async function inferChainAndTickerForAddress(address: string): Promise<{
  chain: string | null;
  ticker: string | null;
  marketCapUsd: number | null;
}> {
  const trimmed = address.trim();
  if (!trimmed) {
    return { chain: null, ticker: null, marketCapUsd: null };
  }

  if (isLikelySolAddress(trimmed) && !EVM_CA_PATTERN.test(trimmed)) {
    // base58 shape fits both Solana mints AND wallets/EOAs. DexScreener tells them
    // apart: a mint has ≥1 pair, a wallet has 0. Network failure (null) is ambiguous,
    // so fail open (keep as solana) rather than risk dropping a real token.
    const pairs = await fetchDexPairsByToken(trimmed);
    if (pairs === null) {
      return { chain: 'solana', ticker: null, marketCapUsd: null };
    }
    if (pairs.length === 0) {
      return { chain: null, ticker: null, marketCapUsd: null };
    }
    const preferred = selectPreferredDexScreenerPair(trimmed, 'solana', pairs);
    const mc = preferred?.marketCap || preferred?.fdv || 0;
    return {
      chain: 'solana',
      ticker: preferred?.baseToken?.symbol || null,
      marketCapUsd: mc > 0 ? mc : null,
    };
  }

  if (!EVM_CA_PATTERN.test(trimmed)) {
    return { chain: null, ticker: null, marketCapUsd: null };
  }

  const pairs = await fetchDexPairsByToken(trimmed);
  if (!pairs || pairs.length === 0) {
    // Fallback: try common EVM chains one by one
    for (const chain of EVM_CHAIN_CANDIDATES) {
      const dex = await fetchFromDexScreener(trimmed, chain);
      if (dex) {
        return {
          chain,
          ticker: dex.ticker || null,
          marketCapUsd: dex.marketCap > 0 ? dex.marketCap : null,
        };
      }
    }
    return { chain: null, ticker: null, marketCapUsd: null };
  }

  // Prefer highest-liquidity pair across chains
  let best: DexScreenerPair | null = null;
  let bestChain: string | null = null;
  for (const chain of EVM_CHAIN_CANDIDATES) {
    const preferred = selectPreferredDexScreenerPair(trimmed, chain, pairs);
    if (!preferred) continue;
    if (!best || (preferred.liquidity?.usd || 0) > (best.liquidity?.usd || 0)) {
      best = preferred;
      bestChain = chain;
    }
  }

  if (!best) {
    // pick overall top liquidity pair
    best = [...pairs].sort(
      (a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
    )[0] || null;
    bestChain = chainFromDexChainId(best?.chainId);
  }

  return {
    chain: bestChain,
    ticker: best?.baseToken?.symbol || null,
    marketCapUsd: best ? best.fdv || best.marketCap || null : null,
  };
}

export async function enrichMentionMarketData(params: {
  mention: {
    tokenAddress: string | null;
    tokenSymbol: string | null;
    chain?: string | null;
    matchSource: TweetMentionMatchSource;
    sentiment: TweetMentionSentiment;
    confidence: number | null;
    rankInTweet: number;
    origin: TweetMentionOrigin;
  };
  tweetCreatedAtMs: number;
}): Promise<EnrichableMention> {
  const base: EnrichableMention = {
    tokenAddress: params.mention.tokenAddress,
    tokenSymbol: params.mention.tokenSymbol,
    chain: params.mention.chain || null,
    matchSource: params.mention.matchSource,
    sentiment: params.mention.sentiment,
    confidence: params.mention.confidence,
    rankInTweet: params.mention.rankInTweet,
    origin: params.mention.origin,
    marketCapUsd: null,
    marketCapAtPostUsd: null,
    marketCapAtPostEstimated: false,
    marketCapSource: null,
    resolvedAtMs: null,
  };

  let address = (params.mention.tokenAddress || '').trim();
  if (!address) {
    // Ticker-only mention → try primary pool lookup
    const symbol = (params.mention.tokenSymbol || '').trim();
    if (!symbol) return base;
    const lookup = lookupPrimaryPoolAddressBySymbol(symbol);
    if (!lookup) return base;
    base.tokenAddress = lookup.address;
    base.chain = lookup.chain;
    base.matchSource = 'ticker';
    address = lookup.address;
  }

  try {
    const resolved = await inferChainAndTickerForAddress(address);
    if (resolved.chain) {
      base.chain = resolved.chain;
    }
    if (!base.tokenSymbol && resolved.ticker) {
      base.tokenSymbol = resolved.ticker.toUpperCase();
      if (base.matchSource === 'ca') {
        base.matchSource = 'both';
      }
    }
    if (resolved.marketCapUsd && resolved.marketCapUsd > 0) {
      base.marketCapUsd = resolved.marketCapUsd;
    }

    if (base.chain) {
      const mc = await resolveTransactionTimeMarketCap({
        chain: base.chain,
        tokenAddress: address,
        txTimestampMs: params.tweetCreatedAtMs,
      });
      if (mc.currentMarketCapUsd && mc.currentMarketCapUsd > 0) {
        base.marketCapUsd = mc.currentMarketCapUsd;
      }
      if (mc.marketCapAtTxUsd && mc.marketCapAtTxUsd > 0) {
        base.marketCapAtPostUsd = mc.marketCapAtTxUsd;
        base.marketCapAtPostEstimated = Boolean(mc.marketCapAtTxEstimated);
        base.marketCapSource = mc.marketCapAtTxSource || (mc.marketCapAtTxEstimated ? 'estimated' : null);
      } else if (base.marketCapUsd) {
        // Fall back to current as "at post" only if historical unavailable — mark estimated
        base.marketCapAtPostUsd = base.marketCapUsd;
        base.marketCapAtPostEstimated = true;
        base.marketCapSource = 'dexscreener';
      }
    }

    base.resolvedAtMs = Date.now();
  } catch (err) {
    console.warn(
      '[tweetTokenEnrichment] failed for',
      address.slice(0, 12),
      err instanceof Error ? err.message : err
    );
  }

  return base;
}

export async function enrichMentionsMarketData(params: {
  mentions: Array<{
    tokenAddress: string | null;
    tokenSymbol: string | null;
    chain?: string | null;
    matchSource: TweetMentionMatchSource;
    sentiment: TweetMentionSentiment;
    confidence: number | null;
    rankInTweet: number;
    origin: TweetMentionOrigin;
  }>;
  tweetCreatedAtMs: number;
  concurrency?: number;
}): Promise<EnrichableMention[]> {
  const concurrency = Math.max(1, Math.min(params.concurrency || 3, 5));
  const results: EnrichableMention[] = new Array(params.mentions.length);
  let cursor = 0;

  async function worker() {
    while (cursor < params.mentions.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await enrichMentionMarketData({
        mention: params.mentions[index],
        tweetCreatedAtMs: params.tweetCreatedAtMs,
      });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, params.mentions.length) }, () => worker()));
  return results;
}
