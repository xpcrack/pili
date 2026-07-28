import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import {
  isProvenTrader,
  selectTradeSignals,
  type TradeSignalCandidate,
  type TradeSignalConfig,
  type TraderQuality,
} from '@/lib/tradeSignal';

const BASE_TS = 1_780_000_000_000;

const CONFIG: TradeSignalConfig = {
  minWinRate: 0.45,
  minRoundTrips: 10,
  minFollowability: 0.6,
  minTradeUsd: 500,
  minMarketCapUsd: 200_000,
  maxMarketCapUsd: 1_000_000,
  coHitMinUsers: 2,
  coHitWindowMinutes: 180,
};

function candidate(overrides: Partial<TradeSignalCandidate> = {}): TradeSignalCandidate {
  return {
    eventId: 'evt-1',
    timestamp: BASE_TS,
    userId: 'u1',
    userName: '高手A',
    chain: 'solana',
    tokenAddress: 'TokenAAA',
    tokenSymbol: 'AAA',
    variant: 'open',
    tradeAmountUsd: 1_000,
    marketCapUsd: 500_000,
    ...overrides,
  };
}

function quality(overrides: Partial<TraderQuality> = {}): TraderQuality {
  return { winRate: 0.6, roundTrips: 50, realizedPnlUsd: 10_000, medianMultiple: 1.2, followabilityScore: 0.8, ...overrides };
}

function run(candidates: TradeSignalCandidate[], entries: Array<[string, TraderQuality]> = [['u1', quality()]]) {
  return selectTradeSignals({
    candidates,
    qualityByUserId: new Map(entries),
    config: CONFIG,
  });
}

function testProvenTraderGate() {
  assert.ok(isProvenTrader(quality(), CONFIG));
  assert.ok(!isProvenTrader(undefined, CONFIG), 'a person with no PnL record is never proven');
  assert.ok(!isProvenTrader(quality({ roundTrips: 9 }), CONFIG), 'sample floor must be enforced');
  assert.ok(!isProvenTrader(quality({ winRate: 0.44 }), CONFIG));
  assert.ok(!isProvenTrader(quality({ winRate: null }), CONFIG), 'null win rate is not a passing win rate');
  assert.ok(isProvenTrader(quality({ winRate: 0.45, roundTrips: 10 }), CONFIG), 'thresholds are inclusive');

  // The followability gate is the point: a wallet can win often and still be
  // impossible to copy (2,563 tokens, ~2h average hold).
  assert.ok(!isProvenTrader(quality({ followabilityScore: 0.59 }), CONFIG), 'low 跟单分 blocks a high win rate');
  assert.ok(!isProvenTrader(quality({ followabilityScore: null }), CONFIG), 'unscored people are not proven');
  assert.ok(isProvenTrader(quality({ followabilityScore: 0.6 }), CONFIG), 'the floor is inclusive');
  assert.ok(
    isProvenTrader(quality({ followabilityScore: null }), { ...CONFIG, minFollowability: 0 }),
    'setting the floor to 0 disables the gate'
  );
}

function testSmartEntryFires() {
  const signals = run([candidate()]);
  const smart = signals.filter((signal) => signal.type === 'smart-entry');
  assert.equal(smart.length, 1);
  assert.match(smart[0]!.title, /高手A.*建仓.*AAA/);
  assert.match(smart[0]!.body, /胜率 60%/);
  assert.ok(smart[0]!.body.includes('TokenAAA'), 'the CA must be in the push so it can be pasted');
}

function testUnprovenTraderDoesNotFire() {
  assert.equal(run([candidate()], [['u1', quality({ roundTrips: 3 })]]).length, 0);
  assert.equal(run([candidate()], []).length, 0, 'no PnL record → no push');
}

function testSellsNeverFire() {
  assert.equal(run([candidate({ variant: 'reduce' })]).length, 0);
  assert.equal(run([candidate({ variant: 'close' })]).length, 0);
}

function testTradeSizeFloor() {
  assert.equal(run([candidate({ tradeAmountUsd: 499 })]).length, 0);
  assert.equal(run([candidate({ tradeAmountUsd: 500 })]).length, 1);
  assert.equal(run([candidate({ tradeAmountUsd: null })]).length, 0, 'unknown size cannot clear the floor');
}

function testMarketCapBand() {
  assert.equal(run([candidate({ marketCapUsd: 199_999 })]).length, 0, 'below band');
  assert.equal(run([candidate({ marketCapUsd: 1_000_001 })]).length, 0, 'above band');
  assert.equal(run([candidate({ marketCapUsd: 200_000 })]).length, 1, 'band edges are inclusive');
  assert.equal(
    run([candidate({ marketCapUsd: null })]).length,
    1,
    'unknown MC passes rather than silently dropping the signal'
  );
}

