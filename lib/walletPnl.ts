/**
 * Realized PnL / win-rate core.
 *
 * Pure functions only — no DB, no `server-only`. The DB-bound runner lives in
 * `lib/server/walletPnlService.ts`.
 *
 * Method: weighted average cost. Every buy adds shares and cost; every sell
 * realizes `sellUsd - avgCost * soldShares`. Average cost (rather than FIFO)
 * matches how a trader reads their own position and degrades more gracefully
 * when early history is missing.
 *
 * The unit of win rate is a ROUND TRIP: a segment of one chain|wallet|token
 * series that runs from zero shares back to zero shares. A person who is still
 * holding has an open round trip, which counts toward unrealized PnL but never
 * toward win rate.
 *
 * Confidence is a first-class output. pili's history is truncated — the oldest
 * event we hold for a wallet is frequently a 加仓/减仓, which proves an earlier
 * position we never saw. Cost basis for such a round is unknowable, so it is
 * marked `partial` and excluded from win-rate statistics by default. Reporting a
 * confident-looking number off truncated history would be worse than reporting
 * nothing.
 */

export type PnlTradeVariant = 'open' | 'add' | 'reduce' | 'close';

/**
 * Tokens that are the QUOTE side of a swap, not a position.
 *
 * GMGN reports both legs of a swap, so "sold 4.4M USDC" lands in the feed as if
 * it were a position exit. Treating those as trades produced a leaderboard whose
 * entire top four were stablecoin artifacts (one USD1 row alone booked
 * -$17.5B from a corrupt source amount). Symbols are matched exactly, so
 * lookalike memecoins (USDUC, $1) stay in.
 */
const QUOTE_LEG_SYMBOLS = new Set(
  [
    // stablecoins
    'usdt', 'usdc', 'dai', 'usde', 'usd1', 'fdusd', 'busd', 'tusd', 'usds',
    'pyusd', 'usdd', 'usdbc', 'susde', 'lusd', 'frax', 'usdf',
    // natives and their wrapped forms
    'sol', 'wsol', 'eth', 'weth', 'bnb', 'wbnb', 'btc', 'wbtc', 'cbbtc',
  ].map((symbol) => symbol.toLowerCase())
);

/** Canonical quote-token addresses, so a spoofed symbol cannot sneak a leg in. */
const QUOTE_LEG_ADDRESSES = new Set(
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
  ].map((address) => address.toLowerCase())
);

/** True when this token is a swap quote leg rather than a tradeable position. */
export function isQuoteLegToken(input: { symbol?: string | null; address?: string | null }): boolean {
  const symbol = (input.symbol || '').trim().toLowerCase();
  if (symbol && QUOTE_LEG_SYMBOLS.has(symbol)) return true;
  const address = (input.address || '').trim().toLowerCase();
  return address.length > 0 && QUOTE_LEG_ADDRESSES.has(address);
}

/**
 * A single trade leg cannot be worth more than the whole token was.
 *
 * 88 of 78,096 priced legs (0.11%) violate this — corrupt `tradeAmountUsdAtTx`
 * values, one of which was $17.5B. Rejecting the leg (rather than capping it)
 * keeps a single bad source row from dominating a person's totals.
 */
/**
 * Reject absurd market caps before they reach any average.
 *
 * Same $100B ceiling `extractMarketCapUsd` uses in gmgnWalletActivity.ts, for
 * the same reason (price×supply unit errors). Only 8 of 78,298 rows trip it,
 * but one row of 2.9e36 was enough to hand two traders a top 入场市值 percentile
 * and push them up the followability ranking.
 */
const MAX_PLAUSIBLE_MARKET_CAP_USD = 100_000_000_000;

export function plausibleMarketCap(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value <= 0 || value > MAX_PLAUSIBLE_MARKET_CAP_USD) return null;
  return value;
}

