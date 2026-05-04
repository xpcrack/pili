import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Activity, User } from '@/types';
import './server-only-shim.cjs';

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

const INTENTIONAL_CRASH_AFTER_SYSTEM_CONFIG = 'PARSER_FIXTURE_TEST_CRASH_AFTER_SYSTEM_CONFIG';

function configureIsolatedTestDb() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-parser-fixtures-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');
  return tempDir;
}

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

    if (url.includes('/api/v6/dex/market/historical-candles?')) {
      return createJsonResponse({
        code: '0',
        data: [[String(fixture.transactions[0]?.txTime || 1710000000000), '0', '0', '0', '600', '0', '0', '0']],
      });
    }

    throw new Error(`Unhandled fixture fetch for ${fixture.name}: ${url} (${init?.method || 'GET'})`);
  };
}

async function loadTelegramMonitorFeedHelpers() {
  try {
    return await import('@/lib/server/telegramMonitorFeedHelpers');
  } catch {
    return null;
  }
}

function createTelegramMonitorFixtureActivity(
  id: string,
  overrides: Partial<Activity> & { metadata?: Partial<Activity['metadata']> } = {}
): Activity {
  return {
    id,
    userId: overrides.userId || 'fixture-user',
    source: overrides.source || 'blockchain',
    type: overrides.type || 'transfer',
    content: overrides.content || 'fixture activity',
    title: overrides.title,
    timestamp: overrides.timestamp ?? 1710000000000,
    metadata: {
      txHash: '0xfixturetx',
      chain: 'bsc',
      trackedAddress: '0xfixturetracked',
      ...overrides.metadata,
    },
  };
}

