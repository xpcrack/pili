/**
 * Live on-chain monitor runtime:
 *   Alchemy doorbell (CF inbox) + XXYY doorbell (SQLite queue) → GMGN activity → Feed.
 *
 * Env:
 *   PILI_LIVE_SOURCE=dual|alchemy|xxyy   (default dual if alchemy inbox configured, else xxyy)
 *   PILI_XXYY_FEED=project|doorbell|off  (default doorbell when live source is alchemy/dual)
 *   PILI_ALCHEMY_INBOX_URL / NEWONE_ALCHEMY_INBOX_URL
 *   PILI_ALCHEMY_PULL_TOKEN / NEWONE_ALCHEMY_PULL_TOKEN
 *   PILI_ALCHEMY_WEBHOOK_API_KEY / NEWONE_ALCHEMY_WEBHOOK_API_KEY
 *   PILI_ALCHEMY_WEBHOOK_{ETH,BASE,BSC,SOL,RH}
 *   PILI_LIVE_MIN_COST_USD (default 0)
 *   PILI_LIVE_LOOKBACK_SEC (default 7200)
 *   PILI_LIVE_WATCHLIST_EVERY_MS (default 15m)
 *   PILI_LIVE_CYCLE_MS (default 15s)
 *   PILI_LIVE_DOORBELL_DEBOUNCE_MS (default 2000)
 *   PILI_LIVE_DOORBELL_CLAIM_LIMIT (default 8)
 *   PILI_LIVE_ACTIVITY_TIMEOUT_MS (default 20000)
 */
import 'server-only';

import { pullAlchemyInbox } from '@/lib/server/alchemyInbox';
import {
  hasPiliOwnedWebhookIds,
  readPiliAlchemyWebhookIdsFromEnv,
  syncAlchemyWatchlist,
} from '@/lib/server/alchemyWatchlist';
import {
  fetchGmgnWalletActivityAsync,
  inferChainsForAddress,
  normalizeGmgnActivityItems,
  type GmgnChain,
  type NormalizedLiveTrade,
} from '@/lib/server/gmgnWalletActivity';
import {
  ackLiveDoorbells,
  claimDueLiveDoorbells,
  nackLiveDoorbells,
  type DoorbellClaim,
  type LiveDoorbellRow,
} from '@/lib/server/liveDoorbellQueue';
import { gmgnCooldownRemainingMs, getGmgnRecoveryFactor } from '@/lib/server/gmgnRateLimit';
import {
  readLiveSourceMode,
  type EnvMap,
  type LiveSourceMode,
} from '@/lib/server/liveMonitorConfig';
import { enqueueHoldingsRefresh } from '@/lib/server/holdingsRefreshQueue';
import { upsertLiveMonitorTrades } from '@/lib/server/liveMonitorIngest';
import { listMonitoredUsers } from '@/lib/server/trackedUsersRepo';
import type { User } from '@/types';

export {
  readLiveSourceMode,
  readXxyyAllowedChains,
  readXxyyFeedMode,
  shouldAcceptXxyyChain,
} from '@/lib/server/liveMonitorConfig';
export type { LiveSourceMode, XxyyFeedMode } from '@/lib/server/liveMonitorConfig';

const DEFAULT_CYCLE_MS = 15_000;
const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_WATCHLIST_EVERY_MS = 15 * 60_000;
const DEFAULT_LOOKBACK_SEC = 2 * 60 * 60;
const DEFAULT_DOORBELL_CLAIM_LIMIT = 8;
const DEFAULT_ACTIVITY_TIMEOUT_MS = 20_000;