export function isLegAmountPlausible(usd: number | null, marketCapUsd: number | null): boolean {
  if (usd == null || !Number.isFinite(usd)) return true;
  const marketCap = plausibleMarketCap(marketCapUsd);
  // No usable market cap means no cross-check — accept rather than guess.
  if (marketCap == null) return true;
  return usd <= marketCap;
}

export interface PnlTradeInput {
  timestamp: number;
  variant: PnlTradeVariant;
  /** Token amount (shares). */
  shares: number | null;
  /** USD value of this leg at transaction time. */
  usd: number | null;
  marketCapUsd: number | null;
  /**
   * True when this sell is one leg of a same-tx swap into another token.
   * 满仓换仓 traders (rop) end positions this way constantly; counting those as
   * deliberate exits makes their hold time read far shorter than it is.
   */
  swapOut?: boolean;
}

export interface PnlSeriesMeta {
  seriesKey: string;
  userId: string | null;
  chain: string;
  wallet: string;
  tokenAddress: string;
  tokenSymbol: string | null;
}

export type PnlRoundStatus = 'open' | 'closed';
export type PnlConfidence = 'complete' | 'partial';

export interface PnlRoundTrip {
  roundIndex: number;
  openedAt: number;
  closedAt: number | null;
  lastTradeAt: number;
  status: PnlRoundStatus;
  confidence: PnlConfidence;
  buyCount: number;
  sellCount: number;
  buyUsd: number;
  sellUsd: number;
  costBasisSoldUsd: number;
  realizedPnlUsd: number;
  realizedMultiple: number | null;
  remainingShares: number;
  remainingCostUsd: number;
  avgCostPriceUsd: number | null;
  entryMarketCapUsd: number | null;
  /** The closing sell was a swap into another token, not a deliberate exit. */
  closedBySwap: boolean;
  /** Hold duration of a closed round; null while still open. */
  holdMs: number | null;
  /** Shares bought and shares sold, for detecting tokens moved out rather than sold. */
  sharesBought: number;
  sharesSold: number;
  /**
   * The position ended with most of the tokens never sold — they were sent to
   * an exchange or another wallet. GMGN activity only reports buy/sell, so a
   * transfer out looks like a total loss. Such rounds are excluded from win
   * rate: we know what was paid but not what it was ultimately sold for.
   */
  exitedByTransfer: boolean;
  /** Size of the biggest single buy — the conviction signal, unpolluted by 波段. */
  maxSingleBuyUsd: number;
  /** USD of the first buy that opened this round. */
  openBuyUsd: number | null;
}

const SHARE_EPSILON = 1e-12;
/**
 * Below this sold/bought share ratio, a closed position was emptied by a
 * transfer (exchange deposit, wallet move) rather than a sale.
 */
const TRANSFER_EXIT_SOLD_FRACTION = 0.5;
/** Selling ≥99.5% of the position counts as a close (matches tradeDisplay.ts). */
const FULL_CLOSE_FRACTION = 0.995;

function isBuyVariant(variant: PnlTradeVariant) {
  return variant === 'open' || variant === 'add';
}

function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

interface MutableRound extends PnlRoundTrip {}

function newRound(roundIndex: number, trade: PnlTradeInput, confidence: PnlConfidence): MutableRound {
  return {
    roundIndex,
    openedAt: trade.timestamp,
    closedAt: null,
    lastTradeAt: trade.timestamp,
    status: 'open',
    confidence,
    buyCount: 0,
    sellCount: 0,
    buyUsd: 0,
    sellUsd: 0,
    costBasisSoldUsd: 0,
    realizedPnlUsd: 0,
    realizedMultiple: null,
    remainingShares: 0,
    remainingCostUsd: 0,
    avgCostPriceUsd: null,
    entryMarketCapUsd: plausibleMarketCap(trade.marketCapUsd),
    closedBySwap: false,
    holdMs: null,
    sharesBought: 0,
    sharesSold: 0,
    exitedByTransfer: false,
    maxSingleBuyUsd: 0,
    openBuyUsd: null,
  };
}

