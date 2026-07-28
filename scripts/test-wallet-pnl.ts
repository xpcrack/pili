import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import {
  aggregateUserPnl,
  computeSeriesRoundTrips,
  isLegAmountPlausible,
  isQuoteLegToken,
  plausibleMarketCap,
  computeFollowability,
  median,
  type PnlTradeInput,
  type PnlTradeVariant,
} from '@/lib/walletPnl';

let day = 0;
function trade(
  variant: PnlTradeVariant,
  shares: number | null,
  usd: number | null,
  marketCapUsd: number | null = null
): PnlTradeInput {
  day += 1;
  return { timestamp: day * 86_400_000, variant, shares, usd, marketCapUsd };
}

function approx(actual: number | null, expected: number, tolerance = 1e-6) {
  assert.ok(actual !== null, `expected ${expected}, got null`);
  assert.ok(
    Math.abs((actual as number) - expected) <= tolerance,
    `expected ~${expected}, got ${actual}`
  );
}

function testSimpleWinningRoundTrip() {
  // buy 100 shares for $100, sell all for $300 → +$200, 3x
  const rounds = computeSeriesRoundTrips([trade('open', 100, 100), trade('close', 100, 300)]);
  assert.equal(rounds.length, 1);
  const round = rounds[0]!;
  assert.equal(round.status, 'closed');
  assert.equal(round.confidence, 'complete');
  approx(round.realizedPnlUsd, 200);
  approx(round.realizedMultiple, 3);
  assert.equal(round.remainingShares, 0);
}

function testAverageCostAcrossMultipleBuys() {
  // 100 @ $1 then 100 @ $3 → 200 shares, $400 cost, avg $2.
  // Sell 100 for $250 → basis $200 → +$50 realized, 100 shares left at $200 cost.
  const rounds = computeSeriesRoundTrips([
    trade('open', 100, 100),
    trade('add', 100, 300),
    trade('reduce', 100, 250),
  ]);
  assert.equal(rounds.length, 1);
  const round = rounds[0]!;
  assert.equal(round.status, 'open');
  assert.equal(round.confidence, 'complete');
  approx(round.realizedPnlUsd, 50);
  approx(round.costBasisSoldUsd, 200);
  approx(round.remainingShares, 100);
  approx(round.remainingCostUsd, 200);
  approx(round.avgCostPriceUsd, 2);
}

function testLosingRoundTrip() {
  const rounds = computeSeriesRoundTrips([trade('open', 50, 500), trade('close', 50, 120)]);
  approx(rounds[0]!.realizedPnlUsd, -380);
  approx(rounds[0]!.realizedMultiple, 0.24);
}

function testTwoSequentialRoundTrips() {
  const rounds = computeSeriesRoundTrips([
    trade('open', 10, 100),
    trade('close', 10, 150),
    trade('open', 10, 100),
    trade('close', 10, 50),
  ]);
  assert.equal(rounds.length, 2);
  assert.deepEqual(
    rounds.map((r) => r.roundIndex),
    [0, 1]
  );
  approx(rounds[0]!.realizedPnlUsd, 50);
  approx(rounds[1]!.realizedPnlUsd, -50);
  assert.ok(rounds.every((r) => r.confidence === 'complete'));
}

function testTruncatedHistoryIsPartial() {
  // Series starts with 加仓 → a position existed before our window.
  const rounds = computeSeriesRoundTrips([trade('add', 100, 100), trade('close', 100, 900)]);
  assert.equal(rounds.length, 1);
  assert.equal(
    rounds[0]!.confidence,
    'partial',
    'a series whose oldest event is 加仓 must not be trusted for win rate'
  );
}

function testRoundAfterTruncatedRoundIsComplete() {
  // Once the position goes flat, the next round starts from a known zero.
  const rounds = computeSeriesRoundTrips([
    trade('add', 100, 100),
    trade('close', 100, 900),
    trade('open', 10, 100),
    trade('close', 10, 250),
  ]);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0]!.confidence, 'partial');
  assert.equal(rounds[1]!.confidence, 'complete');
  approx(rounds[1]!.realizedPnlUsd, 150);
}

function testSellWithoutInventoryIsPartial() {
  const rounds = computeSeriesRoundTrips([trade('reduce', 100, 500)]);
  assert.equal(rounds[0]!.confidence, 'partial');
  approx(rounds[0]!.realizedPnlUsd, 0);
}

