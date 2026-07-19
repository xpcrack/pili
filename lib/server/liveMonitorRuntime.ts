/**
 * Live on-chain monitor runtime: Alchemy doorbell (CF inbox) → GMGN activity → Feed.
 *
 * Env:
 *   PILI_LIVE_SOURCE=dual|alchemy|xxyy   (default dual if alchemy inbox configured, else xxyy)
 *   PILI_ALCHEMY_INBOX_URL / NEWONE_ALCHEMY_INBOX_URL
 *   PILI_ALCHEMY_PULL_TOKEN / NEWONE_ALCHEMY_PULL_TOKEN
 *   PILI_ALCHEMY_WEBHOOK_API_KEY / NEWONE_ALCHEMY_WEBHOOK_API_KEY
 *   PILI_ALCHEMY_WEBHOOK_{ETH,BASE,BSC,SOL,RH}
 *   PILI_LIVE_MIN_COST_USD (default 0)
 *   PILI_LIVE_LOOKBACK_SEC (default 7200)
 *   PILI_LIVE_WATCHLIST_EVERY_MS (default 15m)
 *   PILI_LIVE_CYCLE_MS (default 15s)
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
  inferChainsForAddress,
  normalizeGmgnActivityItems,
  type NormalizedLiveTrade,
} from '@/lib/server/gmgnWalletActivity';
import {
  readLiveSourceMode,
  type EnvMap,
  type LiveSourceMode,
} from '@/lib/server/liveMonitorConfig';
import { upsertLiveMonitorTrades } from '@/lib/server/liveMonitorIngest';
import { listMonitoredUsers } from '@/lib/server/trackedUsersRepo';
import type { User } from '@/types';

export { readLiveSourceMode, readXxyyAllowedChains, shouldAcceptXxyyChain } from '@/lib/server/liveMonitorConfig';
export type { LiveSourceMode } from '@/lib/server/liveMonitorConfig';

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

export interface LiveMonitorCycleResult {
  sleepMs: number;
  status: 'idle' | 'busy' | 'partial' | 'error' | 'disabled';
  lastError: string | null;
  summary: {
    mode: LiveSourceMode;
    watchlistSynced: boolean;
    inboxEvents: number;
    walletsHit: number;
    tradesUpserted: number;
    walletsScanned: number;
    gmgnErrors: number;
  };
}

let lastWatchlistAt = 0;

export type LiveMonitorDeps = {
  listUsers?: () => User[];
  pullInbox?: typeof pullAlchemyInbox;
  syncWatchlist?: typeof syncAlchemyWatchlist;
  fetchActivity?: typeof fetchGmgnWalletActivity;
  upsertTrades?: typeof upsertLiveMonitorTrades;
  now?: () => number;
  env?: EnvMap;
};

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
  if (!inboxCfg) {
    return {
      sleepMs: DEFAULT_IDLE_MS,
      status: 'error',
      lastError: 'missing PILI_ALCHEMY_INBOX_URL / PULL_TOKEN',
      summary: emptySummary,
    };
  }

  const listUsers = deps.listUsers ?? listMonitoredUsers;
  const pullInbox = deps.pullInbox ?? pullAlchemyInbox;
  const syncWatchlistFn = deps.syncWatchlist ?? syncAlchemyWatchlist;
  const fetchActivity = deps.fetchActivity ?? fetchGmgnWalletActivity;
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
  let walletsHit = 0;
  let tradesUpserted = 0;
  let walletsScanned = 0;
  let gmgnErrors = 0;

  try {
    const pulled = await pullInbox({
      base_url: inboxCfg.base_url,
      token: inboxCfg.token,
      watched_addresses: addresses,
      limit: 100,
    });
    inboxEvents = pulled.events;
    walletsHit = pulled.wallets.length;

    const lookbackSec = Number(env.PILI_LIVE_LOOKBACK_SEC || DEFAULT_LOOKBACK_SEC);
    const afterTs =
      Math.floor(now() / 1000) -
      (Number.isFinite(lookbackSec) && lookbackSec > 0 ? lookbackSec : DEFAULT_LOOKBACK_SEC);
    const minCost = Number(env.PILI_LIVE_MIN_COST_USD || 0);

    // If inbox quiet, still idle; only GMGN wallets that rang the doorbell.
    const walletsToScan = pulled.wallets.length > 0 ? pulled.wallets : [];

    for (const wallet of walletsToScan) {
      const owner = byLower.get(wallet.toLowerCase());
      if (!owner) continue;
      const chains = inferChainsForAddress(wallet);
      const allTrades: NormalizedLiveTrade[] = [];
      for (const chain of chains) {
        try {
          const { items } = fetchActivity({
            chain,
            wallet: owner.address,
            limit: 30,
            type: ['buy', 'sell'],
          });
          walletsScanned += 1;
          const trades = normalizeGmgnActivityItems(items, {
            wallet: owner.address,
            chain,
            min_cost_usd: Number.isFinite(minCost) ? minCost : 0,
            after_ts: afterTs,
          });
          allTrades.push(...trades);
        } catch (error) {
          gmgnErrors += 1;
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      if (allTrades.length > 0) {
        const result = upsertTrades({ user: owner.user, trades: allTrades });
        tradesUpserted += result.upserted;
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
        walletsHit,
        tradesUpserted,
        walletsScanned,
        gmgnErrors,
      },
    };
  }

  const cycleMs = Number(env.PILI_LIVE_CYCLE_MS || DEFAULT_CYCLE_MS);
  const status =
    lastError && tradesUpserted === 0
      ? 'error'
      : lastError
        ? 'partial'
        : walletsHit > 0
          ? 'busy'
          : 'idle';

  return {
    sleepMs: Number.isFinite(cycleMs) ? cycleMs : DEFAULT_CYCLE_MS,
    status,
    lastError,
    summary: {
      mode,
      watchlistSynced,
      inboxEvents,
      walletsHit,
      tradesUpserted,
      walletsScanned,
      gmgnErrors,
    },
  };
}
