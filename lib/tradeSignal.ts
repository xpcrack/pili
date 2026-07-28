/**
 * Trade signal selection.
 *
 * Pure functions — no DB, no network. The runner lives in
 * `lib/server/tradeSignalService.ts`.
 *
 * Two signal types:
 *  - `smart-entry`: a person whose measured win rate clears the bar opens or
 *    adds to a position, with size and entry market cap inside the configured band.
 *  - `co-hit`: several tracked people buy the same token inside one window.
 *    This restores the confluence rule that `opportunitySelector.ts` had before
 *    it was deleted, but weights it by measured win rate rather than raw count.
 *
 * Everything here is gated on `user_pnl_stats`, so a person with no measured
 * track record never triggers a push — which is the whole point of building PnL
 * before building alerts.
 */

export type TradeSignalType = 'smart-entry' | 'co-hit';

export interface TradeSignalCandidate {
  eventId: string;
  timestamp: number;
  userId: string;
  userName: string | null;
  chain: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  /** 'open' and 'add' are entries; sells never trigger a buy signal. */
  variant: 'open' | 'add' | 'reduce' | 'close';
  tradeAmountUsd: number | null;
  marketCapUsd: number | null;
}

export interface TraderQuality {
  winRate: number | null;
  roundTrips: number;
  realizedPnlUsd: number;
  medianMultiple: number | null;
  /** 可跟单性 percentile (0-1) from user_pnl_stats; null when unscored. */
  followabilityScore?: number | null;
}

export interface TradeSignalConfig {
  minWinRate: number;
  minRoundTrips: number;
  minFollowability: number;
  minTradeUsd: number;
  minMarketCapUsd: number | null;
  maxMarketCapUsd: number | null;
  coHitMinUsers: number;
  coHitWindowMinutes: number;
}

export interface TradeSignal {
  type: TradeSignalType;
  /** Stable across runs so the same signal is never pushed twice. */
  dedupeKey: string;
  timestamp: number;
  chain: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  userIds: string[];
  userNames: string[];
  tradeAmountUsd: number | null;
  marketCapUsd: number | null;
  title: string;
  body: string;
}

function isEntry(variant: TradeSignalCandidate['variant']) {
  return variant === 'open' || variant === 'add';
}

/**
 * A person worth waking the phone for: enough sample, a win rate above the bar,
 * AND a 可跟单性 score above the bar.
 *
 * Win rate alone is the wrong gate — a wallet can win 50% of 2,563 trades while
 * holding for 1.9h on average, which is impossible to copy. The followability
 * floor is what keeps those out.
 */
export function isProvenTrader(quality: TraderQuality | undefined, config: TradeSignalConfig): boolean {
  if (!quality) return false;
  if (quality.roundTrips < config.minRoundTrips) return false;
  if (quality.winRate == null || quality.winRate < config.minWinRate) return false;
  if (config.minFollowability <= 0) return true;
  return quality.followabilityScore != null && quality.followabilityScore >= config.minFollowability;
}

function marketCapInBand(marketCapUsd: number | null, config: TradeSignalConfig): boolean {
  if (marketCapUsd == null || !Number.isFinite(marketCapUsd) || marketCapUsd <= 0) {
    // Unknown market cap cannot be checked against the band. Let it through
    // rather than silently dropping entries whose MC lookup failed.
    return true;
  }
  if (config.minMarketCapUsd != null && marketCapUsd < config.minMarketCapUsd) return false;
  if (config.maxMarketCapUsd != null && marketCapUsd > config.maxMarketCapUsd) return false;
  return true;
}