async function runTelegramMonitorHelperFixtures() {
  const helpers = await loadTelegramMonitorFeedHelpers();
  assert.ok(helpers, 'telegram helper module should exist');

  const {
    buildTrackedAddressIndex,
    pickMonitoredUser,
    buildTelegramMonitorFeedDedupKey,
    dedupeTelegramMonitorFeedRows,
  } = helpers;

  assert.equal(typeof buildTrackedAddressIndex, 'function', 'buildTrackedAddressIndex should be exported');
  assert.equal(typeof pickMonitoredUser, 'function', 'pickMonitoredUser should be exported');
  assert.equal(typeof buildTelegramMonitorFeedDedupKey, 'function', 'buildTelegramMonitorFeedDedupKey should be exported');
  assert.equal(typeof dedupeTelegramMonitorFeedRows, 'function', 'dedupeTelegramMonitorFeedRows should be exported');

  const evmUser: User = {
    id: 'evm-user',
    name: 'Finn',
    handle: 'finn',
    avatar: 'finn.png',
    addresses: [
      {
        address: '0x7592ca1ad468ddac5a97a5625c1c55e36338f786',
        name: '#2',
        chain: 'bsc',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
    ],
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
  };
  const solUser: User = {
    id: 'sol-user',
    name: 'Henry',
    handle: 'henry',
    avatar: 'henry.png',
    addresses: [
      {
        address: 'testuser_solana_placeholder_1111111111111111',
        name: '#1',
        chain: 'solana',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
    ],
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
  };
  const users = [evmUser, solUser];

  const trackedAddressIndex = buildTrackedAddressIndex(users);
  assert.equal(
    trackedAddressIndex.get('ethereum|0x7592ca1ad468ddac5a97a5625c1c55e36338f786')?.user.id,
    evmUser.id,
    'tracked-address index should fan out EVM addresses across EVM chains'
  );
  assert.equal(
    trackedAddressIndex.get('solana|cj5fhknpf3yd7fk njv5vtbjtndawfirflcutputanpis'.replace(' ', ''))?.user.id,
    solUser.id,
    'tracked-address index should keep non-EVM addresses on their native chain only'
  );
  console.log('PASS telegram-helper tracked-address-index');

  const matchedByAddress = pickMonitoredUser({
    eventWalletAliasLabel: 'user_a#1',
    trackedWalletAddress: evmUser.addresses[0]?.address || null,
    chain: 'base',
    users,
    trackedAddressIndex,
  });
  assert.equal(
    matchedByAddress?.user.id,
    evmUser.id,
    'monitored-user picking should prefer tracked address matches over alias matches'
  );

  const matchedByAlias = pickMonitoredUser({
    eventWalletAliasLabel: 'user_d#1',
    trackedWalletAddress: null,
    chain: 'ethereum',
    users,
    trackedAddressIndex,
  });
  assert.equal(
    matchedByAlias?.trackedAddress,
    evmUser.addresses[0]?.address,
    'monitored-user picking should match address aliases across compatible EVM chains'
  );
  console.log('PASS telegram-helper monitored-user-picking');

  const aggregateDedupRow = {
    user: evmUser,
    activity: createTelegramMonitorFixtureActivity('aggregate', {
      metadata: {
        monitorTxAggregateKey: 'aggregate-key',
        txHash: '0xaggregate',
      },
    }),
  };
  assert.equal(
    buildTelegramMonitorFeedDedupKey(aggregateDedupRow),
    'aggregate-key',
    'dedupe key should prefer monitorTxAggregateKey when present'
  );
  const txIdentityDedupRow = {
    user: evmUser,
    activity: createTelegramMonitorFixtureActivity('tx-key', {
      metadata: {
        chain: 'BSC',
        trackedAddress: '0xABC',
        txHash: '0xDEF',
      },
    }),
  };
  assert.equal(
    buildTelegramMonitorFeedDedupKey(txIdentityDedupRow),
    'bsc:0xabc:0xdef',
    'dedupe key should fall back to normalized chain/address/tx identity'
  );
  const idFallbackDedupRow = {
    user: evmUser,
    activity: createTelegramMonitorFixtureActivity('row-id', {
      metadata: {
        chain: '',
        trackedAddress: '',
        txHash: '',
      },
    }),
  };
  assert.equal(
    buildTelegramMonitorFeedDedupKey(idFallbackDedupRow),
    'row-id',
    'dedupe key should fall back to activity id when tx identity is incomplete'
  );

  const stateRow = {
    user: evmUser,
    activity: createTelegramMonitorFixtureActivity('state-row', {
      timestamp: 100,
      metadata: {
        chain: 'bsc',
        trackedAddress: '0x7592ca1ad468ddac5a97a5625c1c55e36338f786',
        txHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        quoteAmount: '0.0292',
      },
    }),
  };
  const newerFallbackRow = {
    user: evmUser,
    activity: createTelegramMonitorFixtureActivity('fallback-row-newer', {
      timestamp: 120,
      metadata: {
        chain: 'bsc',
        trackedAddress: '0x7592ca1ad468ddac5a97a5625c1c55e36338f786',
        txHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        quoteAmount: '0.0512',
      },
    }),
  };
  const tiedFallbackRow = {
    user: evmUser,
    activity: createTelegramMonitorFixtureActivity('fallback-row-tied', {
      timestamp: 200,
      metadata: {
        chain: 'bsc',
        trackedAddress: '0x7592ca1ad468ddac5a97a5625c1c55e36338f786',
        txHash: '0xtied',
        quoteAmount: '0.0220',
      },
    }),
  };
  const tiedStateRow = {
    user: evmUser,
    activity: createTelegramMonitorFixtureActivity('state-row-tied', {
      timestamp: 200,
      metadata: {
        chain: 'bsc',
        trackedAddress: '0x7592ca1ad468ddac5a97a5625c1c55e36338f786',
        txHash: '0xtied',
        quoteAmount: '0.0292',
      },
    }),
  };

  const dedupedLatestWins = dedupeTelegramMonitorFeedRows([stateRow, newerFallbackRow]);
  assert.equal(dedupedLatestWins.length, 1, 'dedupe should collapse rows with the same tx identity');
  assert.equal(
    dedupedLatestWins[0]?.activity.metadata.quoteAmount,
    '0.0512',
    'dedupe should keep the latest timestamp when duplicate rows collide'
  );

  const dedupedTieKeepsLaterRow = dedupeTelegramMonitorFeedRows([tiedStateRow, tiedFallbackRow]);
  assert.equal(
    dedupedTieKeepsLaterRow[0]?.activity.id,
    'fallback-row-tied',
    'dedupe should keep the later row on timestamp ties to preserve current precedence'
  );
  console.log('PASS telegram-helper feed-dedupe');
}

function assertActivityMatches(fixture: ParserFixtureCase, activity: Activity) {
  const { expected } = fixture;

  assert.equal(activity.metadata.txAction, expected.txAction, `${fixture.name}: txAction mismatch`);
  assert.equal(activity.metadata.token, expected.token, `${fixture.name}: token mismatch`);
  assert.equal(activity.metadata.value, expected.value, `${fixture.name}: value mismatch`);
  assert.equal(activity.metadata.quoteToken, expected.quoteToken, `${fixture.name}: quoteToken mismatch`);
  assert.equal(activity.metadata.quoteAmount, expected.quoteAmount, `${fixture.name}: quoteAmount mismatch`);
  assert.equal(
    activity.metadata.tradeAmountUsdAtTx ?? null,
    expected.tradeAmountUsdAtTx ?? null,
    `${fixture.name}: tradeAmountUsdAtTx mismatch`
  );
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
  const { ingestTelegramMonitorUpdate } = await import('@/lib/server/telegramMonitorIngest');
  const { projectTelegramMonitorEvent } = await import('@/lib/server/telegramMonitorFeed');
  const { createTrackedUser, deleteTrackedUser } = await import('@/lib/server/trackedUsersRepo');
  const { getDb } = await import('@/lib/server/sqlite');
  const { readSystemConfig, saveSystemConfig } = await import('@/lib/server/systemConfigRepo');
  const { readTelegramIngestCursor, saveTelegramIngestCursor } = await import('@/lib/server/workerStateRepo');
  const previousConfig = readSystemConfig();

  saveSystemConfig({
    telegramTradeMonitorSourceChatId: '-100123456',
  });

  if (process.env[INTENTIONAL_CRASH_AFTER_SYSTEM_CONFIG] === '1') {
    throw new Error('parser-fixtures-intentional-crash-after-system-config');
  }

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
    assert.equal(parsed.txHash, fixture.expected.txHash, `${fixture.name}: txHash mismatch`);
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
    const projected = await projectTelegramMonitorEvent({
      event: {
        chain: routeFixture.expected.chain!,
        tokenAddress: routeFixture.expected.tokenAddress!,
        tokenSymbol: routeFixture.expected.tokenSymbol,
        txHash: routeFixture.expected.txHash,
        marketCapUsd: routeFixture.expected.marketCapUsd,
        priceUsd: 0.0036,
        quoteAmount: routeFixture.expected.quoteAmount,
        quoteSymbol: routeFixture.expected.quoteSymbol,
        action: routeFixture.expected.action,
        actionLabel: routeFixture.expected.actionLabel,
        actionVariant: routeFixture.expected.actionVariant,
        walletLabel: routeFixture.expected.walletAliasLabel,
        walletGroupLabel: routeFixture.expected.walletGroupLabel,
        walletAliasLabel: routeFixture.expected.walletAliasLabel,
        trackedWalletAddress: routeFixture.expected.trackedWalletAddress,
        eventTimeMs: routeFixture.fallbackTimestampMs,
        rawText: routeFixture.text,
        updatedAt: routeFixture.fallbackTimestampMs,
      },
    });

    assert.ok(projected, 'telegram projection: expected projected activity');
    assert.equal(
      projected?.activity.metadata.tradeAmountUsdAtTx ?? null,
      routeFixture.expected.tradeAmountUsdAtTx ?? null,
      'telegram projection: tradeAmountUsdAtTx mismatch'
    );
    console.log('PASS telegram-project xxyy-bot-to-bot-buy');

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
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Bscscan',
                url: routeFixture.linkCandidates[1],
              },
            ],
          ],
        },
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
        `SELECT tracked_wallet_address, wallet_group_label, wallet_alias_label, tx_hash
         FROM telegram_monitor_events
         WHERE provider = 'xxyy' AND source_chat_id = ? AND source_message_id = ?
         LIMIT 1`
      )
      .get(String(requestBody.message.chat.id), requestBody.message.message_id) as
      | {
          tracked_wallet_address: string | null;
          wallet_group_label: string | null;
          wallet_alias_label: string | null;
          tx_hash: string | null;
        }
      | undefined;

    assert.ok(row, 'telegram route: expected saved row');
    assert.equal(row?.tracked_wallet_address, routeFixture.expected.trackedWalletAddress, 'telegram route: saved tracked wallet mismatch');
    assert.equal(row?.wallet_group_label, routeFixture.expected.walletGroupLabel, 'telegram route: saved wallet group mismatch');
    assert.equal(row?.wallet_alias_label, routeFixture.expected.walletAliasLabel, 'telegram route: saved wallet alias mismatch');
    assert.equal(row?.tx_hash, routeFixture.expected.txHash, 'telegram route: saved txHash mismatch');

    const projectedEvent = db
      .prepare(
        `SELECT event_id, tx_hash
         FROM events
         WHERE event_id = ?
         LIMIT 1`
      )
      .get(
        `xxyy-monitor:${routeFixture.expected.chain}:${routeFixture.expected.trackedWalletAddress?.toLowerCase()}:${routeFixture.expected.txHash?.toLowerCase()}`
      ) as { event_id: string; tx_hash: string | null } | undefined;

    assert.ok(projectedEvent, 'telegram route: expected projected event row');
    assert.equal(projectedEvent?.tx_hash, routeFixture.expected.txHash, 'telegram route: projected txHash mismatch');
    assert.equal(
      projectedEvent?.event_id,
      `xxyy-monitor:${routeFixture.expected.chain}:${routeFixture.expected.trackedWalletAddress?.toLowerCase()}:${routeFixture.expected.txHash?.toLowerCase()}`,
      'telegram route: projected event_id should use stable monitor tx identity'
    );

    console.log('PASS telegram-route xxyy-bot-to-bot-buy');

    const wrongChatRequest = new Request('http://localhost:3005/api/telegram/monitor', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': process.env.TELEGRAM_MONITOR_INGEST_TOKEN!,
      },
      body: JSON.stringify({
        update_id: 900002,
        message: {
          ...requestBody.message,
          message_id: 502,
          chat: { id: -100999999 },
        },
      }),
    });
    const wrongChatResponse = await POST(wrongChatRequest as never);
    const wrongChatPayload = await wrongChatResponse.json();
    assert.equal(wrongChatPayload.ignored, true, 'telegram route: wrong chat should be ignored');
    assert.equal(wrongChatPayload.reason, 'chat-not-allowed', 'telegram route: wrong chat reason mismatch');
    console.log('PASS telegram-route chat-not-allowed');

    const invalidFormatRequest = new Request('http://localhost:3005/api/telegram/monitor', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': process.env.TELEGRAM_MONITOR_INGEST_TOKEN!,
      },
      body: JSON.stringify({
        update_id: 900003,
        message: {
          message_id: 503,
          date: Math.floor(routeFixture.fallbackTimestampMs / 1000),
          chat: { id: -100123456 },
          text: '[纯鱼#1]\nThis is malformed without CA/action',
        },
      }),
    });
    const invalidFormatResponse = await POST(invalidFormatRequest as never);
    const invalidFormatPayload = await invalidFormatResponse.json();
    assert.equal(invalidFormatPayload.ignored, true, 'telegram route: invalid format should be ignored');
    assert.equal(invalidFormatPayload.reason, 'invalid-trade-format', 'telegram route: invalid format reason mismatch');
    console.log('PASS telegram-route invalid-trade-format');

    const directWorkerBody = {
      ...requestBody,
      update_id: 900004,
      message: {
        ...requestBody.message,
        message_id: 504,
      },
    };
    const directWorkerResult = await ingestTelegramMonitorUpdate(directWorkerBody);
    assert.equal(directWorkerResult.ok, true, 'telegram worker ingest: ok mismatch');
    assert.equal('ignored' in directWorkerResult, false, 'telegram worker ingest: should not be ignored');
    const directWorkerRow = db
      .prepare(
        `SELECT tracked_wallet_address
         FROM telegram_monitor_events
         WHERE provider = 'xxyy' AND source_chat_id = ? AND source_message_id = ?
         LIMIT 1`
      )
      .get(String(directWorkerBody.message.chat.id), directWorkerBody.message.message_id) as
      | {
          tracked_wallet_address: string | null;
        }
      | undefined;
    assert.equal(
      directWorkerRow?.tracked_wallet_address,
      routeFixture.expected.trackedWalletAddress,
      'telegram worker ingest: saved tracked wallet mismatch'
    );
    saveTelegramIngestCursor('fixture-worker', 900004);
    const savedCursor = readTelegramIngestCursor('fixture-worker');
    assert.equal(savedCursor?.last_update_id, 900004, 'telegram worker cursor: last_update_id mismatch');
    console.log('PASS telegram-worker direct-ingest');
  } finally {
    saveSystemConfig(previousConfig);
    deleteTrackedUser(trackedUser.id);
  }
}

