import assert from 'node:assert/strict';

import {
  clearTwitterProviderStateForTests,
  getTwitterDateKey,
  markTwitterProviderFailure,
  markTwitterProviderSuccess,
  readTwitterIdentityCache,
  readTwitterProviderBudgetSnapshot,
  upsertTwitterIdentityCache,
} from '@/lib/server/twitterProviderStateRepo';

function main() {
  clearTwitterProviderStateForTests();

  assert.equal(getTwitterDateKey(Date.UTC(2026, 3, 22, 15, 59, 59)), '2026-04-22');
  assert.equal(getTwitterDateKey(Date.UTC(2026, 3, 22, 16, 0, 0)), '2026-04-23');

  upsertTwitterIdentityCache({
    handle: 'elonmusk',
    provider: '6551',
    userId: '44196397',
    username: 'elonmusk',
    expiresAtMs: Date.now() + 60_000,
    lastError: null,
  });
  const identity = readTwitterIdentityCache('elonmusk');
  assert.equal(identity?.userId, '44196397');
  assert.equal(identity?.provider, '6551');

  upsertTwitterIdentityCache({
    handle: 'stale-user',
    provider: '6551',
    userId: null,
    username: 'stale-user',
    expiresAtMs: Date.now() - 1_000,
    lastError: 'identity_resolution_failed',
  });
  assert.equal(readTwitterIdentityCache('stale-user'), null);

  markTwitterProviderSuccess({
    provider: '6551',
    credentialId: 'key-1',
    nowMs: Date.UTC(2026, 3, 22, 20, 0, 0),
    dailyLimit: 100,
  });
  markTwitterProviderSuccess({
    provider: '6551',
    credentialId: 'key-1',
    nowMs: Date.UTC(2026, 3, 22, 20, 5, 0),
    dailyLimit: 100,
    successUnits: 2,
  });
  markTwitterProviderFailure({
    provider: '6551',
    credentialId: 'key-1',
    nowMs: Date.UTC(2026, 3, 22, 20, 6, 0),
    error: 'timeout',
    cooldownMs: 300_000,
    dailyLimit: 100,
  });

  const budget = readTwitterProviderBudgetSnapshot({
    provider: '6551',
    credentialId: 'key-1',
    nowMs: Date.UTC(2026, 3, 22, 20, 7, 0),
    dailyLimit: 100,
  });
  assert.equal(budget.dateKey, '2026-04-23');
  assert.equal(budget.successUnitsUsed, 3);
  assert.equal(budget.remainingUnits, 97);
  assert.ok((budget.cooldownUntilMs || 0) > 0);

  markTwitterProviderFailure({
    provider: '6551',
    credentialId: 'key-2',
    nowMs: Date.UTC(2026, 3, 22, 21, 0, 0),
    error: 'rate_limited',
    cooldownMs: 120_000,
    dailyLimit: 7,
  });
  const failureFirstBudget = readTwitterProviderBudgetSnapshot({
    provider: '6551',
    credentialId: 'key-2',
    nowMs: Date.UTC(2026, 3, 22, 21, 1, 0),
    dailyLimit: 7,
  });
  assert.equal(failureFirstBudget.dailyLimit, 7);
  assert.equal(failureFirstBudget.successUnitsUsed, 0);
  assert.equal(failureFirstBudget.remainingUnits, 7);

  console.log('twitter provider state tests: ok');
}

main();
