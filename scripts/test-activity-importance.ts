import assert from 'node:assert/strict';

import {
  buildActivityImportanceExplanationRows,
  computeActivityImportance,
  getActivityImportanceLevelLabel,
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
  approx(freshWhale.sourceRarity, 1);
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
  assert.equal(explanation[0]?.description, '这类消息本身最近有多罕见。推文/TG 看社交频率，链上看钱包频率；越少见越高。');
  assert.equal(explanation[1]?.valueText.includes('50,000'), true);
  assert.equal(getActivityImportanceLevelLabel(noisyActor.score), '普通');

  console.log('activity importance formula tests: ok');
}

run();