async function runTradeAmountBackfillFixture() {
  const { backfillTradeAmountUsdAtTxForActivity } = await import('@/lib/activityFeed');

  const activity: Activity = {
    id: 'trade-backfill',
    userId: 'fixture-user',
    source: 'blockchain',
    type: 'transfer',
    title: '买入资产',
    content: '买入 2 TEST，花费 2 USDT',
    timestamp: 1710001234000,
    metadata: {
      chain: 'bsc',
      txAction: 'buy',
      token: 'TEST',
      value: '2',
      quoteToken: 'USDT',
      quoteAmount: '2',
      trackedAddress: fixtureAddresses.trackedA,
    },
  };

  await backfillTradeAmountUsdAtTxForActivity(activity, 'bsc');

  assert.equal(activity.metadata.tradeAmountUsdAtTx, 2, 'tradeAmountUsdAtTx backfill mismatch');
  console.log('PASS activity-feed trade-amount-backfill');
}

async function runTwitterRelayFixtures() {
  const { POST } = await import('@/app/api/twitter/relay/route');
  const { createTrackedUser, deleteTrackedUser } = await import('@/lib/server/trackedUsersRepo');
  const { listTwitterTweetsByIds, upsertTwitterTweets } = await import('@/lib/server/twitterRepo');
  const { getDb } = await import('@/lib/server/sqlite');
  const { readSystemConfig, saveSystemConfig } = await import('@/lib/server/systemConfigRepo');
  const previousConfig = readSystemConfig();

  process.env.TWITTER_RELAY_INGEST_TOKEN ??= 'fixture-twitter-relay-token';
  saveSystemConfig({ telegramTwitterMonitorSourceChatId: '-5299035575' });

  const trackedUser = createTrackedUser({
    name: 'relayuser',
    handle: 'relayuser',
    avatar: 'relayuser.png',
    twitter: 'relay_user',
    twitterUserId: 'relay-user-id-1',
    telegram: undefined,
    addresses: [],
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: ['fixture'],
  });

  try {
    const validBody = {
      sourceChatId: '-5299035575',
      messageId: 1,
      tweetId: '2049999999999999999',
      authorHandle: 'relay_user',
      action: 'tweet',
      content: 'fixture tweet content',
      url: 'https://x.com/relay_user/status/2049999999999999999',
      createdAtMs: Date.now(),
    };

    const validRequest = new Request('http://localhost:3005/api/twitter/relay', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.TWITTER_RELAY_INGEST_TOKEN}`,
      },
      body: JSON.stringify(validBody),
    });

    const validResponse = await POST(validRequest as never);
    const validPayload = await validResponse.json();
    assert.equal(validPayload.ok, true, 'twitter relay: valid payload should pass');
    const stored = listTwitterTweetsByIds([validBody.tweetId]);
    assert.equal(stored.length, 1, 'twitter relay: tweet should be stored');
    const relaySource = getDb()
      .prepare(`SELECT source_json FROM twitter_tweets WHERE tweet_id = ?`)
      .get(validBody.tweetId) as { source_json: string } | undefined;
    assert.equal(
      JSON.parse(relaySource?.source_json || '{}').provider,
      'bot2bot',
      'twitter relay: valid payload should preserve bot2bot source'
    );
    console.log('PASS twitter-relay valid payload');

    upsertTwitterTweets([
      {
        tweetId: validBody.tweetId,
        authorHandle: validBody.authorHandle,
        fullText: 'provider refresh should not erase relay source',
        createdAtMs: validBody.createdAtMs,
        lane: 'timeline',
        source: { provider: 'xread' },
      },
    ]);
    const preservedRelaySource = getDb()
      .prepare(`SELECT author_user_id, source_json FROM twitter_tweets WHERE tweet_id = ?`)
      .get(validBody.tweetId) as { author_user_id: string | null; source_json: string } | undefined;
    assert.equal(
      JSON.parse(preservedRelaySource?.source_json || '{}').provider,
      'bot2bot',
      'twitter relay: provider refresh should not erase bot2bot source'
    );
    assert.equal(
      preservedRelaySource?.author_user_id,
      'relay-user-id-1',
      'twitter relay: provider refresh should not erase author user id'
    );
    console.log('PASS twitter-relay source preservation');

    const quoteBody = {
      ...validBody,
      messageId: 2,
      tweetId: '2050000000000000004',
      action: 'quote',
      content: 'quoted relay content',
      url: 'https://x.com/relay_user/status/2050000000000000004',
    };
    const quoteRequest = new Request('http://localhost:3005/api/twitter/relay', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.TWITTER_RELAY_INGEST_TOKEN}`,
      },
      body: JSON.stringify(quoteBody),
    });

    const quoteResponse = await POST(quoteRequest as never);
    const quotePayload = await quoteResponse.json();
    assert.equal(quotePayload.ok, true, 'twitter relay: quote payload should pass');
    const quoteEvent = getDb()
      .prepare(`SELECT activity_json FROM events WHERE tweet_id = ?`)
      .get(quoteBody.tweetId) as { activity_json: string } | undefined;
    const quoteActivity = JSON.parse(quoteEvent?.activity_json || '{}') as Activity;
    assert.equal(quoteActivity.title, '引用推文', 'twitter relay: quote action should project as quote');
    assert.equal(quoteActivity.metadata.tweetKind, 'quote', 'twitter relay: quote action should set tweet kind');
    console.log('PASS twitter-relay quote projection');

    const duplicateRequest = new Request('http://localhost:3005/api/twitter/relay', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.TWITTER_RELAY_INGEST_TOKEN}`,
      },
      body: JSON.stringify(validBody),
    });

    const duplicateResponse = await POST(duplicateRequest as never);
    const duplicatePayload = await duplicateResponse.json();
    assert.equal(duplicatePayload.ok, true, 'twitter relay: duplicate payload should still succeed');
    const duplicateStored = listTwitterTweetsByIds([validBody.tweetId]);
    assert.equal(duplicateStored.length, 1, 'twitter relay: duplicate payload should not duplicate stored tweet');
    const duplicateEventCount = Number(
      (
        getDb()
          .prepare(`SELECT COUNT(1) AS count FROM events WHERE source = 'twitter' AND tweet_id = ?`)
          .get(validBody.tweetId) as { count: number }
      ).count || 0
    );
    assert.equal(duplicateEventCount, 1, 'twitter relay: duplicate payload should not duplicate visible event');
    console.log('PASS twitter-relay dedupe');

    const wrongChatRequest = new Request('http://localhost:3005/api/twitter/relay', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.TWITTER_RELAY_INGEST_TOKEN}`,
      },
      body: JSON.stringify({ ...validBody, tweetId: '2050000000000000001', sourceChatId: '-5108676923' }),
    });

    const wrongChatResponse = await POST(wrongChatRequest as never);
    const wrongChatPayload = await wrongChatResponse.json();
    assert.equal(wrongChatPayload.ignored, true, 'twitter relay: wrong chat should be ignored');
    assert.equal(wrongChatPayload.reason, 'chat-not-allowed', 'twitter relay: wrong chat reason mismatch');
    console.log('PASS twitter-relay chat-not-allowed');

    const invalidFormatRequest = new Request('http://localhost:3005/api/twitter/relay', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.TWITTER_RELAY_INGEST_TOKEN}`,
      },
      body: JSON.stringify({
        ...validBody,
        tweetId: 'abc-not-digit',
        url: 'https://x.com/relay_user/status/2050000000000000002',
      }),
    });

    const invalidFormatResponse = await POST(invalidFormatRequest as never);
    const invalidFormatPayload = await invalidFormatResponse.json();
    assert.equal(invalidFormatPayload.ignored, true, 'twitter relay: invalid payload should be ignored');
    assert.equal(invalidFormatPayload.reason, 'invalid-twitter-format', 'twitter relay: invalid reason mismatch');
    console.log('PASS twitter-relay invalid-twitter-format');

    const unknownHandleRequest = new Request('http://localhost:3005/api/twitter/relay', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.TWITTER_RELAY_INGEST_TOKEN}`,
      },
      body: JSON.stringify({
        ...validBody,
        tweetId: '2050000000000000003',
        authorHandle: 'unknown_user',
        url: 'https://x.com/unknown_user/status/2050000000000000003',
      }),
    });

    const unknownHandleResponse = await POST(unknownHandleRequest as never);
    const unknownHandlePayload = await unknownHandleResponse.json();
    assert.equal(unknownHandlePayload.ignored, true, 'twitter relay: unknown handle should be ignored');
    assert.equal(
      unknownHandlePayload.reason,
      'unknown-tracked-twitter-handle',
      'twitter relay: unknown handle reason mismatch'
    );
    console.log('PASS twitter-relay unknown-handle');
  } finally {
    saveSystemConfig(previousConfig);
    deleteTrackedUser(trackedUser.id);
  }
}

async function main() {
  const tempDir = configureIsolatedTestDb();

  try {
    console.log('Running parser fixtures...');
    await runParserFixtures();

    console.log('\nRunning poison fixtures...');
    runPoisonFixtures();

    console.log('\nRunning telegram helper fixtures...');
    await runTelegramMonitorHelperFixtures();

    console.log('\nRunning telegram monitor fixtures...');
    await runTelegramMonitorFixtures();

    console.log('\nRunning trade amount backfill fixture...');
    await runTradeAmountBackfillFixture();

    console.log('\nRunning twitter relay fixtures...');
    await runTwitterRelayFixtures();

    console.log('\n✅ All fixtures passed');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
