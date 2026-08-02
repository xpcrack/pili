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
 */
import 'server-only';

import { pullAlchemyInbox } from '@/lib/server/alchemyInbox';
import {
  hasPiliOwnedWebhookIds,
  readPiliAlchemyWebhookIdsFromEnv,
  syncAlchemyWatchlist,
} from '@/lib/server/alchemyWatchlist';
import {
  fetchGmgnWalletActivity,
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
import { gmgnCooldownRemainingMs } from '@/lib/server/gmgnRateLimit';
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

type LiveScanResult = {
  key: string;
  user: User;
  trades: NormalizedLiveTrade[];
  error: string | null;
};

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
  fetchActivity?: (
    options: Parameters<typeof fetchGmgnWalletActivity>[0]
  ) => ReturnType<typeof fetchGmgnWalletActivity> | ReturnType<typeof fetchGmgnWalletActivityAsync>;
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
};

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
      continue;
    }
    merged.set(key, {
      key: `${user.id}:${key}`,
      user,
      address,
      chains,
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

  try {
    // GMGN is the sole trade-detail source. While a ban is active every scan would
    // fail at assertGmgnAllowed; rather than claim+drop doorbells (consuming the
    // ring and losing the signal) or pull+advance the Alchemy inbox cursor (consuming
    // on-chain events we then can't scan), hold everything and idle until it clears.
    const banRemainingMs = cooldownRemaining(now());
    if (banRemainingMs > 0) {
      const cycleMs = Number(env.PILI_LIVE_CYCLE_MS || DEFAULT_CYCLE_MS);
      return {
        sleepMs: Number.isFinite(cycleMs) ? cycleMs : DEFAULT_CYCLE_MS,
        status: 'idle',
        lastError: `GMGN_COOLDOWN ${Math.ceil(banRemainingMs / 1000)}s remaining — doorbells held, no pull/scan`,
        summary: emptySummary,
      };
    }

    let alchemyWallets: string[] = [];
    if (inboxCfg) {
      const pulled = await pullInbox({
        base_url: inboxCfg.base_url,
        token: inboxCfg.token,
        watched_addresses: addresses,
        limit: 100,
      });
      inboxEvents = pulled.events;
      alchemyWallets = pulled.wallets;
    } else if (!lastError) {
      lastError = 'missing PILI_ALCHEMY_INBOX_URL / PULL_TOKEN (xxyy doorbells still scanned)';
    }

    const doorbells = claimDoorbells({ nowMs: now() });
    xxyyDoorbells = doorbells.length;

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
    const maxConcurrentScansRaw = Number(env.PILI_LIVE_MAX_CONCURRENCY || 3);
    const maxConcurrentScans = Number.isFinite(maxConcurrentScansRaw)
      ? Math.max(1, Math.min(3, Math.floor(maxConcurrentScansRaw)))
      : 3;
    const scanTasks = targets.flatMap((target) =>
      target.chains.map((chain) => async () => {
        try {
          const response = await fetchActivity({
            chain,
            wallet: target.address,
            limit: 30,
            type: ['buy', 'sell'],
          });
          const { items } = await response;
          return {
            key: target.key,
            user: target.user,
            trades: normalizeGmgnActivityItems(items, {
              wallet: target.address,
              chain,
              min_cost_usd: Number.isFinite(minCost) ? minCost : 0,
              after_ts: afterTs,
            }),
            error: null,
          };
        } catch (error) {
          return {
            key: target.key,
            user: target.user,
            trades: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );

    const scanResults: LiveScanResult[] = [];
    let nextScan = 0;
    const workers = Array.from({ length: Math.min(maxConcurrentScans, scanTasks.length) }, async () => {
      while (nextScan < scanTasks.length) {
        const index = nextScan++;
        scanResults.push(await scanTasks[index]!());
      }
    });
    await Promise.all(workers);
    walletsScanned = scanTasks.length;
    const tradesByOwner = new Map<string, { user: User; trades: NormalizedLiveTrade[] }>();
    for (const result of scanResults) {
      if (result.error) {
        gmgnErrors += 1;
        lastError = result.error;
      }
      const current = tradesByOwner.get(result.key) || { user: result.user, trades: [] };
      current.trades.push(...result.trades);
      tradesByOwner.set(result.key, current);
    }
    const enqueueRefresh = deps.enqueueHoldingsRefresh ?? enqueueHoldingsRefresh;
    for (const { user, trades } of tradesByOwner.values()) {
      if (trades.length > 0) {
        trades.sort((a, b) => a.eventTimeMs - b.eventTimeMs);
        const result = upsertTrades({ user, trades });
        tradesUpserted += result.upserted;
        if (result.upserted > 0) {
          const seenWalletChains = new Set<string>();
          for (const trade of trades) {
            const wallet = (trade.wallet || '').trim();
            const chain = (trade.chain || '').trim();
            if (!wallet || !chain) continue;
            const key = `${chain.toLowerCase()}:${wallet.toLowerCase()}`;
            if (seenWalletChains.has(key)) continue;
            seenWalletChains.add(key);
            enqueueRefresh({
              address: wallet,
              chain,
              userId: user.id,
            });
          }
        }
      }
    }

    // Confirmed-consume write-back for doorbells. A wallet's doorbell is ack'd
    // (deleted) only when every one of its chain scans completed without error —
    // an empty GMGN response (trades:[] but error:null) counts as "scanned, nothing
    // new" and is ack'd so we don't nack-loop forever. Any error → nack with a
    // retry after max(ban remaining, 30s); the cooldown file is already updated by
    // noteGmgnBan during the scan, so this reads the latest ban window.
    if (doorbells.length > 0) {
      const leaseByWalletLower = new Map<string, string>();
      for (const d of doorbells) leaseByWalletLower.set(d.walletLower, d.leaseToken);
      // Collect which target keys had any scan error.
      const erroredKeys = new Set<string>();
      for (const result of scanResults) {
        if (result.error) erroredKeys.add(result.key);
      }
      const ackClaims: DoorbellClaim[] = [];
      const nackClaims: DoorbellClaim[] = [];
      for (const target of targets) {
        const leaseToken = leaseByWalletLower.get(target.address.toLowerCase());
        if (!leaseToken) continue; // Alchemy-only target, no doorbell lease.
        const claim = { walletLower: target.address.toLowerCase(), leaseToken };
        if (erroredKeys.has(target.key)) {
          nackClaims.push(claim);
        } else {
          ackClaims.push(claim);
        }
      }
      if (ackClaims.length > 0) ackDoorbells(ackClaims);
      if (nackClaims.length > 0) {
        nackDoorbellsDep(nackClaims, {
          retryAfterMs: Math.max(cooldownRemaining(now()), 30_000),
        });
      }
    }
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
