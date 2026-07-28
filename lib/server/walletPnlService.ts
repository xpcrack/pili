import 'server-only';

import { getDb, withSqliteBusyRetry, withTransaction } from '@/lib/server/sqlite';
import {
  aggregateUserPnl,
  computeFollowability,
  computeSelectorScore,
  computeSeriesRoundTrips,
  DEFAULT_PNL_WINDOW,
  PNL_WINDOWS,
  type PnlWindowKey,
  isQuoteLegToken,
  type PnlRoundTrip,
  type PnlSeriesMeta,
  type PnlTradeInput,
  type PnlTradeVariant,
  type SelectorScoreResult,
  type UserPnlRankingRow,
} from '@/lib/walletPnl';

export type { UserPnlRankingRow };

/**
 * DB-bound owner of `wallet_token_pnl` and `user_pnl_stats`.
 *
 * Reads events, writes only the two derived tables — it never mutates `events`,
 * and it does not touch the frozen `activityImportance*` subsystem.
 *
 * MUST run in `pili-background-worker`, never in the web process: this walks the
 * full trade history synchronously, and position-delta already taught us what a
 * multi-second synchronous scan does to the shared Bun event loop.
 */

const TRADE_VARIANTS = new Set<PnlTradeVariant>(['open', 'add', 'reduce', 'close']);

export interface WalletPnlRunResult {
  scannedRows: number;
  parseFailed: number;
  skippedNoSeries: number;
  skippedQuoteLeg: number;
  series: number;
  roundTrips: number;
  /** The three buckets below are mutually exclusive and sum to roundTrips. */
  closedComplete: number;
  closedPartial: number;
  openPositions: number;
  users: number;
  unrealizedResolved: number;
  durationMs: number;
}

interface EventRow {
  event_id: string;
  timestamp: number;
  user_id: string | null;
  tx_hash: string | null;
  activity_json: string;
}

