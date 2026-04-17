import assert from 'node:assert/strict';

import type { Activity, User } from '@/types';

import {
  fixtureAddresses,
  parserFixtureCases,
  poisonFixtureCases,
  type ParserFixtureCase,
  type PoisonFixtureItem,
} from './fixtures/parser-fixtures';

process.env.OKX_API_KEY ??= 'fixture-okx-key';
process.env.OKX_SECRET_KEY ??= 'fixture-okx-secret';
process.env.OKX_API_PASSPHRASE ??= 'fixture-okx-passphrase';

function createUser(userId: string, userName: string, trackedAddress: string, chain: ParserFixtureCase['chain']): User {
  return {
    id: userId,
    name: userName,
    handle: userName.toLowerCase(),
    avatar: `${userName.toLowerCase()}.png`,
    addresses: [
      {
        address: trackedAddress,
        name: `${userName} primary`,
        chain,
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
    ],
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
  };
}

function createJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function createFixtureFetch(fixture: ParserFixtureCase, metrics: { detailFetches: number }) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('/transactions-by-address?')) {
      return createJsonResponse({
        code: '0',
        data: [
          {
            transactionList: fixture.transactions,
          },
        ],
      });
    }

    if (url.includes('/transaction-detail-by-txhash?')) {
      metrics.detailFetches += 1;
      const txHash = new URL(url).searchParams.get('txHash') || '';
      const detail = fixture.detailByTxHash?.[txHash];
      return createJsonResponse({
        code: '0',
        data: detail ? [detail] : [],
      });
    }

    throw new Error(`Unhandled fixture fetch for ${fixture.name}: ${url} (${init?.method || 'GET'})`);
  };
}

function assertActivityMatches(fixture: ParserFixtureCase, activity: Activity) {
  const { expected } = fixture;

  assert.equal(activity.metadata.txAction, expected.txAction, `${fixture.name}: txAction mismatch`);
  assert.equal(activity.metadata.token, expected.token, `${fixture.name}: token mismatch`);
  assert.equal(activity.metadata.value, expected.value, `${fixture.name}: value mismatch`);
  assert.equal(activity.metadata.quoteToken, expected.quoteToken, `${fixture.name}: quoteToken mismatch`);
  assert.equal(activity.metadata.quoteAmount, expected.quoteAmount, `${fixture.name}: quoteAmount mismatch`);
  assert.equal(activity.metadata.uncertainFrom, expected.uncertainFrom, `${fixture.name}: uncertainFrom mismatch`);
  assert.match(activity.title || '', new RegExp(expected.titleIncludes), `${fixture.name}: title mismatch`);
  assert.match(activity.content, new RegExp(expected.contentIncludes), `${fixture.name}: content mismatch`);
}

function createPoisonFixtureFeedItem(item: PoisonFixtureItem) {
  const user = createUser(item.userId, item.userName, item.trackedAddress, item.chain);

  return {
    user,
    activity: {
      id: `${item.userId}-${item.txHash}`,
      userId: item.userId,
      source: 'blockchain' as const,
      type: 'transfer' as const,
      title: item.txAction === 'receive' ? '收到转账' : '买入资产',
      content: `${item.txAction === 'receive' ? '收到' : '买入'} ${item.value} ${item.token}`,
      timestamp: 1710001000000,
      metadata: {
        txHash: item.txHash,
        value: item.value,
        token: item.token,
        tokenAddress: item.tokenAddress,
        chain: item.chain,
        fromAddress: item.fromAddress,
        toAddress: item.toAddress,
        txStatus: 'success',
        txAction: item.txAction,
        trackedAddress: item.trackedAddress,
        uncertainFrom: item.uncertainFrom,
      },
    },
  };
}

