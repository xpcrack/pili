import 'server-only';

import { type Activity, type ActivitySource, type User } from '@/types';
import { readEventsFeed, type EventFeedRow } from '@/lib/server/eventsRepo';

export interface OpportunityToken {
  symbol: string | null;
  address: string | null;
}

export interface OpportunityWallet {
  label: string | null;
  address: string | null;
}

export interface OpportunityItem {
  id: string;
  ts: number;
  source: ActivitySource;
  chain: string | null;
  action: string | null;
  token: OpportunityToken;
  wallet: OpportunityWallet;
  tradeUsd: number | null;
  marketCapUsd: number | null;
  coHitUsers: number;
  coHitAddrs: number;
  importance: number;
  sentiment: 'positive' | 'negative' | 'neutral' | null;
  text: string;
  permalink: string | null;
}

export interface OpportunityQuery {
  since: number;
  limit: number;
  minUsd: number;
  minCoHit: number;
  minImportance: number;
  actions: Set<string>;
  chains: Set<string>;
  sources: Set<ActivitySource>;
  windowHours: number;
}

export interface OpportunityResult {
  items: OpportunityItem[];
  nextSince: number;
  hasMore: boolean;
  truncated: boolean;
  rules: {
    minUsd: number;
    minCoHit: number;
    minImportance: number;
    actions: string[];
    chains: string[];
    sources: string[];
    windowHours: number;
  };
}

const RAW_FETCH_LIMIT = 200;
const RAW_FETCH_MAX_PAGES = 10;
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

export function selectOpportunities(query: OpportunityQuery): OpportunityResult {
  const now = Date.now();
  const windowStartMs = now - query.windowHours * 3600 * 1000;
  const effectiveSince = Math.max(query.since, windowStartMs);
  const truncated = query.since < windowStartMs;

  const rawRows: EventFeedRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < RAW_FETCH_MAX_PAGES; page += 1) {
    const result = readEventsFeed({
      limit: RAW_FETCH_LIMIT,
      cursor,
      fromMs: effectiveSince,
      toMs: null,
    });
    rawRows.push(...result.feed);
    if (!result.hasMore || !result.nextCursor) {
      break;
    }
    cursor = result.nextCursor;
  }

  const matched = rawRows.filter((row) => matchesRules(row, query));
  const deduped = dedupByTokenWindow(matched);
  deduped.sort((a, b) => b.activity.timestamp - a.activity.timestamp);

  const pageItems = deduped.slice(0, query.limit);
  const items = pageItems.map(toCompact);
  const hasMore = deduped.length > query.limit;

  const nextSince = items.length > 0
    ? Math.max(...items.map((item) => item.ts)) + 1
    : Math.max(query.since, effectiveSince);

  return {
    items,
    nextSince,
    hasMore,
    truncated,
    rules: {
      minUsd: query.minUsd,
      minCoHit: query.minCoHit,
      minImportance: query.minImportance,
      actions: Array.from(query.actions),
      chains: Array.from(query.chains),
      sources: Array.from(query.sources),
      windowHours: query.windowHours,
    },
  };
}

function matchesRules(row: EventFeedRow, query: OpportunityQuery): boolean {
  const { activity } = row;

  if (!query.sources.has(activity.source)) {
    return false;
  }

  const chain = activity.metadata.chain || null;
  if (query.chains.size > 0) {
    if (!chain || !query.chains.has(chain)) {
      return false;
    }
  }

  if (activity.source === 'blockchain') {
    const variant = activity.metadata.txActionVariant;
    if (!variant || !query.actions.has(variant)) {
      return false;
    }
  }

  const tradeUsd = activity.metadata.tradeAmountUsdAtTx ?? null;
  const coHitUsers = activity.metadata.coHitUserCount ?? 0;
  const coHitAddrs = activity.metadata.coHitAddressCount ?? 0;
  const importance = activity.metadata.importance?.score ?? 0;

  const signalTradeUsd = tradeUsd !== null && tradeUsd >= query.minUsd;
  const signalCoHit = coHitUsers >= query.minCoHit || coHitAddrs >= query.minCoHit;
  const signalImportance = importance >= query.minImportance;
  const signalSocial = activity.source !== 'blockchain' && hasPositiveSocialSignal(activity);

  return signalTradeUsd || signalCoHit || signalImportance || signalSocial;
}

function hasPositiveSocialSignal(activity: Activity): boolean {
  const sentiments = activity.metadata.tokenSentiments || [];
  const hasPositive = sentiments.some((entry) => entry.sentiment === 'positive');
  if (!hasPositive) {
    return false;
  }

  const tickers = activity.metadata.mentionedTickers || [];
  const addresses = activity.metadata.mentionedTokenAddresses || [];
  return tickers.length > 0 || addresses.length > 0;
}