function testNearFullSellCountsAsClose() {
  // 99.6% sold → treated as a close, matching tradeDisplay's 0.995 threshold.
  const rounds = computeSeriesRoundTrips([trade('open', 1000, 1000), trade('reduce', 996, 2000)]);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0]!.status, 'closed');
  assert.equal(rounds[0]!.remainingShares, 0);
}

function testPartialSellBelowThresholdStaysOpen() {
  const rounds = computeSeriesRoundTrips([trade('open', 1000, 1000), trade('reduce', 500, 900)]);
  assert.equal(rounds[0]!.status, 'open');
  approx(rounds[0]!.remainingShares, 500);
}

function testMissingDataDowngradesConfidence() {
  const rounds = computeSeriesRoundTrips([trade('open', null, 100), trade('close', 100, 300)]);
  assert.equal(rounds[0]!.confidence, 'partial', 'a buy with no share count cannot anchor a cost basis');
}

function testOversellIsClampedToInventory() {
  // Selling more shares than we ever saw bought must not create negative inventory.
  const rounds = computeSeriesRoundTrips([trade('open', 100, 100), trade('reduce', 500, 400)]);
  assert.equal(rounds[0]!.status, 'closed');
  assert.equal(rounds[0]!.remainingShares, 0);
  approx(rounds[0]!.realizedPnlUsd, 300);
}

function testEntryMarketCapUsesFirstBuy() {
  const rounds = computeSeriesRoundTrips([
    trade('open', 100, 100, 250_000),
    trade('add', 100, 300, 900_000),
    trade('close', 200, 800, 2_000_000),
  ]);
  approx(rounds[0]!.entryMarketCapUsd, 250_000);
}

function testAggregateWinRateExcludesPartialAndOpen() {
  const rounds = [
    ...computeSeriesRoundTrips([trade('open', 10, 100), trade('close', 10, 300)]), // win
    ...computeSeriesRoundTrips([trade('open', 10, 100), trade('close', 10, 40)]), // loss
    ...computeSeriesRoundTrips([trade('add', 10, 100), trade('close', 10, 900)]), // partial
    ...computeSeriesRoundTrips([trade('open', 10, 100)]), // still open
  ];

  const stats = aggregateUserPnl(rounds);
  assert.equal(stats.roundTrips, 2, 'only closed+complete rounds are scored');
  assert.equal(stats.wins, 1);
  assert.equal(stats.losses, 1);
  approx(stats.winRate, 0.5);
  assert.equal(stats.partialRoundTrips, 1);
  assert.equal(stats.openPositions, 1);
  approx(stats.coverageRatio, 0.5);
  // Realized PnL still includes the partial round: real money moved. The partial
  // round books 900 - 100 = 800 from the legs we did see; it is excluded from
  // win rate only because earlier, unseen buys may have shifted its cost basis.
  approx(stats.realizedPnlUsd, 200 - 60 + 800);
  approx(stats.avgWinUsd, 200);
  approx(stats.avgLossUsd, 60);
  approx(stats.profitFactor, 200 / 60);
}

function testAggregateWithNoScoredRounds() {
  const stats = aggregateUserPnl(computeSeriesRoundTrips([trade('open', 10, 100)]));
  assert.equal(stats.roundTrips, 0);
  assert.equal(stats.winRate, null, 'win rate must be null, not 0, when there is no sample');
  assert.equal(stats.medianMultiple, null);
  assert.equal(stats.profitFactor, null);
}

function testUnrealizedPassesThrough() {
  const stats = aggregateUserPnl(computeSeriesRoundTrips([trade('open', 10, 100)]), {
    unrealizedPnlUsd: 1234.5,
  });
  approx(stats.unrealizedPnlUsd, 1234.5);
}

function testMedian() {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 3]), 2);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
}

function testMarketCapPlausibility() {
  // 8 of 78,298 rows carry corrupt market caps (one was 2.9e36). Unfiltered they
  // win the 入场市值 percentile outright and distort the followability ranking.
  assert.equal(plausibleMarketCap(2.86e36), null);
  assert.equal(plausibleMarketCap(100_000_000_001), null);
  assert.equal(plausibleMarketCap(0), null);
  assert.equal(plausibleMarketCap(-5), null);
  assert.equal(plausibleMarketCap(null), null);
  assert.equal(plausibleMarketCap(500_000), 500_000);
  assert.equal(plausibleMarketCap(100_000_000_000), 100_000_000_000, 'the ceiling itself is allowed');

  const rounds = computeSeriesRoundTrips([trade('open', 100, 100, 2.86e36)]);
  assert.equal(rounds[0]!.entryMarketCapUsd, null, 'a corrupt MC must not become an entry MC');
}

