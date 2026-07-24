/**
 * Shared GMGN wallet activity history backfill (14d completeness).
 * Used by CLI script + enablement enqueue + completeness worker drain.
 */
import 'server-only';

import {
  fetchGmgnWalletActivity,
  fetchGmgnWalletActivityAsync,
  inferChainsForAddress,
  normalizeGmgnActivityItems,
  type NormalizedLiveTrade,
} from '@/lib/server/gmgnWalletActivity';
import {
  assertGmgnAllowed,
  isGmgnBanMessage,
  isGmgnRateLimitMessage,
  noteGmgnBan,
} from '@/lib/server/gmgnRateLimit';
import { upsertLiveMonitorTrades } from '@/lib/server/liveMonitorIngest';
import type { User } from '@/types';

export const DEFAULT_TIMELINE_DAYS = 14;

export type FetchWalletActivitySinceParams = {
  chain: string;
  wallet: string;
  afterTsSec: number;
  pageLimit?: number;
  maxPages?: number;
  sleepMs?: number;
  /** Prefer async gmgn-cli (runtime); sync used by CLI when omitted. */
  async?: boolean;
};

export type FetchWalletActivitySinceResult = {
  rawCount: number;
  trades: NormalizedLiveTrade[];
  pages: number;
};

export async function fetchWalletActivitySince(
  params: FetchWalletActivitySinceParams
): Promise<FetchWalletActivitySinceResult> {
  const pageLimit = params.pageLimit ?? 100;
  const maxPages = params.maxPages ?? 80;
  const sleepMs = params.sleepMs ?? 0;
  const allItems: Awaited<ReturnType<typeof fetchGmgnWalletActivityAsync>>['items'] = [];
  let cursor: string | undefined;
  let pages = 0;

  while (pages < maxPages) {
    pages += 1;
    assertGmgnAllowed();
    const page = params.async
      ? await fetchGmgnWalletActivityAsync({
          chain: params.chain,
          wallet: params.wallet,
          limit: pageLimit,
          type: ['buy', 'sell'],
          cursor,
        })
      : fetchGmgnWalletActivity({
          chain: params.chain,
          wallet: params.wallet,
          limit: pageLimit,
          type: ['buy', 'sell'],
          cursor,
        });
    allItems.push(...page.items);
    if (!page.next || page.items.length === 0) break;

    let oldest = Infinity;
    for (const it of page.items) {
      const ts = Number(it.timestamp || 0);
      if (ts > 0 && ts < oldest) oldest = ts;
    }
    if (Number.isFinite(oldest) && oldest <= params.afterTsSec) break;
    cursor = page.next;
    if (sleepMs > 0) {
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }

  const trades = normalizeGmgnActivityItems(allItems, {
    wallet: params.wallet,
    chain: params.chain,
    after_ts: params.afterTsSec,
    min_cost_usd: 0,
  });
  return { rawCount: allItems.length, trades, pages };
}

export async function upsertWalletActivityTrades(
  user: User,
  trades: NormalizedLiveTrade[],
  opts?: { chunkSize?: number }
) {
  if (trades.length === 0) return 0;
  let upserted = 0;
  const chunkSize = opts?.chunkSize ?? 100;
  for (let i = 0; i < trades.length; i += chunkSize) {
    const chunk = trades.slice(i, i + chunkSize);
    let lastError: unknown;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        const result = upsertLiveMonitorTrades({
          user,
          trades: chunk,
          skipImportanceScore: true,
          fastBulk: true,
        });
        upserted += result.upserted;
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);
        const busy = /database is locked|SQLITE_BUSY/i.test(msg);
        if (!busy || attempt === 8) break;
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
    if (lastError) throw lastError;
  }
  return upserted;
}

export type BackfillWalletTimelineResult = {
  address: string;
  rawCount: number;
  tradeCount: number;
  upserted: number;
  chainsOk: string[];
  chainsFailed: Array<{ chain: string; error: string }>;
  stoppedOnBan: boolean;
};

/**
 * Pull buy/sell for one wallet across inferred chains and upsert into events.
 * Does not acquire the heavy-job lock — caller decides concurrency.
 */
export async function backfillWalletTimeline(params: {
  user: User;
  address: string;
  days?: number;
  sinceMs?: number;
  pageLimit?: number;
  maxPages?: number;
  sleepMs?: number;
  async?: boolean;
  dryRun?: boolean;
}): Promise<BackfillWalletTimelineResult> {
  const address = (params.address || '').trim();
  const days = params.days ?? DEFAULT_TIMELINE_DAYS;
  const sinceMs =
    params.sinceMs != null && Number.isFinite(params.sinceMs)
      ? params.sinceMs
      : Date.now() - days * 24 * 60 * 60 * 1000;
  const afterTsSec = Math.floor(sinceMs / 1000);
  const chains = inferChainsForAddress(address);
  const trades: NormalizedLiveTrade[] = [];
  let rawCount = 0;
  const chainsOk: string[] = [];
  const chainsFailed: Array<{ chain: string; error: string }> = [];
  let stoppedOnBan = false;

  // Parallel per-chain (key pool paces actual HTTP). Sequential only if chainParallel=1.
  const chainParallelEnv = Number(process.env.PILI_WALLET_TIMELINE_CHAIN_PARALLEL || 4);
  const chainParallel = Number.isFinite(chainParallelEnv)
    ? Math.max(1, Math.min(chains.length, Math.floor(chainParallelEnv)))
    : Math.min(4, chains.length);

  const runOneChain = async (chain: string) => {
    try {
      const page = await fetchWalletActivitySince({
        chain,
        wallet: address,
        afterTsSec,
        pageLimit: params.pageLimit,
        maxPages: params.maxPages,
        sleepMs: params.sleepMs,
        async: params.async ?? true,
      });
      return {
        chain,
        ok: true as const,
        rawCount: page.rawCount,
        trades: page.trades,
        error: null as string | null,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        chain,
        ok: false as const,
        rawCount: 0,
        trades: [] as NormalizedLiveTrade[],
        error: msg,
      };
    }
  };

  if (chainParallel <= 1) {
    for (const chain of chains) {
      const result = await runOneChain(chain);
      if (result.ok) {
        rawCount += result.rawCount;
        trades.push(...result.trades);
        chainsOk.push(result.chain);
      } else {
        chainsFailed.push({ chain: result.chain, error: result.error || 'unknown' });
        if (result.error && (isGmgnBanMessage(result.error) || isGmgnRateLimitMessage(result.error))) {
          noteGmgnBan(result.error);
          stoppedOnBan = true;
          break;
        }
      }
    }
  } else {
    const results = await Promise.all(chains.map((c) => runOneChain(c)));
    for (const result of results) {
      if (result.ok) {
        rawCount += result.rawCount;
        trades.push(...result.trades);
        chainsOk.push(result.chain);
      } else {
        chainsFailed.push({ chain: result.chain, error: result.error || 'unknown' });
        if (result.error && (isGmgnBanMessage(result.error) || isGmgnRateLimitMessage(result.error))) {
          noteGmgnBan(result.error);
          stoppedOnBan = true;
        }
      }
    }
  }

  let upserted = 0;
  if (!params.dryRun && trades.length > 0) {
    upserted = await upsertWalletActivityTrades(params.user, trades);
  } else if (params.dryRun) {
    upserted = trades.length;
  }

  return {
    address,
    rawCount,
    tradeCount: trades.length,
    upserted,
    chainsOk,
    chainsFailed,
    stoppedOnBan,
  };
}