function readPositiveEnvNumber(env: EnvMap, key: string, fallback: number) {
  const value = Number(env[key] || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function fetchActivityWithTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(value as T);
    };

    timer = setTimeout(() => {
      controller.abort();
      finish(new Error(`GMGN activity timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    Promise.resolve()
      .then(() => run(controller.signal))
      .then((value) => finish(null, value), (error) => finish(error));
  });
}

function readAlchemyInboxConfig(env: EnvMap = process.env) {
  const base_url = (
    env.PILI_ALCHEMY_INBOX_URL ||
    env.NEWONE_ALCHEMY_INBOX_URL ||
    ''
  ).trim();
  const token = (
    env.PILI_ALCHEMY_PULL_TOKEN ||
    env.NEWONE_ALCHEMY_PULL_TOKEN ||
    ''
  ).trim();
  if (!base_url || !token) return null;
  return { base_url, token };
}

function readWatchlistToken(env: EnvMap = process.env) {
  return (
    env.PILI_ALCHEMY_WEBHOOK_API_KEY ||
    env.NEWONE_ALCHEMY_WEBHOOK_API_KEY ||
    ''
  ).trim();
}

function collectWatchedAddresses(users: User[]): {
  addresses: string[];
  byLower: Map<string, { user: User; address: string }>;
} {
  const byLower = new Map<string, { user: User; address: string }>();
  for (const user of users) {
    for (const addr of user.addresses || []) {
      const address = (addr.address || '').trim();
      if (!address) continue;
      const key = address.toLowerCase();
      if (!byLower.has(key)) {
        byLower.set(key, { user, address });
      }
    }
  }
  return { addresses: [...byLower.values()].map((v) => v.address), byLower };
}

export type LiveMonitorCycleResult = {
  sleepMs: number;
  status: 'idle' | 'busy' | 'partial' | 'error' | 'disabled';
  lastError: string | null;
  summary: {
    mode: LiveSourceMode;
    watchlistSynced: boolean;
    inboxEvents: number;
    xxyyDoorbells: number;
    walletsHit: number;
    tradesUpserted: number;
    walletsScanned: number;
    gmgnErrors: number;
  };
};

let lastWatchlistAt = 0;

export type LiveMonitorDeps = {
  listUsers?: () => User[];
  pullInbox?: typeof pullAlchemyInbox;
  syncWatchlist?: typeof syncAlchemyWatchlist;
  claimDoorbells?: typeof claimDueLiveDoorbells;
  /** Ack claimed doorbells after a successful scan (delete rows). */
  ackDoorbells?: (claims: DoorbellClaim[]) => number;
  /** Nack claimed doorbells after a failed scan (clear lease + reschedule). */
  nackDoorbells?: (claims: DoorbellClaim[], opts: { retryAfterMs: number }) => number;
  /** GMGN ban cooldown remaining (ms). >0 ⇒ skip the whole cycle to hold doorbells. */
  gmgnCooldownRemainingMs?: () => number;
  /** Recovery factor override for tests / alternate GMGN policy owners. */
  gmgnRecoveryFactor?: (nowMs: number) => number;
  fetchActivity?: (
    options: Parameters<typeof fetchGmgnWalletActivityAsync>[0]
  ) => ReturnType<typeof fetchGmgnWalletActivityAsync>;
  upsertTrades?: typeof upsertLiveMonitorTrades;
  /** Trade-triggered per-wallet holdings refresh (debounced). */
  enqueueHoldingsRefresh?: typeof enqueueHoldingsRefresh;
  now?: () => number;
  env?: EnvMap;
};

type ScanTarget = {
  key: string;
  user: User;
  address: string;
  chains: GmgnChain[];
  /** chains explicitly requested by an event (doorbell) — never rotation-throttled */
  eventChains: Set<string>;
};

/**
 * robinhood 链对 EVM 钱包几乎恒空(live-monitor 每次 15s 周期 4 链全扫,
 * robinhood 白打)。非事件驱动的周期扫描按钱包轮换:每 ROBINHOOD_PROBE_EVERY
 * 个周期才探测一次 robinhood,其余周期跳过。事件(doorbell chains 含 robinhood)
 * 不受影响,仍每次全扫。
 */
const ROBINHOOD_PROBE_EVERY = 6;
const robinhoodProbeCounter = new Map<string, number>();

function shouldProbeRobinhood(address: string): boolean {
  const key = address.trim().toLowerCase();
  const count = (robinhoodProbeCounter.get(key) ?? 0) + 1;
  robinhoodProbeCounter.set(key, count);
  return count % ROBINHOOD_PROBE_EVERY === 0;
}

function resolveChainsForDoorbell(
  address: string,
  preferred: string[] | undefined
): GmgnChain[] {
  const inferred = inferChainsForAddress(address);
  if (!preferred || preferred.length === 0) return inferred;
  const inferredSet = new Set(inferred);
  const picked = preferred.filter((c): c is GmgnChain =>
    inferredSet.has(c as GmgnChain)
  );
  return picked.length > 0 ? picked : inferred;
}

function buildScanTargets(params: {
  alchemyWallets: string[];
  doorbells: LiveDoorbellRow[];
  byLower: Map<string, { user: User; address: string }>;
}): ScanTarget[] {
  const merged = new Map<string, ScanTarget>();

  for (const wallet of params.alchemyWallets) {
    const owner = params.byLower.get(wallet.toLowerCase());
    if (!owner) continue;
    const key = owner.address.toLowerCase();
    merged.set(key, {
      key: `${owner.user.id}:${key}`,
      user: owner.user,
      address: owner.address,
      chains: inferChainsForAddress(owner.address),
      eventChains: new Set(),
    });
  }

  for (const bell of params.doorbells) {
    const lower = bell.address.toLowerCase();
    const owner = params.byLower.get(lower);
    const user = owner?.user;
    const address = owner?.address || bell.address;
    if (!user) continue;
    const key = address.toLowerCase();
    const existing = merged.get(key);
    const chains = resolveChainsForDoorbell(address, bell.chains);
    if (existing) {
      const set = new Set<GmgnChain>([...existing.chains, ...chains]);
      existing.chains = [...set];
      for (const c of chains) existing.eventChains.add(c);
      continue;
    }
    merged.set(key, {
      key: `${user.id}:${key}`,
      user,
      address,
      chains,
      eventChains: new Set(chains),
    });
  }

  return [...merged.values()];
}

export async function runLiveMonitorCycle(
  deps: LiveMonitorDeps = {}
): Promise<LiveMonitorCycleResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const mode = readLiveSourceMode(env);

  const emptySummary = {
    mode,
    watchlistSynced: false,
    inboxEvents: 0,
    xxyyDoorbells: 0,
    walletsHit: 0,
    tradesUpserted: 0,
    walletsScanned: 0,
    gmgnErrors: 0,
  };

  if (env.PILI_GMGN_RECOVERY_PAUSED === '1') {
    return {
      sleepMs: 30_000,
      status: 'idle',
      lastError: 'paused for newone self-holdings recovery',
      summary: emptySummary,
    };
  }

  if (mode === 'xxyy') {
    return {
      sleepMs: DEFAULT_IDLE_MS,
      status: 'disabled',
      lastError: null,
      summary: emptySummary,
    };
  }

  const inboxCfg = readAlchemyInboxConfig(env);
  // Alchemy inbox is preferred but not mandatory if XXYY doorbells can still ring.
  const listUsers = deps.listUsers ?? listMonitoredUsers;
  const pullInbox = deps.pullInbox ?? pullAlchemyInbox;
  const claimDoorbells = deps.claimDoorbells ?? claimDueLiveDoorbells;
  const ackDoorbells = deps.ackDoorbells ?? ackLiveDoorbells;
  const nackDoorbellsDep = deps.nackDoorbells ?? nackLiveDoorbells;
  const cooldownRemaining = deps.gmgnCooldownRemainingMs ?? gmgnCooldownRemainingMs;
  const recoveryFactor =
    deps.gmgnRecoveryFactor ??
    (deps.gmgnCooldownRemainingMs ? () => 1 : getGmgnRecoveryFactor);
  const syncWatchlistFn = deps.syncWatchlist ?? syncAlchemyWatchlist;
  const fetchActivity = deps.fetchActivity ?? fetchGmgnWalletActivityAsync;
  const upsertTrades = deps.upsertTrades ?? upsertLiveMonitorTrades;

  const users = listUsers();
  const { addresses, byLower } = collectWatchedAddresses(users);

  let watchlistSynced = false;
  let lastError: string | null = null;
  const watchlistEvery = Number(env.PILI_LIVE_WATCHLIST_EVERY_MS || DEFAULT_WATCHLIST_EVERY_MS);
  const webhookIds = readPiliAlchemyWebhookIdsFromEnv(env);
  const watchlistToken = readWatchlistToken(env);

  // Shared Alchemy plan has max 5 webhooks with newone — only manage addresses
  // when explicitly opted in. Default: newone/feishu owns the watchlist.
  const manageWatchlist = (env.PILI_ALCHEMY_MANAGE_WATCHLIST || '').trim() === '1';
  if (
    manageWatchlist &&
    hasPiliOwnedWebhookIds(webhookIds) &&
    watchlistToken &&
    now() - lastWatchlistAt >= (Number.isFinite(watchlistEvery) ? watchlistEvery : DEFAULT_WATCHLIST_EVERY_MS)
  ) {
    try {
      await syncWatchlistFn({
        token: watchlistToken,
        webhook_ids: webhookIds,
        addresses,
      });
      lastWatchlistAt = now();
      watchlistSynced = true;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  let inboxEvents = 0;
  let xxyyDoorbells = 0;
  let walletsHit = 0;
  let tradesUpserted = 0;
  let walletsScanned = 0;
  let gmgnErrors = 0;
  const enqueueRefresh = deps.enqueueHoldingsRefresh ?? enqueueHoldingsRefresh;
  const claimLimit = Math.max(
    1,
    Math.min(
      200,
      Math.floor(readPositiveEnvNumber(env, 'PILI_LIVE_DOORBELL_CLAIM_LIMIT', DEFAULT_DOORBELL_CLAIM_LIMIT))
    )
  );

  // A claimed doorbell is still useful during GMGN cooldown: OKX-backed EVM and
  // Solana holdings can refresh independently of GMGN. Leave the doorbell
  // unacked so it is reclaimed for trade enrichment once cooldown clears.
  const enqueueCooldownHoldings = (doorbells: LiveDoorbellRow[]) => {
    for (const doorbell of doorbells) {
      const owner = byLower.get(doorbell.address.toLowerCase());
      if (!owner) continue;
      for (const chain of resolveChainsForDoorbell(owner.address, doorbell.chains)) {
        if (chain === 'robinhood') continue;
        try {
          enqueueRefresh({ address: owner.address, chain, userId: owner.user.id });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          lastError = lastError || `holdings enqueue failed: ${message}`;
          console.error(
            `[live-monitor] cooldown holdings enqueue failed for ${owner.address}/${chain}: ${message}`
          );
        }
      }
    }
  };

  try {
    // GMGN is the sole trade-detail source. While a ban is active every scan would
    // fail at assertGmgnAllowed. Claim local doorbells only to trigger independent
    // holdings refreshes; leave them unacked and never pull the Alchemy inbox so
    // the trade signal remains available after cooldown.
    const banRemainingMs = cooldownRemaining(now());
    // 冷却期当然跳过。但冷却解除后 GMGN 滚动惩罚窗口（5min）还没完全清空，
    // 立即恢复 wallet_activity 扫描会续杯再封。利用慢启动因子判断是否在恢复期：
    // factor < 1.0 说明 lastBanAt 在 5min 内，继续 hold 门铃不扫，给窗口清空时间。
    // （acquireGmgnGlobalToken 的慢启动已压 RPS，但 live-monitor 的并发请求
    // 仍可能撞窗口。全量跳过 5min 恢复期最干净。）
    if (banRemainingMs > 0 || recoveryFactor(now()) < 1.0) {
      const doorbells = claimDoorbells({ nowMs: now(), limit: claimLimit });
      xxyyDoorbells = doorbells.length;
      enqueueCooldownHoldings(doorbells);
      const cycleMs = Number(env.PILI_LIVE_CYCLE_MS || DEFAULT_CYCLE_MS);
      return {
        sleepMs: Number.isFinite(cycleMs) ? cycleMs : DEFAULT_CYCLE_MS,
        status: 'idle',
        lastError: `GMGN_COOLDOWN ${Math.ceil(banRemainingMs / 1000)}s remaining — doorbells held, holdings queued`,
        summary: { ...emptySummary, xxyyDoorbells },
      };
    }

    const doorbells = claimDoorbells({ nowMs: now(), limit: claimLimit });
    xxyyDoorbells = doorbells.length;

    // Claim the local XXYY doorbells before touching the optional Alchemy inbox.
    // The inbox is a complementary source: a transient CF/network failure must
    // not prevent already queued XXYY rings from reaching GMGN. pullInbox only
    // advances its cursor after a successful response, so a failed pull is safe
    // to report as partial while the local doorbells continue below.
    let alchemyWallets: string[] = [];
    if (inboxCfg) {
      try {
        const pulled = await pullInbox({
          base_url: inboxCfg.base_url,
          token: inboxCfg.token,
          watched_addresses: addresses,
          limit: 100,
        });
        inboxEvents = pulled.events;
        alchemyWallets = pulled.wallets;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    } else if (!lastError) {
      lastError = 'missing PILI_ALCHEMY_INBOX_URL / PULL_TOKEN (xxyy doorbells still scanned)';
    }

    const targets = buildScanTargets({
      alchemyWallets,
      doorbells,
      byLower,
    });
    walletsHit = targets.length;

    const lookbackSec = Number(env.PILI_LIVE_LOOKBACK_SEC || DEFAULT_LOOKBACK_SEC);
    const afterTs =
      Math.floor(now() / 1000) -
      (Number.isFinite(lookbackSec) && lookbackSec > 0 ? lookbackSec : DEFAULT_LOOKBACK_SEC);
    const minCost = Number(env.PILI_LIVE_MIN_COST_USD || 0);

    // Quiet both doorbells → idle; otherwise scan only wallets that rang.
    // Each target is committed independently. A single slow GMGN request must not
    // hold all successful wallets in memory until the whole batch finishes.
    const maxConcurrentScansRaw = Number(env.PILI_LIVE_MAX_CONCURRENCY || 1);
    const maxConcurrentScans = Number.isFinite(maxConcurrentScansRaw)
      ? Math.max(1, Math.min(2, Math.floor(maxConcurrentScansRaw)))
      : 1;
    const activityTimeoutMs = readPositiveEnvNumber(
      env,
      'PILI_LIVE_ACTIVITY_TIMEOUT_MS',
      DEFAULT_ACTIVITY_TIMEOUT_MS
    );
    const leaseByWalletLower = new Map<string, string>();
    for (const doorbell of doorbells) {
      leaseByWalletLower.set(doorbell.walletLower, doorbell.leaseToken);
    }

    const enqueuedHoldingKeys = new Set<string>();
    const enqueueTargetHolding = (target: ScanTarget, chain: string) => {
      const key = `${chain.toLowerCase()}:${target.address.toLowerCase()}`;
      if (enqueuedHoldingKeys.has(key)) return;
      enqueuedHoldingKeys.add(key);
      try {
        enqueueRefresh({ address: target.address, chain, userId: target.user.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = lastError || `holdings enqueue failed: ${message}`;
        console.error(`[live-monitor] holdings enqueue failed for ${target.address}/${chain}: ${message}`);
      }
    };

    // A doorbell already proves that the wallet changed on-chain. Enqueue the
    // balance snapshot before GMGN activity enrichment so OKX-backed holdings
    // do not wait for the slower Feed reconciliation path.
    for (const target of targets) {
      for (const chain of target.chains) {
        enqueueTargetHolding(target, chain);
      }
    }

    const processTarget = async (target: ScanTarget) => {
      const trades: NormalizedLiveTrade[] = [];
      let targetError: string | null = null;

      for (let index = 0; index < target.chains.length; index += 1) {
        const chain = target.chains[index]!;
        // robinhood 恒空:非事件驱动时按钱包轮换探测,其余周期跳过(省 ~1/4
        // EVM activity 请求)。事件(doorbell chains 含 robinhood)不受影响。
        if (chain === 'robinhood' && !target.eventChains.has(chain)) {
          if (!shouldProbeRobinhood(target.address)) continue;
        }
        walletsScanned += 1;
        try {
          const response = await fetchActivityWithTimeout(
            (signal) =>
              fetchActivity({
                chain,
                wallet: target.address,
                limit: 30,
                type: ['buy', 'sell'],
                signal,
              }),
            activityTimeoutMs
          );
          trades.push(
            ...normalizeGmgnActivityItems(response.items, {
              wallet: target.address,
              chain,
              min_cost_usd: Number.isFinite(minCost) ? minCost : 0,
              after_ts: afterTs,
            })
          );
        } catch (error) {
          gmgnErrors += 1;
          targetError = targetError || (error instanceof Error ? error.message : String(error));
          lastError = error instanceof Error ? error.message : String(error);
        }

        // Keep a small gap between requests from the same worker. The default
        // concurrency is one, so this also spreads requests across wallets.
        if (index < target.chains.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      if (trades.length > 0) {
        trades.sort((a, b) => a.eventTimeMs - b.eventTimeMs);
        try {
          const result = upsertTrades({ user: target.user, trades });
          tradesUpserted += result.upserted;
          if (result.upserted > 0) {
            const seenWalletChains = new Set<string>();
            for (const trade of trades) {
              const wallet = (trade.wallet || '').trim();
              const chain = (trade.chain || '').trim();
              if (!wallet || !chain) continue;
              const key = `${chain.toLowerCase()}:${wallet.toLowerCase()}`;
              if (seenWalletChains.has(key) || enqueuedHoldingKeys.has(key)) continue;
              seenWalletChains.add(key);
              enqueueTargetHolding(target, chain);
            }
          }
        } catch (error) {
          targetError = targetError || (error instanceof Error ? error.message : String(error));
          lastError = error instanceof Error ? error.message : String(error);
        }
      }

      const leaseToken = leaseByWalletLower.get(target.address.toLowerCase());
      if (!leaseToken) return;
      const claim: DoorbellClaim = {
        walletLower: target.address.toLowerCase(),
        leaseToken,
      };
      if (targetError) {
        nackDoorbellsDep([claim], {
          retryAfterMs: Math.max(cooldownRemaining(now()), 30_000),
        });
      } else {
        ackDoorbells([claim]);
      }
    };

    let nextTarget = 0;
    const workers = Array.from({ length: Math.min(maxConcurrentScans, targets.length) }, async () => {
      while (nextTarget < targets.length) {
        const index = nextTarget++;
        await processTarget(targets[index]!);
      }
    });
    await Promise.all(workers);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    const cycleMs = Number(env.PILI_LIVE_CYCLE_MS || DEFAULT_CYCLE_MS);
    return {
      sleepMs: Number.isFinite(cycleMs) ? cycleMs : DEFAULT_CYCLE_MS,
      status: 'error',
      lastError,
      summary: {
        mode,
        watchlistSynced,
        inboxEvents,
        xxyyDoorbells,
        walletsHit,
        tradesUpserted,
        walletsScanned,
        gmgnErrors,
      },
    };
  }

  const cycleMs = Number(env.PILI_LIVE_CYCLE_MS || DEFAULT_CYCLE_MS);
  const status =
    lastError && tradesUpserted === 0 && walletsHit === 0 && !inboxCfg
      ? 'error'
      : lastError && tradesUpserted === 0 && walletsHit > 0
        ? 'error'
        : lastError && tradesUpserted === 0 && xxyyDoorbells === 0 && inboxEvents === 0
          ? // missing inbox but idle otherwise — keep partial/idle soft
            lastError.includes('missing PILI_ALCHEMY')
            ? 'idle'
            : 'error'
          : lastError
            ? 'partial'
            : walletsHit > 0
              ? 'busy'
              : 'idle';

  return {
    sleepMs: Number.isFinite(cycleMs) ? cycleMs : DEFAULT_CYCLE_MS,
    status,
    lastError: status === 'idle' && lastError?.includes('missing PILI_ALCHEMY') ? null : lastError,
    summary: {
      mode,
      watchlistSynced,
      inboxEvents,
      xxyyDoorbells,
      walletsHit,
      tradesUpserted,
      walletsScanned,
      gmgnErrors,
    },
  };
}