/**
 * Walk one series (single chain|wallet|token), oldest → newest, into round trips.
 * `trades` must already be sorted ascending by timestamp.
 */
export function computeSeriesRoundTrips(trades: PnlTradeInput[]): PnlRoundTrip[] {
  if (trades.length === 0) return [];

  // An oldest-event of 加仓/减仓/清仓 means a position existed before our window.
  const truncated = !isFirstEventAPositionStart(trades[0]!);

  const out: PnlRoundTrip[] = [];
  let shares = 0;
  let cost = 0;
  let roundIndex = -1;
  let round: MutableRound | null = null;

  const finishRound = (closedAt: number | null, bySwap = false) => {
    if (!round) return;
    round.status = closedAt == null ? 'open' : 'closed';
    round.closedAt = closedAt;
    round.closedBySwap = closedAt == null ? false : bySwap;
    round.holdMs = closedAt == null ? null : closedAt - round.openedAt;
    round.remainingShares = closedAt == null ? shares : 0;
    round.remainingCostUsd = closedAt == null ? cost : 0;
    round.avgCostPriceUsd = round.remainingShares > SHARE_EPSILON ? round.remainingCostUsd / round.remainingShares : null;
    round.realizedMultiple = round.costBasisSoldUsd > 0 ? round.sellUsd / round.costBasisSoldUsd : null;
    // Closed with most tokens never sold → they left the wallet. Booking that as
    // a loss is what made rop look like he lost $70.9K on Ropirito.
    if (
      closedAt != null &&
      round.sharesBought > 0 &&
      round.sharesSold / round.sharesBought < TRANSFER_EXIT_SOLD_FRACTION
    ) {
      round.exitedByTransfer = true;
    }
    out.push(round);
    round = null;
  };

  for (const trade of trades) {
    if (!round) {
      roundIndex += 1;
      // Only the first round of a truncated series inherits the truncation;
      // once the position goes flat, later rounds start from a known zero.
      round = newRound(roundIndex, trade, roundIndex === 0 && truncated ? 'partial' : 'complete');
    }
    round.lastTradeAt = trade.timestamp;

    const legShares = positive(trade.shares);
    const plausibleUsd = isLegAmountPlausible(trade.usd, trade.marketCapUsd);
    if (!plausibleUsd) {
      round.confidence = 'partial';
    }
    const legUsd = plausibleUsd ? positive(trade.usd) : null;

    if (isBuyVariant(trade.variant)) {
      round.buyCount += 1;
      if (legShares == null || legUsd == null) {
        round.confidence = 'partial';
        continue;
      }
      shares += legShares;
      cost += legUsd;
      round.buyUsd += legUsd;
      round.sharesBought += legShares;
      if (legUsd > round.maxSingleBuyUsd) round.maxSingleBuyUsd = legUsd;
      if (round.openBuyUsd == null) round.openBuyUsd = legUsd;
      if (round.entryMarketCapUsd == null) {
        round.entryMarketCapUsd = plausibleMarketCap(trade.marketCapUsd);
      }
      continue;
    }

    // sell / reduce / close
    round.sellCount += 1;
    if (legUsd != null) {
      round.sellUsd += legUsd;
    }

    if (shares <= SHARE_EPSILON) {
      // Selling with no inventory we ever saw — cost basis is unknowable.
      round.confidence = 'partial';
      if (trade.variant === 'close') {
        finishRound(trade.timestamp, trade.swapOut === true);
      }
      continue;
    }

    const avgCost = cost / shares;
    let sold: number;
    if (legShares != null) {
      sold = Math.min(legShares, shares);
    } else if (trade.variant === 'close') {
      sold = shares;
    } else {
      // A reduce of unknown size: we cannot attribute cost to it.
      round.confidence = 'partial';
      continue;
    }

    const fullClose = trade.variant === 'close' || sold / shares >= FULL_CLOSE_FRACTION;
    const basis = avgCost * sold;

    if (legUsd == null) {
      // Proceeds unknown: advance inventory but do not book a fake loss.
      round.confidence = 'partial';
    } else {
      round.costBasisSoldUsd += basis;
      round.realizedPnlUsd += legUsd - basis;
    }

    shares -= sold;
    cost -= basis;
    round.sharesSold += sold;

    if (fullClose || shares <= SHARE_EPSILON) {
      shares = 0;
      cost = 0;
      finishRound(trade.timestamp, trade.swapOut === true);
    }
  }

  finishRound(null);
  return out;
}