function testFollowabilityRanksConcentratedLongHolders() {
  // The real shape of the data: rop (few tokens, long holds, high MC) must
  // outrank yry (thousands of tokens, ~2h holds) despite similar win rates.
  const results = computeFollowability([
    { userId: 'rop', distinctTokens: 45, avgHoldHours: 379, avgEntryMarketCapUsd: 115_900_000, winRate: 0.57, roundTrips: 14 },
    { userId: 'yry', distinctTokens: 2563, avgHoldHours: 1.9, avgEntryMarketCapUsd: 9_500_000, winRate: 0.32, roundTrips: 2424 },
    { userId: 'mid', distinctTokens: 700, avgHoldHours: 40, avgEntryMarketCapUsd: 13_000_000, winRate: 0.52, roundTrips: 465 },
  ]);
  const byId = new Map(results.map((r) => [r.userId, r]));
  assert.ok(byId.get('rop')!.score! > byId.get('mid')!.score!);
  assert.ok(byId.get('mid')!.score! > byId.get('yry')!.score!);
  assert.equal(byId.get('rop')!.parts.tokenConcentration, 1, 'fewest tokens takes the top percentile');
}

function testFollowabilityNullsThinSamples() {
  const [thin] = computeFollowability(
    [{ userId: 'thin', distinctTokens: 3, avgHoldHours: 999, avgEntryMarketCapUsd: 1e9, winRate: 1, roundTrips: 2 }],
    { minRoundTrips: 10 }
  );
  assert.equal(thin!.score, null, 'a perfect 2-trade record must not top the ranking');
}

function testFollowabilityHandlesMissingDimensions() {
  // A missing hold time must renormalise, not drag the score toward zero.
  const [withHold, withoutHold] = computeFollowability([
    { userId: 'a', distinctTokens: 10, avgHoldHours: 100, avgEntryMarketCapUsd: 1e6, winRate: 0.5, roundTrips: 20 },
    { userId: 'b', distinctTokens: 10, avgHoldHours: null, avgEntryMarketCapUsd: 1e6, winRate: 0.5, roundTrips: 20 },
  ]);
  assert.ok(withHold!.score != null && withoutHold!.score != null);
  assert.equal(withoutHold!.parts.holdDuration, null);
}

function testTransferExitIsExcludedFromWinRate() {
  // Bought 1000 shares, only sold 100, position closed → the rest left the
  // wallet (exchange deposit / wallet move). GMGN only reports buy/sell, so
  // this looked like a total loss and made rop show -$70.9K on Ropirito.
  const rounds = computeSeriesRoundTrips([trade('open', 1000, 90_000), trade('close', 100, 21_000)]);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0]!.exitedByTransfer, true);
  assert.equal(rounds[0]!.sharesBought, 1000);

  const stats = aggregateUserPnl(rounds);
  assert.equal(stats.roundTrips, 0, 'a transfer-exit must not be scored as a loss');
  assert.equal(stats.transferExitRounds, 1);
}

function testNormalSellIsNotATransferExit() {
  const rounds = computeSeriesRoundTrips([trade('open', 1000, 1_000), trade('close', 1000, 3_000)]);
  assert.equal(rounds[0]!.exitedByTransfer, false);
  assert.equal(aggregateUserPnl(rounds).roundTrips, 1);
}

function testMaxSingleBuyIgnoresSwingAccumulation() {
  // 12 small adds totalling $12k must not read as a bigger bet than one $10k buy.
  const swing = computeSeriesRoundTrips([
    ...Array.from({ length: 12 }, () => trade('add', 100, 1_000)),
    trade('close', 1200, 5_000),
  ]);
  assert.equal(swing[0]!.buyUsd, 12_000);
  assert.equal(swing[0]!.maxSingleBuyUsd, 1_000, 'conviction is the biggest single buy, not the total');

  const conviction = computeSeriesRoundTrips([trade('open', 1000, 10_000), trade('close', 1000, 5_000)]);
  assert.equal(conviction[0]!.maxSingleBuyUsd, 10_000);
  assert.ok(conviction[0]!.maxSingleBuyUsd > swing[0]!.maxSingleBuyUsd);
  assert.equal(conviction[0]!.openBuyUsd, 10_000);
}