function dedupByTokenWindow(rows: EventFeedRow[]): EventFeedRow[] {
  const sorted = [...rows].sort((a, b) => a.activity.timestamp - b.activity.timestamp);
  const groups = new Map<string, EventFeedRow>();

  for (const row of sorted) {
    const key = buildDedupKey(row);
    if (!key) {
      groups.set(`__nokey:${row.activity.id}`, row);
      continue;
    }

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, row);
      continue;
    }

    const sameWindow = Math.abs(existing.activity.timestamp - row.activity.timestamp) <= DEDUP_WINDOW_MS;
    if (!sameWindow) {
      const windowKey = `${key}:${Math.floor(row.activity.timestamp / DEDUP_WINDOW_MS)}`;
      groups.set(windowKey, row);
      continue;
    }

    const existingImportance = existing.activity.metadata.importance?.score ?? 0;
    const candidateImportance = row.activity.metadata.importance?.score ?? 0;
    if (candidateImportance > existingImportance) {
      groups.set(key, row);
    }
  }

  return Array.from(groups.values());
}

function buildDedupKey(row: EventFeedRow): string | null {
  const chain = row.activity.metadata.chain || '';
  const tokenAddress = row.activity.metadata.tokenAddress || '';
  if (!chain || !tokenAddress) {
    return null;
  }
  return `${chain}:${tokenAddress.toLowerCase()}`;
}

function toCompact(row: EventFeedRow): OpportunityItem {
  const { activity, user } = row;
  const metadata = activity.metadata;

  return {
    id: activity.id,
    ts: activity.timestamp,
    source: activity.source,
    chain: metadata.chain || null,
    action: resolveAction(activity),
    token: {
      symbol: metadata.displayTokenSymbol || metadata.token || pickFirst(metadata.mentionedTickers),
      address: metadata.tokenAddress || pickFirst(metadata.mentionedTokenAddresses),
    },
    wallet: resolveWallet(activity, user),
    tradeUsd: metadata.tradeAmountUsdAtTx ?? null,
    marketCapUsd: metadata.marketCapAtTxUsd ?? null,
    coHitUsers: metadata.coHitUserCount ?? 0,
    coHitAddrs: metadata.coHitAddressCount ?? 0,
    importance: metadata.importance?.score ?? 0,
    sentiment: resolveSentiment(activity),
    text: resolveText(activity),
    permalink: resolvePermalink(activity),
  };
}

function resolveAction(activity: Activity): string | null {
  if (activity.source === 'blockchain') {
    return activity.metadata.txActionVariant || activity.metadata.txAction || null;
  }
  return activity.type || null;
}

function resolveWallet(activity: Activity, user: User): OpportunityWallet {
  if (activity.source !== 'blockchain') {
    return { label: user.name || user.handle || null, address: null };
  }
  const label =
    activity.metadata.monitorWalletAliasLabel ||
    activity.metadata.monitorWalletLabel ||
    activity.metadata.displayWalletLabel ||
    user.name ||
    null;
  const address = activity.metadata.trackedAddress || activity.metadata.fromAddress || null;
  return { label, address };
}

function resolveSentiment(activity: Activity): 'positive' | 'negative' | 'neutral' | null {
  const sentiments = activity.metadata.tokenSentiments || [];
  if (sentiments.length === 0) {
    return null;
  }
  const positive = sentiments.find((entry) => entry.sentiment === 'positive');
  if (positive) {
    return 'positive';
  }
  const negative = sentiments.find((entry) => entry.sentiment === 'negative');
  if (negative) {
    return 'negative';
  }
  return sentiments[0].sentiment;
}

function resolveText(activity: Activity): string {
  if (activity.metadata.displayTradeAmountText) {
    return activity.metadata.displayTradeAmountText.slice(0, 200);
  }
  const raw = (activity.content || activity.metadata.rawText || '').trim();
  return raw.slice(0, 200);
}

function resolvePermalink(activity: Activity): string | null {
  if (activity.metadata.tweetUrl) {
    return activity.metadata.tweetUrl;
  }
  if (activity.metadata.telegramPostUrl) {
    return activity.metadata.telegramPostUrl;
  }
  return null;
}

function pickFirst(values: string[] | undefined): string | null {
  if (!values || values.length === 0) {
    return null;
  }
  const first = values[0];
  return typeof first === 'string' && first.trim() ? first : null;
}
