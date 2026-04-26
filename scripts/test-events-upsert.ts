import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Activity, User } from '@/types';

import './server-only-shim.cjs';

function makeUser(): User {
  return {
    id: 'events-upsert-user',
    name: 'Events Upsert User',
    handle: 'events-upsert-user',
    avatar: '',
    addresses: [
      {
        address: '0x1111111111111111111111111111111111111111',
        name: '#1',
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
}

function makeActivity(tradeAmountUsdAtTx?: number): Activity {
  return {
    id: 'events-upsert-activity',
    userId: 'events-upsert-user',
    source: 'blockchain',
    type: 'transfer',
    title: '买入资产',
    content: '买入 100 TEST，花费 1 BNB',
    timestamp: 1_710_000_000_000,
    metadata: {
      txHash: '0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed',
      value: '100',
      token: 'TEST',
      tokenAddress: '0xtesttoken',
      quoteToken: 'BNB',
      quoteAmount: '1',
      chain: 'bsc',
      txAction: 'buy',
      trackedAddress: '0x1111111111111111111111111111111111111111',
      tradeAmountUsdAtTx,
    },
  };
}

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-events-upsert-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { upsertEventsFromFeedRows, readEventsFeed } = await import('@/lib/server/eventsRepo');
    const { upsertEventTweetRef, listEventTweetRefsByTweetId } = await import('@/lib/server/twitterEnrichmentRepo');
    const { upsertConflictAndEnqueue } = await import('@/lib/server/conflictRepo');

    const user = makeUser();

    upsertEventsFromFeedRows(
      [
        {
          user,
          activity: makeActivity(600),
        },
      ],
      'test-events-upsert'
    );

    upsertEventsFromFeedRows(
      [
        {
          user,
          activity: makeActivity(undefined),
        },
      ],
      'test-events-upsert'
    );

    const rows = readEventsFeed({
      limit: 10,
      userId: user.id,
    });

    assert.equal(rows.total, 1, 'expected a single merged event');
    assert.equal(
      rows.feed[0]?.activity.metadata.tradeAmountUsdAtTx,
      600,
      'tradeAmountUsdAtTx should be preserved when an incoming refresh omits it'
    );

    const monitorAggregateKey = 'xxyy-monitor:bsc:0x1111111111111111111111111111111111111111:0xmonitoraggregate';
    const monitorProvisional: Activity = {
      ...makeActivity(300),
      id: monitorAggregateKey,
      content: '建仓 0.1181 BNB',
      metadata: {
        ...makeActivity(300).metadata,
        txHash: '0xmonitoraggregate',
        quoteAmount: '0.1181',
        value: '45188.989541',
        monitorTxAggregateKey: monitorAggregateKey,
        monitorReconciliationStatus: 'pending',
        monitorReconciledSource: 'xxyy',
      },
    };
    const monitorCanonical: Activity = {
      ...monitorProvisional,
      content: '建仓 0.2502 BNB',
      metadata: {
        ...monitorProvisional.metadata,
        quoteAmount: '0.2502',
        value: '94464.94413',
        monitorReconciliationStatus: 'reconciled',
        monitorReconciledSource: 'okx-address',
      },
    };

    upsertEventsFromFeedRows(
      [
        {
          user,
          activity: monitorProvisional,
        },
      ],
      'telegram-monitor'
    );
    upsertEventsFromFeedRows(
      [
        {
          user,
          activity: monitorCanonical,
        },
      ],
      'telegram-monitor-reconcile'
    );

    const db = (await import('@/lib/server/sqlite')).getDb();
    const monitorConflictCount = (
      db
        .prepare(
          `SELECT COUNT(*) as count
           FROM feed_conflicts
           WHERE event_key = ?`
        )
        .get(monitorAggregateKey) as { count: number }
    ).count;
    assert.equal(
      monitorConflictCount,
      0,
      'expected monitor aggregate reconciliation to overwrite in place without conflict records'
    );

    const legacyMonitorProvisional: Activity = {
      ...makeActivity(300),
      id: 'legacy-monitor-provisional',
      content: '建仓 0.1181 BNB',
      metadata: {
        ...makeActivity(300).metadata,
        txHash: '0xlegacymonitoraggregate',
        quoteAmount: '0.1181',
        value: '45188.989541',
        rawText: '[xp] [events-upsert-user#1]\n🟢 New buy 0.1181 BNB',
        monitorWalletLabel: 'events-upsert-user',
        monitorWalletAliasLabel: 'events-upsert-user#1',
      },
    };
    const legacyMonitorCanonical: Activity = {
      ...legacyMonitorProvisional,
      id: 'xxyy-monitor:bsc:0x1111111111111111111111111111111111111111:0xlegacymonitoraggregate',
      content: '建仓 0.2502 BNB',
      metadata: {
        ...legacyMonitorProvisional.metadata,
        quoteAmount: '0.2502',
        value: '94464.94413',
        monitorTxAggregateKey:
          'xxyy-monitor:bsc:0x1111111111111111111111111111111111111111:0xlegacymonitoraggregate',
        monitorReconciliationStatus: 'reconciled',
        monitorReconciledSource: 'okx-address',
      },
    };

    upsertEventsFromFeedRows(
      [
        {
          user,
          activity: legacyMonitorProvisional,
        },
      ],
      'telegram-monitor'
    );
    const legacyEventId = (
      db
        .prepare(
          `SELECT event_id
           FROM events
           WHERE user_id = ?
             AND tx_hash = ?
           ORDER BY updated_at DESC, rowid DESC
           LIMIT 1`
        )
        .get(user.id, '0xlegacymonitoraggregate') as { event_id: string } | undefined
    )?.event_id;
    assert.ok(legacyEventId, 'expected provisional legacy monitor event id to be stored');
    upsertEventTweetRef({
      eventId: legacyEventId || '',
      tweetId: 'tweet-legacy-monitor-1',
      refSource: 'telegram-monitor',
      discoveredAtMs: 1_710_000_000_100,
    });
    upsertConflictAndEnqueue({
      conflictKey: `onchain:${legacyEventId}:legacy-conflict`,
      domain: 'onchain',
      eventKey: legacyEventId || '',
      winner: 'api',
      diffJson: [
        {
          field: 'quoteAmount',
          left: '0.1181',
          right: '0.2502',
        },
      ],
    });
    upsertEventsFromFeedRows(
      [
        {
          user,
          activity: legacyMonitorCanonical,
        },
      ],
      'telegram-monitor-reconcile'
    );

    const rowsAfterLegacyUpgrade = readEventsFeed({
      limit: 20,
      userId: user.id,
    });
    const upgradedLegacyMonitorRows = rowsAfterLegacyUpgrade.feed.filter(
      (item) => item.activity.metadata.txHash === '0xlegacymonitoraggregate'
    );
    assert.equal(
      upgradedLegacyMonitorRows.length,
      1,
      'expected legacy provisional monitor event to be upgraded in place during reconciliation'
    );
    assert.equal(
      upgradedLegacyMonitorRows[0]?.activity.metadata.quoteAmount,
      '0.2502',
      'expected upgraded legacy monitor event to keep the canonical quote amount'
    );
    assert.deepEqual(
      listEventTweetRefsByTweetId('tweet-legacy-monitor-1').map((item) => item.eventId),
      [legacyMonitorCanonical.metadata.monitorTxAggregateKey],
      'expected tweet refs to move to the canonical monitor aggregate event id during rekey'
    );
    const conflictEventKeys = (
      db
        .prepare(
          `SELECT event_key
           FROM feed_conflicts
           WHERE event_key = ? OR event_key = ?`
        )
        .all(legacyEventId, legacyMonitorCanonical.metadata.monitorTxAggregateKey) as Array<{ event_key: string }>
    ).map((row) => row.event_key);
    assert.deepEqual(
      conflictEventKeys,
      [legacyMonitorCanonical.metadata.monitorTxAggregateKey],
      'expected feed conflict rows to remap to the canonical monitor aggregate event id during rekey'
    );

    console.log('events upsert tests: ok');
  } finally {
    if (typeof previousDbPath === 'string') {
      process.env.PILIPILI_DB_PATH = previousDbPath;
    } else {
      delete process.env.PILIPILI_DB_PATH;
    }
    if (typeof previousDataDir === 'string') {
      process.env.PILIPILI_DATA_DIR = previousDataDir;
    } else {
      delete process.env.PILIPILI_DATA_DIR;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