function testBigBuyWinRateNeedsSample() {
  const thin = aggregateUserPnl(computeSeriesRoundTrips([trade('open', 10, 100), trade('close', 10, 300)]));
  assert.equal(thin.bigBuyWinRate, null, 'fewer than 6 scored rounds cannot support a top-third split');
}

function testEmptySeries() {
  assert.deepEqual(computeSeriesRoundTrips([]), []);
}

function testQuoteLegDetection() {
  // Stablecoins and natives are the other side of a swap, not a position.
  assert.ok(isQuoteLegToken({ symbol: 'USDC' }));
  assert.ok(isQuoteLegToken({ symbol: 'usde' }));
  assert.ok(isQuoteLegToken({ symbol: 'USD1' }));
  assert.ok(isQuoteLegToken({ symbol: 'SOL' }));
  assert.ok(isQuoteLegToken({ symbol: 'WBNB' }));
  // Matched by canonical address even when the symbol is missing or spoofed.
  assert.ok(isQuoteLegToken({ symbol: 'TotallyNotUSDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }));
  assert.ok(isQuoteLegToken({ address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' }));

  // Lookalike memecoins must survive — these are real positions people trade.
  assert.ok(!isQuoteLegToken({ symbol: 'USDUC' }));
  assert.ok(!isQuoteLegToken({ symbol: '$1' }));
  assert.ok(!isQuoteLegToken({ symbol: 'PUMP' }));
  assert.ok(!isQuoteLegToken({ symbol: 'SOLANA' }));
  assert.ok(!isQuoteLegToken({}));
}

function testLegAmountPlausibility() {
  // A trade cannot be worth more than the entire token.
  assert.ok(!isLegAmountPlausible(17_489_027_230, 1_000_000));
  assert.ok(isLegAmountPlausible(500, 1_000_000));
  assert.ok(isLegAmountPlausible(1_000_000, 1_000_000));
  // Unknown market cap must not reject the leg — 0.03% of rows have no MC.
  assert.ok(isLegAmountPlausible(17_489_027_230, null));
  assert.ok(isLegAmountPlausible(null, 1_000_000));
}

function testImplausibleLegDowngradesRound() {
  // A corrupt USD amount must not book a fake multi-billion loss.
  const rounds = computeSeriesRoundTrips([
    { timestamp: 1, variant: 'open', shares: 100, usd: 17_489_027_230, marketCapUsd: 1_000_000 },
    { timestamp: 2, variant: 'close', shares: 100, usd: 393, marketCapUsd: 1_000_000 },
  ]);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0]!.confidence, 'partial');
  assert.ok(
    rounds[0]!.realizedPnlUsd > -1_000_000,
    `corrupt leg must not dominate PnL, got ${rounds[0]!.realizedPnlUsd}`
  );
}

async function run() {
  testSimpleWinningRoundTrip();
  testAverageCostAcrossMultipleBuys();
  testLosingRoundTrip();
  testTwoSequentialRoundTrips();
  testTruncatedHistoryIsPartial();
  testRoundAfterTruncatedRoundIsComplete();
  testSellWithoutInventoryIsPartial();
  testNearFullSellCountsAsClose();
  testPartialSellBelowThresholdStaysOpen();
  testMissingDataDowngradesConfidence();
  testOversellIsClampedToInventory();
  testEntryMarketCapUsesFirstBuy();
  testAggregateWinRateExcludesPartialAndOpen();
  testAggregateWithNoScoredRounds();
  testUnrealizedPassesThrough();
  testMedian();
  testEmptySeries();
  testTransferExitIsExcludedFromWinRate();
  testNormalSellIsNotATransferExit();
  testMaxSingleBuyIgnoresSwingAccumulation();
  testBigBuyWinRateNeedsSample();
  testQuoteLegDetection();
  testMarketCapPlausibility();
  testFollowabilityRanksConcentratedLongHolders();
  testFollowabilityNullsThinSamples();
  testFollowabilityHandlesMissingDimensions();
  testLegAmountPlausibility();
  testImplausibleLegDowngradesRound();
  console.log('wallet-pnl: all assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