function testCoHitFires() {
  const signals = run(
    [
      candidate({ eventId: 'e1', userId: 'u1', userName: '甲', timestamp: BASE_TS }),
      candidate({ eventId: 'e2', userId: 'u2', userName: '乙', timestamp: BASE_TS + 60_000 }),
    ],
    [
      ['u1', quality()],
      ['u2', quality()],
    ]
  );
  const coHit = signals.filter((signal) => signal.type === 'co-hit');
  assert.equal(coHit.length, 1);
  assert.match(coHit[0]!.title, /2 人同时买入 AAA/);
  assert.match(coHit[0]!.body, /甲、乙/);
  assert.match(coHit[0]!.body, /其中 2 人胜率达标/);
  assert.equal(coHit[0]!.tradeAmountUsd, 2_000, 'co-hit reports combined size');
  assert.equal(signals[0]!.type, 'co-hit', 'co-hit outranks single entries');
}

function testCoHitNeedsDistinctPeople() {
  // Same person buying twice is not confluence.
  const signals = run([
    candidate({ eventId: 'e1', userId: 'u1', timestamp: BASE_TS }),
    candidate({ eventId: 'e2', userId: 'u1', timestamp: BASE_TS + 60_000 }),
  ]);
  assert.equal(signals.filter((signal) => signal.type === 'co-hit').length, 0);
}

function testCoHitRespectsWindow() {
  const outsideWindow = CONFIG.coHitWindowMinutes * 60_000 + 1;
  const signals = run(
    [
      candidate({ eventId: 'e1', userId: 'u1', timestamp: BASE_TS }),
      candidate({ eventId: 'e2', userId: 'u2', timestamp: BASE_TS + outsideWindow }),
    ],
    [
      ['u1', quality()],
      ['u2', quality()],
    ]
  );
  assert.equal(signals.filter((signal) => signal.type === 'co-hit').length, 0);
}

function testCoHitDoesNotRequireProvenTraders() {
  // Confluence is informative even from unmeasured wallets; the body says so.
  const signals = run(
    [
      candidate({ eventId: 'e1', userId: 'u1', userName: '甲', timestamp: BASE_TS }),
      candidate({ eventId: 'e2', userId: 'u2', userName: '乙', timestamp: BASE_TS + 1_000 }),
    ],
    []
  );
  const coHit = signals.filter((signal) => signal.type === 'co-hit');
  assert.equal(coHit.length, 1);
  assert.match(coHit[0]!.body, /暂无胜率达标的人/);
}

function testDedupeKeysAreStable() {
  const first = run([candidate()])[0]!;
  const second = run([candidate()])[0]!;
  assert.equal(first.dedupeKey, second.dedupeKey, 'same input must produce the same key');

  const coHitKeys = [BASE_TS, BASE_TS + 5_000].map(
    (ts) =>
      run(
        [
          candidate({ eventId: 'e1', userId: 'u1', timestamp: BASE_TS }),
          candidate({ eventId: 'e2', userId: 'u2', timestamp: ts }),
        ],
        [
          ['u1', quality()],
          ['u2', quality()],
        ]
      ).find((signal) => signal.type === 'co-hit')!.dedupeKey
  );
  assert.equal(coHitKeys[0], coHitKeys[1], 'co-hit key depends on the buyer set, not timing');

  const withThird = run(
    [
      candidate({ eventId: 'e1', userId: 'u1', timestamp: BASE_TS }),
      candidate({ eventId: 'e2', userId: 'u2', timestamp: BASE_TS + 1_000 }),
      candidate({ eventId: 'e3', userId: 'u3', timestamp: BASE_TS + 2_000 }),
    ],
    [
      ['u1', quality()],
      ['u2', quality()],
      ['u3', quality()],
    ]
  ).find((signal) => signal.type === 'co-hit')!;
  assert.notEqual(withThird.dedupeKey, coHitKeys[0], 'a new buyer must re-fire the alert');
}

function testDifferentTokensDoNotGroup() {
  const signals = run(
    [
      candidate({ eventId: 'e1', userId: 'u1', tokenAddress: 'TokenAAA' }),
      candidate({ eventId: 'e2', userId: 'u2', tokenAddress: 'TokenBBB', tokenSymbol: 'BBB' }),
    ],
    [
      ['u1', quality()],
      ['u2', quality()],
    ]
  );
  assert.equal(signals.filter((signal) => signal.type === 'co-hit').length, 0);
}

async function run_() {
  testProvenTraderGate();
  testSmartEntryFires();
  testUnprovenTraderDoesNotFire();
  testSellsNeverFire();
  testTradeSizeFloor();
  testMarketCapBand();
  testCoHitFires();
  testCoHitNeedsDistinctPeople();
  testCoHitRespectsWindow();
  testCoHitDoesNotRequireProvenTraders();
  testDedupeKeysAreStable();
  testDifferentTokensDoNotGroup();
  console.log('trade-signal: all assertions passed');
}

run_().catch((error) => {
  console.error(error);
  process.exit(1);
});
