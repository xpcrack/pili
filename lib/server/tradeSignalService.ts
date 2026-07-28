import 'server-only';

import { pushBark } from '@/lib/server/barkNotify';
import { getDb, withSqliteBusyRetry } from '@/lib/server/sqlite';
import { readSystemConfig } from '@/lib/server/systemConfigRepo';
import {
  selectTradeSignals,
  type TradeSignal,
  type TradeSignalCandidate,
  type TradeSignalConfig,
  type TraderQuality,
} from '@/lib/tradeSignal';

/**
 * Turns recent trades into phone pushes, gated on measured win rate.
 *
 * Background worker only. Dedupe state lives in `trade_signal_alerts` rather
 * than in memory, so a worker restart cannot re-push signals already sent —
 * the mistake the existing in-process collision dedupe makes.
 */

const CYCLE_INTERVAL_MS = 2 * 60_000;
/** Never alert on something older than this, e.g. after the worker was down. */
const MAX_SIGNAL_AGE_MS = 60 * 60_000;
/** Cap pushes per cycle so a backfill burst cannot spam the phone. */
const MAX_PUSHES_PER_CYCLE = 5;

export interface TradeSignalRunResult {
  enabled: boolean;
  candidates: number;
  selected: number;
  fresh: number;
  pushed: number;
  delivered: number;
  suppressedCooldown: number;
  suppressedStale: number;
  skippedOverCap: number;
}

interface CandidateRow {
  event_id: string;
  timestamp: number;
  user_id: string | null;
  user_name: string | null;
  activity_json: string;
}

function normalizeText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function resolveVariant(metadata: Record<string, unknown>): TradeSignalCandidate['variant'] | null {
  const variant = normalizeText(metadata.txActionVariant).toLowerCase();
  if (variant === 'open' || variant === 'add' || variant === 'reduce' || variant === 'close') {
    return variant;
  }
  const label = normalizeText(metadata.displayActionVariantLabel) || normalizeText(metadata.txActionLabel);
  if (label === '建仓') return 'open';
  if (label === '加仓') return 'add';
  if (label === '减仓') return 'reduce';
  if (label === '清仓') return 'close';
  return null;
}

function loadCandidates(sinceMs: number): TradeSignalCandidate[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT e.event_id, e.timestamp, e.user_id, u.name AS user_name, e.activity_json
       FROM events e
       LEFT JOIN tracked_users u ON u.id = e.user_id
       WHERE e.source = 'blockchain'
         AND e.timestamp >= ?
         AND e.user_id IS NOT NULL
       ORDER BY e.timestamp ASC`
    )
    .all(sinceMs) as CandidateRow[];

  const candidates: TradeSignalCandidate[] = [];
  for (const row of rows) {
    let metadata: Record<string, unknown>;
    try {
      const activity = JSON.parse(row.activity_json) as { metadata?: Record<string, unknown> };
      metadata = activity.metadata || {};
    } catch {
      continue;
    }

    const variant = resolveVariant(metadata);
    const chain = normalizeText(metadata.chain).toLowerCase();
    const tokenAddress = normalizeText(metadata.tokenAddress);
    if (!variant || !chain || !tokenAddress || !row.user_id) continue;

    candidates.push({
      eventId: row.event_id,
      timestamp: row.timestamp,
      userId: row.user_id,
      userName: row.user_name,
      chain,
      tokenAddress,
      tokenSymbol: normalizeText(metadata.token) || null,
      variant,
      tradeAmountUsd: toFiniteNumber(metadata.tradeAmountUsdAtTx),
      marketCapUsd: toFiniteNumber(metadata.marketCapAtTxUsd),
    });
  }
  return candidates;
}

function loadTraderQuality(): Map<string, TraderQuality> {
  const db = getDb();
  const rows = db
    .prepare(`SELECT user_id, win_rate, round_trips, realized_pnl_usd, median_multiple, followability_score
       FROM user_pnl_stats`)
    .all() as Array<{
    user_id: string;
    win_rate: number | null;
    round_trips: number;
    realized_pnl_usd: number;
    median_multiple: number | null;
    followability_score: number | null;
  }>;

  const map = new Map<string, TraderQuality>();
  for (const row of rows) {
    map.set(row.user_id, {
      winRate: toFiniteNumber(row.win_rate),
      roundTrips: Number(row.round_trips) || 0,
      realizedPnlUsd: Number(row.realized_pnl_usd) || 0,
      medianMultiple: toFiniteNumber(row.median_multiple),
      followabilityScore: toFiniteNumber(row.followability_score),
    });
  }
  return map;
}

/** Already-sent dedupe keys, plus per person×token cooldown state. */
function loadAlertState(sinceMs: number) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT dedupe_key, user_id, chain, token_address_lower, triggered_at
       FROM trade_signal_alerts
       WHERE triggered_at >= ?`
    )
    .all(sinceMs) as Array<{
    dedupe_key: string;
    user_id: string | null;
    chain: string;
    token_address_lower: string;
    triggered_at: number;
  }>;

  const sentKeys = new Set<string>();
  const lastAlertAt = new Map<string, number>();
  for (const row of rows) {
    sentKeys.add(row.dedupe_key);
    if (row.user_id) {
      const key = `${row.user_id}|${row.chain}|${row.token_address_lower}`;
      lastAlertAt.set(key, Math.max(lastAlertAt.get(key) ?? 0, row.triggered_at));
    }
  }
  return { sentKeys, lastAlertAt };
}

