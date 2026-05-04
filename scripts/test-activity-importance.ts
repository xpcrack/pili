import assert from 'node:assert/strict';

import {
  DEFAULT_ACTIVITY_IMPORTANCE_FORMULA,
  buildActivityImportanceExplanationRows,
  computeActivityImportance,
  getActivityImportanceLevelLabel,
  recomputeActivityImportanceFromFactors,
} from '@/lib/activityImportance';

function approx(actual: number, expected: number, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} ~= ${expected}`);
}

function run() {
  const freshWhale = computeActivityImportance({
    sourceKind: 'social',
    sourceCount7d: 0,
    socialCount7d: 0,
    walletCount7d: 0,
    totalCount7d: 0,
    historicalMaxAssetUsd: 1_000_000,
  });
  assert.equal(freshWhale.score, 96);
  assert.equal(freshWhale.version, 2);
  assert.equal(freshWhale.formulaVersion, DEFAULT_ACTIVITY_IMPORTANCE_FORMULA.version);
  approx(freshWhale.sourceRarity, 1);
  assert.equal(freshWhale.factors?.socialCount7d, 0);
  assert.equal(freshWhale.factors?.tradeAmountUsdAtTx, null);
  assert.equal(freshWhale.factors?.contentLength, 0);
  assert.equal(getActivityImportanceLevelLabel(freshWhale.score), '高重要');

  const missingAsset = computeActivityImportance({
    sourceKind: 'wallet',
    sourceCount7d: 0,
    socialCount7d: 0,
    walletCount7d: 0,
    totalCount7d: 0,
    historicalMaxAssetUsd: null,
  });
  assert.equal(missingAsset.score, 56);
  approx(missingAsset.assetWeight, 0.35);
  approx(missingAsset.dataConfidenceFactor, 0.7);

  const nonFiniteAsset = computeActivityImportance({
    sourceKind: 'wallet',
    sourceCount7d: 0,
    socialCount7d: 0,
    walletCount7d: 0,
    totalCount7d: 0,
    historicalMaxAssetUsd: Number.POSITIVE_INFINITY,
  });
  assert.equal(nonFiniteAsset.historicalMaxAssetUsd, null);
  approx(nonFiniteAsset.assetWeight, 0.35);
  approx(nonFiniteAsset.dataConfidenceFactor, 0.7);

  const rescored = recomputeActivityImportanceFromFactors(freshWhale.factors!, {
    ...DEFAULT_ACTIVITY_IMPORTANCE_FORMULA,
    version: 'test-rescore',
    baseScoreWeights: {
      sourceRarity: 0.4,
      assetWeight: 0.6,
    },
  });
  assert.equal(rescored.formulaVersion, 'test-rescore');
  assert.deepEqual(rescored.factors, freshWhale.factors);
  assert.notEqual(rescored.score, freshWhale.score);

  const socialSourceCountAligned = computeActivityImportance({
    sourceKind: 'social',
    sourceCount7d: 999,
    socialCount7d: 4,
    walletCount7d: 1,
    totalCount7d: 5,
    historicalMaxAssetUsd: 10_000,
  });
  const socialSourceCountAlignedControl = computeActivityImportance({
    sourceKind: 'social',
    sourceCount7d: 0,
    socialCount7d: 4,
    walletCount7d: 1,
    totalCount7d: 5,
    historicalMaxAssetUsd: 10_000,
  });
  assert.equal(socialSourceCountAligned.sourceCount7d, 4);
  assert.equal(socialSourceCountAlignedControl.sourceCount7d, 4);
  assert.equal(socialSourceCountAligned.score, socialSourceCountAlignedControl.score);

  assert.equal(getActivityImportanceLevelLabel(49), '普通');
  assert.equal(getActivityImportanceLevelLabel(50), '重要');
  assert.equal(getActivityImportanceLevelLabel(70), '高重要');

  const noisyActor = computeActivityImportance({
    sourceKind: 'social',
    sourceCount7d: 3,
    socialCount7d: 3,
    walletCount7d: 8,
    totalCount7d: 11,
    historicalMaxAssetUsd: 50_000,
  });
  const explanation = buildActivityImportanceExplanationRows(noisyActor);
  assert.deepEqual(
    explanation.map((row) => row.label),
    ['同源稀缺分', '资产权重', '总频率因子', '数据可信度因子']
  );
  assert.equal(explanation[0]?.valueText, '近7天社交动态（推特/TG）共 3 条，同源稀缺分：0.50');
  assert.equal(explanation[1]?.valueText.includes('50K USD'), true);
  assert.equal(explanation[2]?.valueText, '近7天总动态共 11 条，总频率因子：0.89');
  assert.equal(getActivityImportanceLevelLabel(noisyActor.score), '普通');

  console.log('activity importance formula tests: ok');
}

run();
