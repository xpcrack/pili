import assert from 'node:assert/strict';

import type { Activity, User } from '@/types';

import {
  fixtureAddresses,
  parserFixtureCases,
  poisonFixtureCases,
  telegramMonitorFixtureCases,
  type ParserFixtureCase,
  type PoisonFixtureItem,
} from './fixtures/parser-fixtures';

process.env.OKX_API_KEY ??= 'fixture-okx-key';
process.env.OKX_SECRET_KEY ??= 'fixture-okx-secret';
process.env.OKX_API_PASSPHRASE ??= 'fixture-okx-passphrase';
process.env.TELEGRAM_MONITOR_INGEST_TOKEN ??= 'fixture-telegram-ingest-token';

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

    if (url.includes('/api/v5/market/ticker?')) {
      const instId = new URL(url).searchParams.get('instId') || '';
      const priceByInstId: Record<string, string> = {
        'BNB-USDT': '600',
        'SOL-USDT': '150',
      };
      return createJsonResponse({
        code: '0',
        data: priceByInstId[instId]
          ? [
              {
                instId,
                last: priceByInstId[instId],
              },
            ]
          : [],
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
      assert.equal(result.judgments.length, 1, `${fixture.name}: judgment count mismatch`);
      const judgment = result.judgments[0];
      assert.equal(judgment.decision, fixture.expected.filterDecision ?? 'visible', `${fixture.name}: filter decision mismatch`);
      assert.equal(
        judgment.reasonCode,
        fixture.expected.filterReasonCode ?? 'meets_min_usd',
        `${fixture.name}: filter reason mismatch`
      );
      if (fixture.expected.computedUsdValue === null) {
        assert.equal(judgment.computedUsdValue ?? null, null, `${fixture.name}: computedUsdValue mismatch`);
      } else if (typeof fixture.expected.computedUsdValue === 'number') {
        assert.equal(judgment.computedUsdValue, fixture.expected.computedUsdValue, `${fixture.name}: computedUsdValue mismatch`);
      }

      if (expectedFeedCount > 0) {
        const activity = result.feed[0]?.activity;
        assert.ok(activity, `${fixture.name}: expected an activity`);
        assertActivityMatches(fixture, activity);
      } else {
        assert.equal(result.feed[0], undefined, `${fixture.name}: unexpected visible activity`);
      }
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

async function runTelegramMonitorFixtures() {
  const { parseXxyyTelegramText } = await import('@/lib/server/xxyyTelegramParser');
  const { POST } = await import('@/app/api/telegram/monitor/route');
  const { createTrackedUser, deleteTrackedUser } = await import('@/lib/server/trackedUsersRepo');
  const { readTelegramMonitorFeed } = await import('@/lib/server/telegramMonitorFeed');
  const { getDb } = await import('@/lib/server/sqlite');

  for (const fixture of telegramMonitorFixtureCases) {
    const parsed = parseXxyyTelegramText(fixture.text, fixture.fallbackTimestampMs, fixture.linkCandidates);
    assert.equal(parsed.action, fixture.expected.action, `${fixture.name}: action mismatch`);
    assert.equal(parsed.actionLabel, fixture.expected.actionLabel, `${fixture.name}: actionLabel mismatch`);
    assert.equal(parsed.actionVariant, fixture.expected.actionVariant, `${fixture.name}: actionVariant mismatch`);
    assert.equal(parsed.quoteAmount, fixture.expected.quoteAmount, `${fixture.name}: quoteAmount mismatch`);
    assert.equal(parsed.quoteSymbol, fixture.expected.quoteSymbol, `${fixture.name}: quoteSymbol mismatch`);
    assert.equal(parsed.tokenAmount, fixture.expected.tokenAmount, `${fixture.name}: tokenAmount mismatch`);
    assert.equal(parsed.tokenSymbol, fixture.expected.tokenSymbol, `${fixture.name}: tokenSymbol mismatch`);
    assert.equal(parsed.marketCapUsd, fixture.expected.marketCapUsd, `${fixture.name}: marketCapUsd mismatch`);
    assert.equal(parsed.chain, fixture.expected.chain, `${fixture.name}: chain mismatch`);
    assert.equal(parsed.tokenAddress, fixture.expected.tokenAddress, `${fixture.name}: tokenAddress mismatch`);
    assert.equal(parsed.walletGroupLabel, fixture.expected.walletGroupLabel, `${fixture.name}: walletGroupLabel mismatch`);
    assert.equal(parsed.walletAliasLabel, fixture.expected.walletAliasLabel, `${fixture.name}: walletAliasLabel mismatch`);
    assert.equal(parsed.trackedWalletAddress, fixture.expected.trackedWalletAddress, `${fixture.name}: trackedWalletAddress mismatch`);
    console.log(`PASS telegram-parse ${fixture.name}`);
  }

  const routeFixture = telegramMonitorFixtureCases.find((fixture) => fixture.name === 'xxyy-bot-to-bot-buy')!;
  const trackedUser = createTrackedUser({
    name: 'finn',
    handle: 'finn',
    avatar: 'finn.png',
    twitter: undefined,
    telegram: undefined,
    addresses: [
      {
        address: routeFixture.expected.trackedWalletAddress!,
        name: '#2',
        chain: 'bsc',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
    ],
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: ['fixture'],
  });

  try {
    const requestBody = {
      update_id: 900001,
      message: {
        message_id: 501,
        date: Math.floor(routeFixture.fallbackTimestampMs / 1000),
        chat: { id: -100123456 },
        text: routeFixture.text,
        entities: [
          {
            type: 'text_link',
            url: routeFixture.linkCandidates[0],
          },
        ],
      },
    };

    const request = new Request('http://localhost:3005/api/telegram/monitor', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': process.env.TELEGRAM_MONITOR_INGEST_TOKEN!,
      },
      body: JSON.stringify(requestBody),
    });

    const response = await POST(request as never);
    const payload = await response.json();
    assert.equal(response.status, 200, 'telegram route: status mismatch');
    assert.equal(payload.ok, true, 'telegram route: ok mismatch');
    assert.equal(payload.parsed.trackedWalletAddress, routeFixture.expected.trackedWalletAddress, 'telegram route: trackedWalletAddress mismatch');

    const db = getDb();
    const row = db
      .prepare(
        `SELECT tracked_wallet_address, wallet_group_label, wallet_alias_label
         FROM telegram_monitor_events
         WHERE provider = 'xxyy' AND source_chat_id = ? AND source_message_id = ?
         LIMIT 1`
      )
      .get(String(requestBody.message.chat.id), requestBody.message.message_id) as
      | { tracked_wallet_address: string | null; wallet_group_label: string | null; wallet_alias_label: string | null }
      | undefined;

    assert.ok(row, 'telegram route: expected saved row');
    assert.equal(row?.tracked_wallet_address, routeFixture.expected.trackedWalletAddress, 'telegram route: saved tracked wallet mismatch');
    assert.equal(row?.wallet_group_label, routeFixture.expected.walletGroupLabel, 'telegram route: saved wallet group mismatch');
    assert.equal(row?.wallet_alias_label, routeFixture.expected.walletAliasLabel, 'telegram route: saved wallet alias mismatch');

    const feed = readTelegramMonitorFeed(20);
    const item = feed.find((entry) => entry.activity.metadata.tokenAddress === routeFixture.expected.tokenAddress);
    assert.ok(item, 'telegram feed: expected item');
    assert.equal(item?.user.id, trackedUser.id, 'telegram feed: should map to tracked user');
    assert.equal(item?.activity.metadata.trackedAddress, routeFixture.expected.trackedWalletAddress, 'telegram feed: trackedAddress mismatch');
    console.log('PASS telegram-route xxyy-bot-to-bot-buy');
  } finally {
    deleteTrackedUser(trackedUser.id);
  }
}

async function main() {
  assert.notEqual(fixtureAddresses.trackedA, fixtureAddresses.router, 'fixture addresses must remain distinct');

  await runParserFixtures();
  runPoisonFixtures();
  await runTelegramMonitorFixtures();

  console.log(
    `PASS all parser fixtures (${parserFixtureCases.length} parser + ${poisonFixtureCases.length} poison + ${telegramMonitorFixtureCases.length} telegram)`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