function formatUsd(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '?';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}K`;
  return `$${abs.toFixed(0)}`;
}

function formatMarketCap(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return '未知';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return `${value.toFixed(0)}`;
}

function tokenLabel(candidate: { tokenSymbol: string | null; tokenAddress: string }) {
  return candidate.tokenSymbol || `${candidate.tokenAddress.slice(0, 6)}…`;
}

/**
 * Select signals from a batch of recent entry candidates.
 *
 * `candidates` should cover at least `coHitWindowMinutes` of history so co-hit
 * grouping sees the whole window.
 */
export function selectTradeSignals(input: {
  candidates: TradeSignalCandidate[];
  qualityByUserId: Map<string, TraderQuality>;
  config: TradeSignalConfig;
}): TradeSignal[] {
  const { candidates, qualityByUserId, config } = input;
  const entries = candidates.filter((candidate) => isEntry(candidate.variant));
  const signals: TradeSignal[] = [];

  // --- smart-entry ---
  for (const entry of entries) {
    const quality = qualityByUserId.get(entry.userId);
    if (!isProvenTrader(quality, config)) continue;
    if ((entry.tradeAmountUsd ?? 0) < config.minTradeUsd) continue;
    if (!marketCapInBand(entry.marketCapUsd, config)) continue;

    const winRateText = quality?.winRate != null ? `${(quality.winRate * 100).toFixed(0)}%` : '—';
    const action = entry.variant === 'open' ? '建仓' : '加仓';
    signals.push({
      type: 'smart-entry',
      // Keyed on the event, so re-running over the same window is idempotent.
      dedupeKey: `smart-entry:${entry.eventId}`,
      timestamp: entry.timestamp,
      chain: entry.chain,
      tokenAddress: entry.tokenAddress,
      tokenSymbol: entry.tokenSymbol,
      userIds: [entry.userId],
      userNames: [entry.userName || entry.userId],
      tradeAmountUsd: entry.tradeAmountUsd,
      marketCapUsd: entry.marketCapUsd,
      title: `${entry.userName || '高手'} ${action} ${tokenLabel(entry)}`,
      body: [
        `${formatUsd(entry.tradeAmountUsd)} · MC ${formatMarketCap(entry.marketCapUsd)}`,
        `胜率 ${winRateText}（${quality?.roundTrips ?? 0} 次）`,
        entry.tokenAddress,
      ].join('\n'),
    });
  }

  // --- co-hit ---
  const windowMs = config.coHitWindowMinutes * 60_000;
  const byToken = new Map<string, TradeSignalCandidate[]>();
  for (const entry of entries) {
    const key = `${entry.chain}|${entry.tokenAddress.toLowerCase()}`;
    const list = byToken.get(key) || [];
    list.push(entry);
    byToken.set(key, list);
  }

  for (const [key, group] of byToken) {
    group.sort((a, b) => a.timestamp - b.timestamp);
    const latest = group[group.length - 1]!;
    const inWindow = group.filter((entry) => latest.timestamp - entry.timestamp <= windowMs);

    const distinctUsers = new Map<string, TradeSignalCandidate>();
    for (const entry of inWindow) {
      if (!distinctUsers.has(entry.userId)) distinctUsers.set(entry.userId, entry);
    }
    if (distinctUsers.size < config.coHitMinUsers) continue;

    const buyers = [...distinctUsers.values()];
    const totalUsd = buyers.reduce((sum, entry) => sum + (entry.tradeAmountUsd ?? 0), 0);
    const provenCount = buyers.filter((entry) => isProvenTrader(qualityByUserId.get(entry.userId), config)).length;

    signals.push({
      type: 'co-hit',
      // Keyed on the buyer set, so the alert re-fires only when someone new joins.
      dedupeKey: `co-hit:${key}:${buyers
        .map((entry) => entry.userId)
        .sort()
        .join(',')}`,
      timestamp: latest.timestamp,
      chain: latest.chain,
      tokenAddress: latest.tokenAddress,
      tokenSymbol: latest.tokenSymbol,
      userIds: buyers.map((entry) => entry.userId),
      userNames: buyers.map((entry) => entry.userName || entry.userId),
      tradeAmountUsd: totalUsd,
      marketCapUsd: latest.marketCapUsd,
      title: `${distinctUsers.size} 人同时买入 ${tokenLabel(latest)}`,
      body: [
        buyers.map((entry) => entry.userName || entry.userId).join('、'),
        `合计 ${formatUsd(totalUsd)} · MC ${formatMarketCap(latest.marketCapUsd)}`,
        provenCount > 0 ? `其中 ${provenCount} 人胜率达标` : '暂无胜率达标的人',
        latest.tokenAddress,
      ].join('\n'),
    });
  }

  // Co-hit outranks a single smart entry; newest first within a type.
  return signals.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'co-hit' ? -1 : 1;
    return b.timestamp - a.timestamp;
  });
}