function normalizeLower(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
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

function resolveVariant(metadata: Record<string, unknown>): PnlTradeVariant | null {
  const variant = normalizeLower(metadata.txActionVariant);
  if (TRADE_VARIANTS.has(variant as PnlTradeVariant)) return variant as PnlTradeVariant;
  const label = normalizeText(metadata.displayActionVariantLabel) || normalizeText(metadata.txActionLabel);
  if (label === '建仓') return 'open';
  if (label === '加仓') return 'add';
  if (label === '减仓') return 'reduce';
  if (label === '清仓') return 'close';
  return null;
}

interface SeriesBucket {
  meta: PnlSeriesMeta;
  trades: PnlTradeInput[];
}

/** Read every trade event and bucket it by chain|wallet|token. */
function loadSeries(): {
  buckets: Map<string, SeriesBucket>;
  scannedRows: number;
  parseFailed: number;
  skippedNoSeries: number;
  skippedQuoteLeg: number;
} {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT event_id, timestamp, user_id, tx_hash, activity_json
       FROM events
       WHERE source = 'blockchain'
         AND (
           json_extract(activity_json, '$.metadata.txActionVariant') IN ('open', 'add', 'reduce', 'close')
           OR json_extract(activity_json, '$.metadata.displayActionVariantLabel') IN ('建仓', '加仓', '减仓', '清仓')
           OR json_extract(activity_json, '$.metadata.txActionLabel') IN ('建仓', '加仓', '减仓', '清仓')
         )
       ORDER BY timestamp ASC, event_id ASC`
    )
    .all() as EventRow[];

  // Pre-pass: a (wallet, tx) that both buys and sells across >1 token is a swap.
  // The sell leg of such a tx ended the position because the money moved into
  // another token — not because the trader decided to exit.
  const swapTxKeys = new Set<string>();
  {
    const legs = new Map<string, { tokens: Set<string>; buys: number; sells: number }>();
    for (const row of rows) {
      if (!row.tx_hash) continue;
      let meta: Record<string, unknown>;
      try {
        meta = (JSON.parse(row.activity_json) as { metadata?: Record<string, unknown> }).metadata || {};
      } catch {
        continue;
      }
      const variant = resolveVariant(meta);
      const wallet = normalizeLower(meta.trackedAddress);
      const token = normalizeLower(meta.tokenAddress);
      if (!variant || !wallet || !token) continue;
      const key = `${wallet}|${row.tx_hash.toLowerCase()}`;
      const entry = legs.get(key) || { tokens: new Set<string>(), buys: 0, sells: 0 };
      entry.tokens.add(token);
      if (variant === 'open' || variant === 'add') entry.buys += 1;
      else entry.sells += 1;
      legs.set(key, entry);
    }
    for (const [key, entry] of legs) {
      if (entry.tokens.size > 1 && entry.buys > 0 && entry.sells > 0) swapTxKeys.add(key);
    }
  }

  const buckets = new Map<string, SeriesBucket>();
  let parseFailed = 0;
  let skippedNoSeries = 0;
  let skippedQuoteLeg = 0;

  for (const row of rows) {
    let metadata: Record<string, unknown>;
    try {
      const activity = JSON.parse(row.activity_json) as { metadata?: Record<string, unknown> };
      metadata = activity.metadata || {};
    } catch {
      parseFailed += 1;
      continue;
    }

    const variant = resolveVariant(metadata);
    if (!variant) {
      skippedNoSeries += 1;
      continue;
    }

    const chain = normalizeLower(metadata.chain);
    const wallet = normalizeText(metadata.trackedAddress);
    const token = normalizeText(metadata.tokenAddress);
    if (!chain || !wallet || !token) {
      skippedNoSeries += 1;
      continue;
    }

    // Swap quote legs (stablecoins, wrapped natives) are not positions.
    if (isQuoteLegToken({ symbol: normalizeText(metadata.token), address: token })) {
      skippedQuoteLeg += 1;
      continue;
    }

    const seriesKey = `${chain}|${wallet.toLowerCase()}|${token.toLowerCase()}`;
    let bucket = buckets.get(seriesKey);
    if (!bucket) {
      bucket = {
        meta: {
          seriesKey,
          userId: row.user_id,
          chain,
          wallet,
          tokenAddress: token,
          tokenSymbol: normalizeText(metadata.token) || null,
        },
        trades: [],
      };
      buckets.set(seriesKey, bucket);
    }
    // Later rows win for identity fields — a renamed/re-attributed wallet should
    // report under its current owner.
    if (row.user_id) bucket.meta.userId = row.user_id;
    const symbol = normalizeText(metadata.token);
    if (symbol) bucket.meta.tokenSymbol = symbol;

    const isSell = variant === 'reduce' || variant === 'close';
    bucket.trades.push({
      timestamp: row.timestamp,
      variant,
      shares: toFiniteNumber(metadata.value),
      usd: toFiniteNumber(metadata.tradeAmountUsdAtTx),
      marketCapUsd: toFiniteNumber(metadata.marketCapAtTxUsd),
      swapOut:
        isSell && row.tx_hash
          ? swapTxKeys.has(`${wallet.toLowerCase()}|${row.tx_hash.toLowerCase()}`)
          : false,
    });
  }

  return { buckets, scannedRows: rows.length, parseFailed, skippedNoSeries, skippedQuoteLeg };
}

/** Current token price per chain|wallet|token, for unrealized PnL on open rounds. */
function loadCurrentPrices(): Map<string, number> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT chain, tracked_address_lower, token_address_lower, price_usd
       FROM current_holdings
       WHERE price_usd IS NOT NULL AND price_usd > 0`
    )
    .all() as Array<{
    chain: string;
    tracked_address_lower: string;
    token_address_lower: string;
    price_usd: number;
  }>;

  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(`${normalizeLower(row.chain)}|${row.tracked_address_lower}|${row.token_address_lower}`, row.price_usd);
  }
  return map;
}