function isFirstEventAPositionStart(trade: PnlTradeInput) {
  return trade.variant === 'open';
}

/**
 * 可跟单性评分 — "is this person worth copying", not "did they make money".
 *
 * Dimensions and their directions come from the user's own criteria
 * (LLMwiki/Hermes/topics/meme信息源管理.md「如何评价一个链上个体」):
 *   - 出手币数：越多含金量越低  → fewer distinct tokens scores higher
 *   - 平均持仓时间：越短越差      → longer holding scores higher
 *   - 平均买入市值：越低越差      → higher entry MC scores higher
 *   - plus win rate, as the result check the wiki criteria alone cannot provide
 *
 * Scored by PERCENTILE within the cohort rather than absolute thresholds: the
 * ranges differ by orders of magnitude (44 vs 2563 tokens, 1.9h vs 334h) and any
 * fixed normalisation would need re-tuning as the roster changes. Percentiles
 * also make the number explainable — "出手币数在 49 人里排第 2 少".
 *
 * 出手次数 is deliberately NOT a scored dimension: large buys get split into
 * many small orders to limit slippage (rop bought FWA in 14 orders over 20
 * minutes), so raw buy count measures execution style, not trading frequency.
 * 出手币数 is immune to that and carries the same signal.
 */
export const FOLLOWABILITY_WEIGHTS = {
  tokenConcentration: 0.3,
  holdDuration: 0.25,
  winRate: 0.25,
  entryMarketCap: 0.2,
} as const;

export interface FollowabilityInput {
  userId: string;
  distinctTokens: number;
  avgHoldHours: number | null;
  avgEntryMarketCapUsd: number | null;
  winRate: number | null;
  roundTrips: number;
}

export interface FollowabilityParts {
  tokenConcentration: number | null;
  holdDuration: number | null;
  winRate: number | null;
  entryMarketCap: number | null;
}

export interface FollowabilityResult {
  userId: string;
  score: number | null;
  parts: FollowabilityParts;
}

/**
 * Percentile of `value` within `sorted` (ascending), as 0–1.
 * Returns null for a missing value so it can be excluded rather than treated as 0.
 */
function percentileOf(value: number | null, sorted: number[]): number | null {
  if (value == null || !Number.isFinite(value) || sorted.length === 0) return null;
  if (sorted.length === 1) return 0.5;
  let below = 0;
  for (const entry of sorted) {
    if (entry < value) below += 1;
  }
  return below / (sorted.length - 1);
}

/**
 * Score a whole cohort together. `minRoundTrips` rows with too little sample get
 * a null score so the UI can grey them out instead of ranking noise.
 */
