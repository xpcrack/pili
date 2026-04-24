import assert from 'node:assert/strict';

import {
  chooseTwitterProviderRoute,
  type TwitterStructuredProviderRouteInput,
} from '@/lib/server/twitterProviderRouter';

function buildInput(
  overrides: Partial<TwitterStructuredProviderRouteInput> = {}
): TwitterStructuredProviderRouteInput {
  return {
    intent: 'sync',
    nowMs: Date.UTC(2026, 3, 23, 4, 0, 0),
    providers: {
      keys6551: [
        {
          provider: '6551',
          credentialId: '6551-key-1',
          apiKey: 'key-1',
          dailyLimit: 100,
          remainingUnits: 10,
          cooldownUntilMs: null,
          lastSuccessAtMs: Date.UTC(2026, 3, 23, 3, 55, 0),
          lastFailureAtMs: null,
        },
        {
          provider: '6551',
          credentialId: '6551-key-2',
          apiKey: 'key-2',
          dailyLimit: 100,
          remainingUnits: 40,
          cooldownUntilMs: null,
          lastSuccessAtMs: Date.UTC(2026, 3, 23, 3, 50, 0),
          lastFailureAtMs: null,
        },
      ],
      xread:
        {
          provider: 'xread',
          credentialId: 'xread-default',
          apiKey: 'xread-key',
        },
    },
    ...overrides,
  };
}

function testPrefersHealthy6551KeyWithoutUsingLocalBudgetAsGate() {
  const route = chooseTwitterProviderRoute(buildInput());
  assert.deepEqual(route.orderedProviders.map((item) => item.provider), ['6551', '6551', 'xread']);
  assert.equal(route.orderedProviders[0]?.credentialId, '6551-key-1');
  assert.equal(route.orderedProviders[1]?.credentialId, '6551-key-2');
  assert.equal(route.primaryProvider?.provider, '6551');
  assert.equal(route.primaryProvider?.credentialId, '6551-key-1');
}

function testSkipsCooldownAndUsesHealthy6551Key() {
  const route = chooseTwitterProviderRoute(
    buildInput({
      providers: {
        keys6551: [
          {
            provider: '6551',
            credentialId: '6551-key-1',
            apiKey: 'key-1',
            dailyLimit: 100,
            remainingUnits: 99,
            cooldownUntilMs: Date.UTC(2026, 3, 23, 4, 15, 0),
            lastSuccessAtMs: Date.UTC(2026, 3, 23, 3, 59, 0),
            lastFailureAtMs: Date.UTC(2026, 3, 23, 4, 0, 0),
          },
          {
            provider: '6551',
            credentialId: '6551-key-2',
            apiKey: 'key-2',
            dailyLimit: 100,
            remainingUnits: 5,
            cooldownUntilMs: null,
            lastSuccessAtMs: Date.UTC(2026, 3, 23, 3, 58, 0),
            lastFailureAtMs: null,
          },
        ],
        xread: {
          provider: 'xread',
          credentialId: 'xread-default',
          apiKey: 'xread-key',
        },
      },
    })
  );

  assert.equal(route.primaryProvider?.provider, '6551');
  assert.equal(route.primaryProvider?.credentialId, '6551-key-2');
  assert.deepEqual(route.unavailableProviders.map((item) => item.credentialId), ['6551-key-1']);
  assert.equal(route.unavailableProviders[0]?.reason, 'cooldown_active');
}

function testFallsBackToXreadWhen6551IsUnavailable() {
  const route = chooseTwitterProviderRoute(
    buildInput({
      providers: {
        keys6551: [
          {
            provider: '6551',
            credentialId: '6551-key-1',
            apiKey: 'key-1',
            dailyLimit: 100,
            remainingUnits: 0,
            cooldownUntilMs: Date.UTC(2026, 3, 23, 4, 30, 0),
            lastSuccessAtMs: Date.UTC(2026, 3, 23, 3, 55, 0),
            lastFailureAtMs: Date.UTC(2026, 3, 23, 4, 0, 0),
          },
        ],
        xread: {
          provider: 'xread',
          credentialId: 'xread-default',
          apiKey: 'xread-key',
        },
      },
    })
  );

  assert.equal(route.primaryProvider?.provider, 'xread');
  assert.deepEqual(route.orderedProviders.map((item) => item.provider), ['xread']);
  assert.equal(route.unavailableProviders[0]?.reason, 'cooldown_active');
}

function testReturnsNoopRouteWithoutStructuredProviders() {
  const route = chooseTwitterProviderRoute(
    buildInput({
      providers: {
        keys6551: [],
        xread: null,
      },
    })
  );

  assert.equal(route.primaryProvider, null);
  assert.equal(route.orderedProviders.length, 0);
}

function testBackfillKeepsHealthy6551AheadOfXread() {
  const route = chooseTwitterProviderRoute(
    buildInput({
      intent: 'backfill',
    })
  );

  assert.deepEqual(
    route.orderedProviders.map((item) => `${item.provider}:${item.credentialId}`),
    ['6551:6551-key-1', '6551:6551-key-2', 'xread:xread-default']
  );
}

function main() {
  testPrefersHealthy6551KeyWithoutUsingLocalBudgetAsGate();
  testSkipsCooldownAndUsesHealthy6551Key();
  testFallsBackToXreadWhen6551IsUnavailable();
  testReturnsNoopRouteWithoutStructuredProviders();
  testBackfillKeepsHealthy6551AheadOfXread();
  console.log('twitter provider router tests: ok');
}

main();