function recordAlert(signal: TradeSignal, delivered: boolean, sentAt: number) {
  withSqliteBusyRetry(
    () => {
      getDb()
        .prepare(
          `INSERT INTO trade_signal_alerts (
             dedupe_key, signal_type, user_id, chain, token_address_lower, token_symbol,
             trade_amount_usd, market_cap_usd, detail_json, triggered_at, sent_at, delivered
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(dedupe_key) DO NOTHING`
        )
        .run(
          signal.dedupeKey,
          signal.type,
          signal.userIds[0] ?? null,
          signal.chain,
          signal.tokenAddress.toLowerCase(),
          signal.tokenSymbol,
          signal.tradeAmountUsd,
          signal.marketCapUsd,
          JSON.stringify({ userIds: signal.userIds, userNames: signal.userNames, title: signal.title }),
          signal.timestamp,
          sentAt,
          delivered ? 1 : 0
        );
    },
    { label: 'tradeSignal.recordAlert' }
  );
}

export async function runTradeSignalCheck(options: { now?: number } = {}): Promise<TradeSignalRunResult> {
  const now = options.now ?? Date.now();
  const config = readSystemConfig();

  const empty: TradeSignalRunResult = {
    enabled: config.tradeSignalEnabled,
    candidates: 0,
    selected: 0,
    fresh: 0,
    pushed: 0,
    delivered: 0,
    suppressedCooldown: 0,
    suppressedStale: 0,
    skippedOverCap: 0,
  };
  if (!config.tradeSignalEnabled) return empty;

  const signalConfig: TradeSignalConfig = {
    minWinRate: config.tradeSignalMinWinRate,
    minRoundTrips: config.tradeSignalMinRoundTrips,
    minFollowability: config.tradeSignalMinFollowability,
    minTradeUsd: config.tradeSignalMinTradeUsd,
    minMarketCapUsd: config.tradeSignalMinMarketCapUsd,
    maxMarketCapUsd: config.tradeSignalMaxMarketCapUsd,
    coHitMinUsers: config.tradeSignalCoHitMinUsers,
    coHitWindowMinutes: config.tradeSignalCoHitWindowMinutes,
  };

  // Read back far enough that co-hit grouping sees its whole window.
  const lookbackMs = Math.max(config.tradeSignalCoHitWindowMinutes * 60_000, MAX_SIGNAL_AGE_MS);
  const candidates = loadCandidates(now - lookbackMs);
  const qualityByUserId = loadTraderQuality();
  const signals = selectTradeSignals({ candidates, qualityByUserId, config: signalConfig });

  const cooldownMs = config.tradeSignalCooldownMinutes * 60_000;
  const { sentKeys, lastAlertAt } = loadAlertState(now - Math.max(cooldownMs, lookbackMs));

  const result: TradeSignalRunResult = { ...empty, candidates: candidates.length, selected: signals.length };

  for (const signal of signals) {
    if (sentKeys.has(signal.dedupeKey)) continue;

    if (now - signal.timestamp > MAX_SIGNAL_AGE_MS) {
      result.suppressedStale += 1;
      // Record it so a later cycle does not reconsider the same stale signal.
      recordAlert(signal, false, now);
      continue;
    }

    const cooldownKey = `${signal.userIds[0]}|${signal.chain}|${signal.tokenAddress.toLowerCase()}`;
    const lastAt = lastAlertAt.get(cooldownKey);
    if (lastAt != null && signal.timestamp - lastAt < cooldownMs) {
      result.suppressedCooldown += 1;
      recordAlert(signal, false, now);
      continue;
    }

    result.fresh += 1;
    if (result.pushed >= MAX_PUSHES_PER_CYCLE) {
      result.skippedOverCap += 1;
      continue;
    }

    const push = await pushBark({
      title: signal.title,
      body: signal.body,
      group: 'pili-signal',
      // Co-hit is the rarer, stronger signal — let it ring through silent mode.
      level: signal.type === 'co-hit' ? 'critical' : 'timeSensitive',
    });

    result.pushed += 1;
    if (push.delivered > 0) result.delivered += 1;
    recordAlert(signal, push.delivered > 0, now);
    lastAlertAt.set(cooldownKey, signal.timestamp);
    sentKeys.add(signal.dedupeKey);
  }

  if (result.skippedOverCap > 0) {
    console.warn(
      `[trade-signal] ${result.skippedOverCap} signal(s) skipped this cycle (cap ${MAX_PUSHES_PER_CYCLE}/cycle)`
    );
  }

  return result;
}

/** Runtime task entrypoint — background worker only. */
export async function runTradeSignalCycle(): Promise<{
  sleepMs: number;
  status: string;
  detail: Record<string, unknown>;
}> {
  const result = await runTradeSignalCheck();
  return {
    sleepMs: CYCLE_INTERVAL_MS,
    status: result.enabled ? 'ok' : 'idle',
    detail: { ...result },
  };
}