export function computeFollowability(
  inputs: FollowabilityInput[],
  options: { minRoundTrips?: number } = {}
): FollowabilityResult[] {
  const minRoundTrips = options.minRoundTrips ?? 10;
  const eligible = inputs.filter((input) => input.roundTrips >= minRoundTrips);

  const collect = (pick: (input: FollowabilityInput) => number | null) =>
    eligible
      .map(pick)
      .filter((value): value is number => value != null && Number.isFinite(value))
      .sort((a, b) => a - b);

  // Negated so that FEWER tokens lands at a HIGHER percentile.
  const tokensSorted = collect((input) => -input.distinctTokens);
  const holdSorted = collect((input) => input.avgHoldHours);
  const winSorted = collect((input) => input.winRate);
  const mcSorted = collect((input) => input.avgEntryMarketCapUsd);

  return inputs.map((input) => {
    if (input.roundTrips < minRoundTrips) {
      return {
        userId: input.userId,
        score: null,
        parts: { tokenConcentration: null, holdDuration: null, winRate: null, entryMarketCap: null },
      };
    }

    const parts: FollowabilityParts = {
      tokenConcentration: percentileOf(-input.distinctTokens, tokensSorted),
      holdDuration: percentileOf(input.avgHoldHours, holdSorted),
      winRate: percentileOf(input.winRate, winSorted),
      entryMarketCap: percentileOf(input.avgEntryMarketCapUsd, mcSorted),
    };

    // Renormalise over whichever dimensions we actually have, so a missing
    // hold time does not silently drag the score toward zero.
    let weighted = 0;
    let weightUsed = 0;
    for (const key of Object.keys(FOLLOWABILITY_WEIGHTS) as Array<keyof FollowabilityParts>) {
      const part = parts[key];
      if (part == null) continue;
      weighted += part * FOLLOWABILITY_WEIGHTS[key];
      weightUsed += FOLLOWABILITY_WEIGHTS[key];
    }

    return {
      userId: input.userId,
      score: weightUsed > 0 ? weighted / weightUsed : null,
      parts,
    };
  });
}

/**
 * 二段抄底标的筛选人评分 — "does this person pick good coins in the 二段 range?"
 *
 * Unlike followability (which asks "is this person worth copying the whole trade"),
 * selector score answers: "if this person identifies a coin worth watching in the
 * 200k–1M market-cap range, does the coin usually run?"
 *
 * Two outputs:
 *   - selectorScore:     median realizedMultiple of their 二段 closed+complete rounds
 *   - selectorHitRate:   二段 rounds / total eligible rounds (context, not a gate)
 *
 * A hard MC gate is deliberately NOT used — the user's own example (ROP's believe
 * entry at a high MC but still high multiple) shows that good pickers don't always
 * enter in range. Hit rate shows the fit; score shows the quality.
 */
export interface SelectorScoreInput {
  userId: string;
  rounds: PnlRoundTrip[];
}

export interface SelectorScoreResult {
  userId: string;
  /** Median realizedMultiple for 二段 entries; null if < 3 qualifying rounds. */
  selectorScore: number | null;
  /** Fraction of eligible rounds that entered in the 二段 range. */
  selectorHitRate: number | null;
  /** Count of qualifying 二段 rounds. */
  selectorRoundTrips: number;
}

const SELECTOR_MIN_ROUNDS = 3;
const SELECTOR_MC_FLOOR = 200_000;
const SELECTOR_MC_CEIL = 1_000_000;

export function computeSelectorScore(inputs: SelectorScoreInput[]): SelectorScoreResult[] {
  return inputs.map(({ userId, rounds }) => {
    // Same filter as aggregateUserPnl's "scored" — closed, complete, non-transfer.
    const eligible = rounds.filter(
      (r) => r.status === 'closed' && r.confidence === 'complete' && !r.exitedByTransfer
    );
    const inRange = eligible.filter(
      (r) =>
        typeof r.entryMarketCapUsd === 'number' &&
        r.entryMarketCapUsd >= SELECTOR_MC_FLOOR &&
        r.entryMarketCapUsd <= SELECTOR_MC_CEIL
    );
    const multiples = inRange
      .map((r) => r.realizedMultiple)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

    return {
      userId,
      selectorScore: multiples.length >= SELECTOR_MIN_ROUNDS ? median(multiples) : null,
      selectorHitRate: eligible.length > 0 ? inRange.length / eligible.length : null,
      selectorRoundTrips: inRange.length,
    };
  });
}