export function runWalletPnlFill(options: { dry?: boolean } = {}): WalletPnlRunResult {
  const startedAt = Date.now();
  const { buckets, scannedRows, parseFailed, skippedNoSeries, skippedQuoteLeg } = loadSeries();
  const prices = loadCurrentPrices();

  const pnlRows: Array<Record<string, unknown>> = [];
  const roundsByUser = new Map<string, PnlRoundTrip[]>();
  const unrealizedByUser = new Map<string, number>();
  // 出手币数 — the wiki's top-weighted dimension. Counted per chain|token so the
  // same ticker on two chains is two positions. Timestamped so each window can
  // count only the tokens traded inside it.
  const tokensByUser = new Map<string, Array<{ tokenKey: string; lastTradeAt: number }>>();

  let roundTrips = 0;
  let closedComplete = 0;
  let closedPartial = 0;
  let openPositions = 0;
  let unrealizedResolved = 0;

  for (const bucket of buckets.values()) {
    const rounds = computeSeriesRoundTrips(bucket.trades);
    if (rounds.length === 0) continue;

    const price = prices.get(bucket.meta.seriesKey) ?? null;

    for (const round of rounds) {
      roundTrips += 1;
      if (round.status === 'open') openPositions += 1;
      else if (round.confidence === 'complete') closedComplete += 1;
      else closedPartial += 1;

      if (bucket.meta.userId) {
        const tokens = tokensByUser.get(bucket.meta.userId) || [];
        tokens.push({
          tokenKey: `${bucket.meta.chain}|${bucket.meta.tokenAddress.toLowerCase()}`,
          lastTradeAt: round.lastTradeAt,
        });
        tokensByUser.set(bucket.meta.userId, tokens);
        const list = roundsByUser.get(bucket.meta.userId) || [];
        list.push(round);
        roundsByUser.set(bucket.meta.userId, list);

        if (round.status === 'open' && round.remainingShares > 0 && price != null) {
          const unrealized = round.remainingShares * price - round.remainingCostUsd;
          if (Number.isFinite(unrealized)) {
            unrealizedByUser.set(bucket.meta.userId, (unrealizedByUser.get(bucket.meta.userId) ?? 0) + unrealized);
            unrealizedResolved += 1;
          }
        }
      }

      pnlRows.push({
        series_key: bucket.meta.seriesKey,
        round_index: round.roundIndex,
        user_id: bucket.meta.userId,
        chain: bucket.meta.chain,
        wallet_address: bucket.meta.wallet,
        wallet_address_lower: bucket.meta.wallet.toLowerCase(),
        token_address: bucket.meta.tokenAddress,
        token_address_lower: bucket.meta.tokenAddress.toLowerCase(),
        token_symbol: bucket.meta.tokenSymbol,
        opened_at: round.openedAt,
        closed_at: round.closedAt,
        last_trade_at: round.lastTradeAt,
        status: round.status,
        confidence: round.confidence,
        buy_count: round.buyCount,
        sell_count: round.sellCount,
        buy_usd: round.buyUsd,
        sell_usd: round.sellUsd,
        cost_basis_sold_usd: round.costBasisSoldUsd,
        realized_pnl_usd: round.realizedPnlUsd,
        realized_multiple: round.realizedMultiple,
        remaining_shares: round.remainingShares,
        remaining_cost_usd: round.remainingCostUsd,
        avg_cost_price_usd: round.avgCostPriceUsd,
        entry_market_cap_usd: round.entryMarketCapUsd,
        closed_by_swap: round.closedBySwap ? 1 : 0,
        exited_by_transfer: round.exitedByTransfer ? 1 : 0,
        max_single_buy_usd: round.maxSingleBuyUsd,
      });
    }
  }

  const computedAt = Date.now();

  // Every window is aggregated and scored independently — followability is a
  // percentile within its own cohort, so mixing windows would be meaningless.
  const perWindow = PNL_WINDOWS.map((window) => {
    const cutoff = window.days == null ? 0 : computedAt - window.days * 86_400_000;
    const userStats = [...roundsByUser.entries()]
      .map(([userId, rounds]) => {
        const inWindow = cutoff === 0 ? rounds : rounds.filter((round) => round.lastTradeAt >= cutoff);
        if (inWindow.length === 0) return null;
        return {
          userId,
          stats: aggregateUserPnl(inWindow, {
            // Unrealized is a point-in-time number, not a windowed one.
            unrealizedPnlUsd: unrealizedByUser.get(userId) ?? null,
            distinctTokens: new Set(
              (tokensByUser.get(userId) ?? [])
                .filter((entry) => entry.lastTradeAt >= cutoff)
                .map((entry) => entry.tokenKey)
            ).size,
          }),
        };
      })
      .filter((entry): entry is { userId: string; stats: ReturnType<typeof aggregateUserPnl> } => entry !== null);

    const followability = new Map(
      computeFollowability(
        userStats.map(({ userId, stats }) => ({
          userId,
          distinctTokens: stats.distinctTokens,
          // Swap-closed rounds are excluded: 满仓换仓 is not short holding.
          avgHoldHours: stats.avgHoldHoursExclSwap ?? stats.avgHoldHours,
          avgEntryMarketCapUsd: stats.avgEntryMarketCapUsd,
          winRate: stats.winRate,
          roundTrips: stats.roundTrips,
        }))
      ).map((result) => [result.userId, result])
    );

    const selectorMap = new Map(
      computeSelectorScore(
        userStats.map(({ userId }) => {
          const allRounds = roundsByUser.get(userId) ?? [];
          const windowed = cutoff === 0 ? allRounds : allRounds.filter((r) => r.lastTradeAt >= cutoff);
          return { userId, rounds: windowed };
        })
      ).map((result) => [result.userId, result])
    );

    return { windowKey: window.key as PnlWindowKey, userStats, followability, selectorMap };
  });

  if (!options.dry) {
    writeResults(pnlRows, perWindow, computedAt);
  }

  return {
    scannedRows,
    parseFailed,
    skippedNoSeries,
    skippedQuoteLeg,
    series: buckets.size,
    roundTrips,
    closedComplete,
    closedPartial,
    openPositions,
    users: perWindow.find((w) => w.windowKey === 'all')?.userStats.length ?? 0,
    unrealizedResolved,
    durationMs: Date.now() - startedAt,
  };
}