function applyFixturePoisonPolicy(feed: Array<{ user: User; activity: Activity }>) {
  const senderFanOutStats = new Map<
    string,
    {
      transferCount: number;
      recipientAddresses: Set<string>;
    }
  >();

  for (const item of feed) {
    const { activity } = item;
    if (activity.source !== 'blockchain') continue;
    if (activity.metadata.txAction !== 'receive') continue;
    if (!activity.metadata.uncertainFrom) continue;

    const chain = (activity.metadata.chain || '').trim().toLowerCase();
    const fromAddress = (activity.metadata.fromAddress || '').trim().toLowerCase();
    const toAddress = (activity.metadata.toAddress || activity.metadata.trackedAddress || '').trim().toLowerCase();
    if (!chain || !fromAddress || !toAddress) continue;

    const key = `${chain}|${fromAddress}`;
    const entry = senderFanOutStats.get(key) ?? {
      transferCount: 0,
      recipientAddresses: new Set<string>(),
    };
    entry.transferCount += 1;
    entry.recipientAddresses.add(toAddress);
    senderFanOutStats.set(key, entry);
  }

  const suspiciousSenderKeys = new Set(
    Array.from(senderFanOutStats.entries())
      .filter(([, value]) => value.transferCount >= 3 && value.recipientAddresses.size >= 3)
      .map(([key]) => key)
  );

  return feed.filter((item) => {
    const { activity } = item;
    if (activity.metadata.txAction !== 'receive') return true;
    if (!activity.metadata.uncertainFrom) return true;

    const chain = (activity.metadata.chain || '').trim().toLowerCase();
    const fromAddress = (activity.metadata.fromAddress || '').trim().toLowerCase();
    if (!chain || !fromAddress) return true;

    return !suspiciousSenderKeys.has(`${chain}|${fromAddress}`);
  });
}

async function runParserFixtures() {
  const { buildActivityFeed } = await import('@/lib/activityFeed');
  const originalFetch = globalThis.fetch;

  try {
    for (const fixture of parserFixtureCases) {
      const metrics = { detailFetches: 0 };
      globalThis.fetch = createFixtureFetch(fixture, metrics) as typeof fetch;

      const user = createUser(`parser-${fixture.name}`, fixture.name, fixture.trackedAddress, fixture.chain);
      const result = await buildActivityFeed([user], {
        beginMs: 0,
        endMs: 1710009999999,
        requireTrackedInitiator: false,
      });

      const expectedFeedCount = fixture.expected.feedCount ?? 1;
      assert.equal(result.feed.length, expectedFeedCount, `${fixture.name}: feed count mismatch`);
      assert.equal(result.summary.transactionCount, expectedFeedCount, `${fixture.name}: summary count mismatch`);

      const activity = result.feed[0]?.activity;
      assert.ok(activity, `${fixture.name}: expected an activity`);
      assertActivityMatches(fixture, activity);
      assert.equal(metrics.detailFetches, fixture.expected.detailFetches ?? 0, `${fixture.name}: detail fetch count mismatch`);

      console.log(`PASS parser ${fixture.name}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function runPoisonFixtures() {
  for (const fixture of poisonFixtureCases) {
    const feed = fixture.items.map(createPoisonFixtureFeedItem);
    const visible = applyFixturePoisonPolicy(feed);
    const visibleTxHashes = visible
      .map((item) => item.activity.metadata.txHash || '')
      .filter(Boolean)
      .sort();
    const expectedTxHashes = [...fixture.expectedVisibleTxHashes].sort();

    assert.deepEqual(visibleTxHashes, expectedTxHashes, `${fixture.name}: visible tx hashes mismatch`);
    console.log(`PASS poison ${fixture.name}`);
  }
}

async function main() {
  assert.notEqual(fixtureAddresses.trackedA, fixtureAddresses.router, 'fixture addresses must remain distinct');

  await runParserFixtures();
  runPoisonFixtures();

  console.log(`PASS all parser fixtures (${parserFixtureCases.length} parser + ${poisonFixtureCases.length} poison)`);
}

main().catch((error) => {
  console.error('FAIL parser fixtures');
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