/**
 * One leaderboard row. Lives here rather than in walletPnlService so the client
 * page can import the type without pulling a `server-only` module into the bundle.
 */
/**
 * Ranking time windows. A person's style changes — rop traded 504 tokens over
 * 2.5 years but only 24 in the last 90 days — so an all-time aggregate answers
 * "who were they" when the question is "who are they now".
 */
export const PNL_WINDOWS = [
  { key: '90d', label: '近 90 天', days: 90 },
  { key: '365d', label: '近一年', days: 365 },
  { key: 'all', label: '全部历史', days: null },
] as const;

export type PnlWindowKey = (typeof PNL_WINDOWS)[number]['key'];
export const DEFAULT_PNL_WINDOW: PnlWindowKey = 'all';

export function isPnlWindowKey(value: unknown): value is PnlWindowKey {
  return typeof value === 'string' && PNL_WINDOWS.some((w) => w.key === value);
}

export interface UserPnlRankingRow {
  userId: string;
  windowKey: PnlWindowKey;
  name: string | null;
  avatar: string | null;
  twitter: string | null;
  selectorScore: number | null;
  selectorHitRate: number | null;
  selectorRoundTrips: number;

  realizedPnlUsd: number;
  unrealizedPnlUsd: number | null;
  roundTrips: number;
  wins: number;
  losses: number;
  winRate: number | null;
  medianMultiple: number | null;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  profitFactor: number | null;
  medianEntryMarketCapUsd: number | null;
  openPositions: number;
  partialRoundTrips: number;
  transferExitRounds: number;
  medianMaxSingleBuyUsd: number | null;
  bigBuyWinRate: number | null;
  bigBuyRoundTrips: number;
  coverageRatio: number | null;
  firstTradeAt: number | null;
  lastTradeAt: number | null;
  distinctTokens: number;
  totalBuys: number;
  avgHoldHours: number | null;
  avgHoldHoursExclSwap: number | null;
  swapClosedRounds: number;
  avgEntryMarketCapUsd: number | null;
  followabilityScore: number | null;
  followabilityParts: FollowabilityParts | null;
  computedAt: number;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface UserPnlStats {
  realizedPnlUsd: number;
  unrealizedPnlUsd: number | null;
  roundTrips: number;
  wins: number;
  losses: number;
  winRate: number | null;
  medianMultiple: number | null;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  profitFactor: number | null;
  medianEntryMarketCapUsd: number | null;
  openPositions: number;
  partialRoundTrips: number;
  transferExitRounds: number;
  coverageRatio: number | null;
  firstTradeAt: number | null;
  lastTradeAt: number | null;
  distinctTokens: number;
  totalBuys: number;
  avgHoldHours: number | null;
  avgHoldHoursExclSwap: number | null;
  swapClosedRounds: number;
  avgEntryMarketCapUsd: number | null;
  /**
   * Median of each round's biggest single buy. Total buy_usd cannot be used —
   * 波段 rounds accumulate a huge total from many small adds, and for rop that
   * bucket had the largest average buy but the LOWEST win rate and net losses.
   */
  medianMaxSingleBuyUsd: number | null;
  /** Win rate on rounds whose largest single buy was in this person's own top third. */
  bigBuyWinRate: number | null;
  bigBuyRoundTrips: number;
}

/**
 * Roll a person's round trips into headline stats.
 *
 * Only `closed` + `complete` rounds feed win rate, median multiple and profit
 * factor. `partial` rounds are counted separately so the UI can show how much
 * of the person's history we actually trust.
 */
export function aggregateUserPnl(
  rounds: PnlRoundTrip[],
  options: {
    unrealizedPnlUsd?: number | null;
    /** Distinct chain|token this person has traded — the wiki's 出手币数. */
    distinctTokens?: number;
  } = {}
): UserPnlStats {
  // Transfer-exits are excluded alongside partial history: in both cases we
  // know what was paid but not what it was finally worth.
  const scored = rounds.filter(
    (r) => r.status === 'closed' && r.confidence === 'complete' && !r.exitedByTransfer
  );
  const closed = rounds.filter((r) => r.status === 'closed' && r.holdMs != null);
  const partial = rounds.filter((r) => r.confidence === 'partial');
  const open = rounds.filter((r) => r.status === 'open');

  const wins = scored.filter((r) => r.realizedPnlUsd > 0);
  const losses = scored.filter((r) => r.realizedPnlUsd < 0);
  const grossWin = wins.reduce((sum, r) => sum + r.realizedPnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((sum, r) => sum + r.realizedPnlUsd, 0));

  const timestamps = rounds.flatMap((r) => [r.openedAt, r.lastTradeAt]);

  // "Does this person do better when they bet big?" — measured against their
  // OWN distribution, so it works for a $500 trader and a $500k trader alike.
  const bigBuy = (() => {
    const sizes = scored.map((r) => r.maxSingleBuyUsd).filter((v) => v > 0).sort((a, b) => a - b);
    if (sizes.length < 6) return { bigBuyWinRate: null, bigBuyRoundTrips: 0 };
    const cutoff = sizes[Math.floor(sizes.length * (2 / 3))]!;
    const big = scored.filter((r) => r.maxSingleBuyUsd >= cutoff);
    return {
      bigBuyWinRate: big.length > 0 ? big.filter((r) => r.realizedPnlUsd > 0).length / big.length : null,
      bigBuyRoundTrips: big.length,
    };
  })();

  return {
    // Realized PnL reports every closed round, including partial ones, because
    // a truncated round still moved real money; only the RATE stats need a
    // trustworthy cost basis.
    realizedPnlUsd: rounds.reduce((sum, r) => sum + r.realizedPnlUsd, 0),
    unrealizedPnlUsd: options.unrealizedPnlUsd ?? null,
    roundTrips: scored.length,
    wins: wins.length,
    losses: losses.length,
    winRate: scored.length > 0 ? wins.length / scored.length : null,
    medianMultiple: median(
      scored.map((r) => r.realizedMultiple).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    ),
    avgWinUsd: wins.length > 0 ? grossWin / wins.length : null,
    avgLossUsd: losses.length > 0 ? grossLoss / losses.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    medianEntryMarketCapUsd: median(
      scored.map((r) => r.entryMarketCapUsd).filter((v): v is number => typeof v === 'number' && v > 0)
    ),
    openPositions: open.length,
    partialRoundTrips: partial.length,
    transferExitRounds: rounds.filter((r) => r.exitedByTransfer).length,
    coverageRatio: rounds.length > 0 ? scored.length / rounds.length : null,
    firstTradeAt: timestamps.length > 0 ? Math.min(...timestamps) : null,
    lastTradeAt: timestamps.length > 0 ? Math.max(...timestamps) : null,
    distinctTokens: options.distinctTokens ?? 0,
    totalBuys: rounds.reduce((sum, r) => sum + r.buyCount, 0),
    avgHoldHours: mean(closed.map((r) => (r.holdMs ?? 0) / 3_600_000)),
    // The number to trust for a 满仓换仓 trader: swap-closed rounds ended
    // because the money moved elsewhere, not because they wanted out.
    avgHoldHoursExclSwap: mean(
      closed.filter((r) => !r.closedBySwap).map((r) => (r.holdMs ?? 0) / 3_600_000)
    ),
    swapClosedRounds: closed.filter((r) => r.closedBySwap).length,
    // Simple mean over rounds (not amount-weighted), per the wiki's 回填口径.
    avgEntryMarketCapUsd: mean(
      rounds.map((r) => r.entryMarketCapUsd).filter((v): v is number => typeof v === 'number' && v > 0)
    ),
    medianMaxSingleBuyUsd: median(scored.map((r) => r.maxSingleBuyUsd).filter((v) => v > 0)),
    ...bigBuy,
  };
}