interface WindowResult {
  windowKey: PnlWindowKey;
  userStats: Array<{ userId: string; stats: ReturnType<typeof aggregateUserPnl> }>;
  followability: Map<string, ReturnType<typeof computeFollowability>[number]>;
  selectorMap: Map<string, SelectorScoreResult>;
}

function writeResults(
  pnlRows: Array<Record<string, unknown>>,
  perWindow: WindowResult[],
  computedAt: number
) {
  // Both tables are fully derived, so a replace-all keeps them consistent with
  // the events they came from and avoids stale rows for deleted users/wallets.
  //
  // This is the largest single write this repo makes (~20k rows), and it shares
  // the DB with 3 other writer processes — retry the whole transaction on busy
  // rather than letting one contended run drop a cycle of results.
  withSqliteBusyRetry(
    () =>
      withTransaction(() => {
        const db = getDb();
        db.prepare(`DELETE FROM wallet_token_pnl`).run();
        db.prepare(`DELETE FROM user_pnl_stats`).run();

        const insertPnl = db.prepare(
          `INSERT INTO wallet_token_pnl (
             series_key, round_index, user_id, chain,
             wallet_address, wallet_address_lower, token_address, token_address_lower, token_symbol,
             opened_at, closed_at, last_trade_at, status, confidence,
             buy_count, sell_count, buy_usd, sell_usd,
             cost_basis_sold_usd, realized_pnl_usd, realized_multiple,
             remaining_shares, remaining_cost_usd, avg_cost_price_usd, entry_market_cap_usd,
             closed_by_swap, exited_by_transfer, max_single_buy_usd, computed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );

        for (const row of pnlRows) {
          insertPnl.run(
            row.series_key,
            row.round_index,
            row.user_id,
            row.chain,
            row.wallet_address,
            row.wallet_address_lower,
            row.token_address,
            row.token_address_lower,
            row.token_symbol,
            row.opened_at,
            row.closed_at,
            row.last_trade_at,
            row.status,
            row.confidence,
            row.buy_count,
            row.sell_count,
            row.buy_usd,
            row.sell_usd,
            row.cost_basis_sold_usd,
            row.realized_pnl_usd,
            row.realized_multiple,
            row.remaining_shares,
            row.remaining_cost_usd,
            row.avg_cost_price_usd,
            row.entry_market_cap_usd,
            row.closed_by_swap,
            row.exited_by_transfer,
            row.max_single_buy_usd,
            computedAt
          );
        }

        const insertStats = db.prepare(
          `INSERT INTO user_pnl_stats (
             user_id, window_key, realized_pnl_usd, unrealized_pnl_usd, round_trips, wins, losses, win_rate,
             median_multiple, avg_win_usd, avg_loss_usd, profit_factor, median_entry_market_cap_usd,
             open_positions, partial_round_trips, transfer_exit_rounds, median_max_single_buy_usd,
             big_buy_win_rate, big_buy_round_trips, coverage_ratio, first_trade_at, last_trade_at,
             distinct_tokens, total_buys, avg_hold_hours, avg_hold_hours_excl_swap, swap_closed_rounds,
             avg_entry_market_cap_usd, followability_score, followability_parts_json,
             selector_score, selector_hit_rate, selector_round_trips, computed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );

        for (const { windowKey, userStats, followability, selectorMap } of perWindow) {
        for (const { userId, stats } of userStats) {
          const sel = selectorMap.get(userId);
          insertStats.run(
            userId,
            windowKey,
            stats.realizedPnlUsd,
            stats.unrealizedPnlUsd,
            stats.roundTrips,
            stats.wins,
            stats.losses,
            stats.winRate,
            stats.medianMultiple,
            stats.avgWinUsd,
            stats.avgLossUsd,
            stats.profitFactor,
            stats.medianEntryMarketCapUsd,
            stats.openPositions,
            stats.partialRoundTrips,
            stats.transferExitRounds,
            stats.medianMaxSingleBuyUsd,
            stats.bigBuyWinRate,
            stats.bigBuyRoundTrips,
            stats.coverageRatio,
            stats.firstTradeAt,
            stats.lastTradeAt,
            stats.distinctTokens,
            stats.totalBuys,
            stats.avgHoldHours,
            stats.avgHoldHoursExclSwap,
            stats.swapClosedRounds,
            stats.avgEntryMarketCapUsd,
            followability.get(userId)?.score ?? null,
            JSON.stringify(followability.get(userId)?.parts ?? null),
            sel?.selectorScore ?? null,
            sel?.selectorHitRate ?? null,
            sel?.selectorRoundTrips ?? 0,
            computedAt
          );
        }
        }
      }),
    { label: 'walletPnl.writeResults' }
  );
}

export function readUserPnlRanking(windowKey: PnlWindowKey = DEFAULT_PNL_WINDOW): UserPnlRankingRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.*, u.name AS user_name, u.avatar AS user_avatar, u.twitter AS user_twitter
       FROM user_pnl_stats s
       LEFT JOIN tracked_users u ON u.id = s.user_id
       WHERE s.window_key = ?
       ORDER BY s.followability_score DESC NULLS LAST, s.realized_pnl_usd DESC`
    )
    .all(windowKey) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    userId: String(row.user_id),
    windowKey: String(row.window_key) as PnlWindowKey,
    name: (row.user_name as string | null) ?? null,
    avatar: (row.user_avatar as string | null) ?? null,
    twitter: (row.user_twitter as string | null) ?? null,
    realizedPnlUsd: Number(row.realized_pnl_usd) || 0,
    unrealizedPnlUsd: toFiniteNumber(row.unrealized_pnl_usd),
    roundTrips: Number(row.round_trips) || 0,
    wins: Number(row.wins) || 0,
    losses: Number(row.losses) || 0,
    winRate: toFiniteNumber(row.win_rate),
    medianMultiple: toFiniteNumber(row.median_multiple),
    avgWinUsd: toFiniteNumber(row.avg_win_usd),
    avgLossUsd: toFiniteNumber(row.avg_loss_usd),
    profitFactor: toFiniteNumber(row.profit_factor),
    medianEntryMarketCapUsd: toFiniteNumber(row.median_entry_market_cap_usd),
    openPositions: Number(row.open_positions) || 0,
    partialRoundTrips: Number(row.partial_round_trips) || 0,
    transferExitRounds: Number(row.transfer_exit_rounds) || 0,
    medianMaxSingleBuyUsd: toFiniteNumber(row.median_max_single_buy_usd),
    bigBuyWinRate: toFiniteNumber(row.big_buy_win_rate),
    bigBuyRoundTrips: Number(row.big_buy_round_trips) || 0,
    coverageRatio: toFiniteNumber(row.coverage_ratio),
    firstTradeAt: toFiniteNumber(row.first_trade_at),
    lastTradeAt: toFiniteNumber(row.last_trade_at),
    distinctTokens: Number(row.distinct_tokens) || 0,
    totalBuys: Number(row.total_buys) || 0,
    avgHoldHours: toFiniteNumber(row.avg_hold_hours),
    avgHoldHoursExclSwap: toFiniteNumber(row.avg_hold_hours_excl_swap),
    swapClosedRounds: Number(row.swap_closed_rounds) || 0,
    avgEntryMarketCapUsd: toFiniteNumber(row.avg_entry_market_cap_usd),
    followabilityScore: toFiniteNumber(row.followability_score),
    followabilityParts: (() => {
      try {
        return row.followability_parts_json ? JSON.parse(String(row.followability_parts_json)) : null;
      } catch {
        return null;
      }
    })(),
    selectorScore: toFiniteNumber(row.selector_score),
    selectorHitRate: toFiniteNumber(row.selector_hit_rate),
    selectorRoundTrips: Number(row.selector_round_trips) || 0,
    computedAt: Number(row.computed_at) || 0,
  }));
}

export interface UserQualitySnapshot {
  userId: string;
  winRate: number | null;
  roundTrips: number;
  realizedPnlUsd: number;
  medianMultiple: number | null;
}

/**
 * Compact per-person quality for the feed payload — a handful of numbers for
 * ~90 people, small enough to ship with the feed and let the client rank the
 * window it already holds.
 *
 * The feed query itself is index-pinned (see eventsRepo's INDEXED BY comment:
 * a wrong plan there costs >25s), so ranking must NOT become a server ORDER BY.
 */
export function readUserQualitySnapshots(): UserQualitySnapshot[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT user_id, win_rate, round_trips, realized_pnl_usd, median_multiple FROM user_pnl_stats`)
    .all() as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    userId: String(row.user_id),
    windowKey: String(row.window_key) as PnlWindowKey,
    winRate: toFiniteNumber(row.win_rate),
    roundTrips: Number(row.round_trips) || 0,
    realizedPnlUsd: Number(row.realized_pnl_usd) || 0,
    medianMultiple: toFiniteNumber(row.median_multiple),
  }));
}

const CYCLE_INTERVAL_MS = 30 * 60_000;

/** Runtime task entrypoint — background worker only. */
export async function runWalletPnlCycle(): Promise<{
  sleepMs: number;
  status: string;
  detail: Record<string, unknown>;
}> {
  const result = runWalletPnlFill();
  return {
    sleepMs: CYCLE_INTERVAL_MS,
    status: 'ok',
    detail: {
      series: result.series,
      roundTrips: result.roundTrips,
      closedComplete: result.closedComplete,
      closedPartial: result.closedPartial,
      users: result.users,
      durationMs: result.durationMs,
    },
  };
}
