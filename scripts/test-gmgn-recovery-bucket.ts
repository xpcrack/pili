import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import {
  gmgnBucketCapacity,
  gmgnEffectiveCost,
} from '../lib/server/gmgnRateLimit';

function run() {
  const signedRecoveryCost = gmgnEffectiveCost(3, 0.3);
  const signedRecoveryCapacity = gmgnBucketCapacity(3, signedRecoveryCost, 0.3);
  assert.equal(signedRecoveryCost, 10);
  assert.ok(
    signedRecoveryCapacity >= signedRecoveryCost,
    'a signed request must eventually fit in the recovery bucket'
  );

  const readRecoveryCost = gmgnEffectiveCost(1, 0.3);
  const readRecoveryCapacity = gmgnBucketCapacity(3, readRecoveryCost, 0.3);
  assert.ok(readRecoveryCapacity >= readRecoveryCost);
  assert.ok(readRecoveryCapacity < signedRecoveryCapacity);

  const normalCost = gmgnEffectiveCost(3, 1);
  assert.equal(normalCost, 3);
  assert.equal(gmgnBucketCapacity(3, normalCost, 1), 3);

  console.log('gmgn recovery bucket tests: ok');
}

run();
