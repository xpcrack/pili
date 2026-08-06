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
import { isSqliteBusyError } from '@/lib/server/sqlite';
import type { User } from '@/types';

export const DEFAULT_TIMELINE_DAYS = 14;

export type FetchWalletActivitySinceParams = {
  chain: string;
  wallet: string;
  afterTsSec: number;
  pageLimit?: number;
  maxPages?: number;
  sleepMs?: number;
  /** Retries per page before giving up on the remainder. */
  pageAttempts?: number;
  /** Prefer async gmgn-cli (runtime); sync used by CLI when omitted. */
  async?: boolean;
};

export type FetchWalletActivitySinceResult = {
  rawCount: number;
  trades: NormalizedLiveTrade[];
  pages: number;
  /** True when pagination stopped early on a transient error rather than the cursor running out. */
  truncated?: boolean;
  /** Why it stopped early, when truncated. */
  lastError?: string | null;
};

/** Per-page retries before giving up on the rest of a wallet's history. */
const DEFAULT_PAGE_ATTEMPTS = 4;
const PAGE_RETRY_BASE_DELAY_MS = 800;
/**
 * Pacing between pages. The wrapper round-robins one API key per spawn and all
 * traffic shares ~35 Clash nodes; hammering with zero delay is what produced the
 * `Client network socket disconnected` failures.
 * 1200ms: 对齐全局桶 0.8rps 配额，翻页循环不再全速（250ms 在冷却恢复期
 * 相当于持续水流，GMGN 滚动惩罚窗口里连续踩线 → 9 连发就 banned 的元凶）。
 */
const DEFAULT_PAGE_SLEEP_MS = 1200;

/**
 * A dropped connection / timeout is worth retrying. A ban or rate-limit is not —
 * retrying those digs the hole deeper, so they propagate to the ban handler.
 */
function isRetriableGmgnError(message: string): boolean {
  if (isGmgnBanMessage(message) || isGmgnRateLimitMessage(message)) return false;
  return /socket disconnected|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ConnectTimeout|timed out|fetch failed|network|TLS|exit 1/i.test(
    message
  );
}

export async function fetchWalletActivitySince(
  params: FetchWalletActivitySinceParams
): Promise<FetchWalletActivitySinceResult> {
  const pageLimit = params.pageLimit ?? 100;
  // 80→40：削单地址突发（L2 全局令牌桶已兜底聚合 qps，此处双保险）
  const maxPages = params.maxPages ?? 40;
  const sleepMs = params.sleepMs ?? DEFAULT_PAGE_SLEEP_MS;
  const pageAttempts = Math.max(1, params.pageAttempts ?? DEFAULT_PAGE_ATTEMPTS);
  const allItems: Awaited<ReturnType<typeof fetchGmgnWalletActivityAsync>>['items'] = [];
  let cursor: string | undefined;
  let pages = 0;
  let truncated = false;
  let lastError: string | null = null;

  const fetchPage = async () =>
    params.async
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

  while (pages < maxPages) {
    pages += 1;
    assertGmgnAllowed();

    let page: Awaited<ReturnType<typeof fetchGmgnWalletActivityAsync>> | null = null;
    for (let attempt = 1; attempt <= pageAttempts; attempt += 1) {
      try {
        page = await fetchPage();
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A ban must not be retried — let the caller's ban handler see it.
        if (!isRetriableGmgnError(message) || attempt >= pageAttempts) {
          if (!isRetriableGmgnError(message)) throw error;
          lastError = message;
          break;
        }
        const delayMs = PAGE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
        console.warn(
          `[walletActivityBackfill] ${params.chain}:${params.wallet} page ${pages} attempt ${attempt}/${pageAttempts} failed, retry in ${delayMs}ms: ${message.slice(0, 160)}`
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    if (!page) {
      // Keep everything fetched so far. Discarding a wallet's whole history
      // because page 60 of 100 blipped is how rop's Solana backfill failed
      // 11 times in a row while every single page succeeded on its own.
      truncated = true;
      break;
    }

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
  return { rawCount: allItems.length, trades, pages, truncated, lastError };
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
        const busy = isSqliteBusyError(error);
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
  /** Chains whose data landed but whose older tail was cut short — re-run to finish. */
  chainsTruncated: Array<{ chain: string; error: string }>;
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
  /** Retries per page before giving up on the remainder. */
  pageAttempts?: number;
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
  const chainsTruncated: Array<{ chain: string; error: string }> = [];
  let stoppedOnBan = false;

  // Parallel per-chain. Default 2, not 4: GMGN openapi rate-limits hard at ~2
  // concurrent, and the old 4-way fan-out is what dropped 2 of 4 EVM chains on
  // rop's first backfill. Raise via PILI_WALLET_TIMELINE_CHAIN_PARALLEL only if
  // the key pool grows.
  const chainParallelEnv = Number(process.env.PILI_WALLET_TIMELINE_CHAIN_PARALLEL || 2);
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
        pageAttempts: params.pageAttempts,
        async: params.async ?? true,
      });
      return {
        chain,
        ok: true as const,
        rawCount: page.rawCount,
        trades: page.trades,
        // Partial data still counts as a success — it is upserted — but the
        // caller needs to know the tail is missing so it can re-run.
        truncated: page.truncated === true,
        error: page.truncated ? page.lastError ?? 'truncated' : (null as string | null),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        chain,
        ok: false as const,
        rawCount: 0,
        trades: [] as NormalizedLiveTrade[],
        truncated: false,
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
        if (result.truncated) {
          chainsTruncated.push({ chain: result.chain, error: result.error || 'truncated' });
        }
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
    // Bounded worker pool. `Promise.all(chains.map(...))` ignored chainParallel
    // entirely — it fired every chain at once, so a value of 2 still meant a
    // 4-way fan-out for EVM addresses, right past GMGN's ~2-concurrent limit.
    const queue = [...chains];
    const results: Array<Awaited<ReturnType<typeof runOneChain>>> = [];
    await Promise.all(
      Array.from({ length: chainParallel }, async () => {
        for (;;) {
          const chain = queue.shift();
          if (!chain) return;
          results.push(await runOneChain(chain));
        }
      })
    );
    for (const result of results) {
      if (result.ok) {
        rawCount += result.rawCount;
        trades.push(...result.trades);
        chainsOk.push(result.chain);
        if (result.truncated) {
          chainsTruncated.push({ chain: result.chain, error: result.error || 'truncated' });
        }
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
    chainsTruncated,
    stoppedOnBan,
  };
}
