import { NextResponse } from 'next/server';
import { getDb } from '@/lib/server/sqlite';
import { readFeedSnapshot } from '@/lib/server/feedSnapshotRepo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DiagnosticResult {
  totalInDatabase: number;
  apiResponseBeforeFilter: number;
  apiResponseAfterFilter: number;
  suspiciousSendersCount: number;
  sampleSuspiciousSenders: string[];
  sampleFilteredItems: Array<{
    txHash: string;
    txAction: string;
    uncertainFrom: boolean;
    chain: string;
    fromAddress: string;
    toAddress: string;
    token: string;
    value: string;
    timestamp: number;
  }>;
  databaseStats: {
    receiveTransactions: number;
    receiveWithUncertainFrom: number;
    receiveWithoutUncertainFrom: number;
    byTxAction: Record<string, number>;
  };
}

export async function GET() {
  try {
    const db = getDb();

    // Get total count from database
    const totalResult = db.prepare('SELECT COUNT(1) AS count FROM activity_feed').get() as { count: number };

    // Get stats by txAction
    const txActionStats = db
      .prepare(`
        SELECT
          json_extract(activity_json, '$.metadata.txAction') AS txAction,
          COUNT(1) AS count
        FROM activity_feed
        WHERE json_extract(activity_json, '$.metadata.txAction') IS NOT NULL
        GROUP BY json_extract(activity_json, '$.metadata.txAction')
      `)
      .all() as Array<{ txAction: string; count: number }>;

    const byTxAction: Record<string, number> = {};
    txActionStats.forEach((stat) => {
      byTxAction[stat.txAction] = stat.count;
    });

    // Get receive transactions with uncertainFrom status
    const receiveStats = db
      .prepare(`
        SELECT
          json_extract(activity_json, '$.metadata.uncertainFrom') AS uncertainFrom,
          COUNT(1) AS count
        FROM activity_feed
        WHERE json_extract(activity_json, '$.metadata.txAction') = 'receive'
        GROUP BY json_extract(activity_json, '$.metadata.uncertainFrom')
      `)
      .all() as Array<{ uncertainFrom: number | string | null; count: number }>;

    const isTruthySqliteBoolean = (value: number | string | null) =>
      value === 1 || value === '1' || value === 'true';

    const receiveWithUncertainFrom =
      receiveStats.find((s) => isTruthySqliteBoolean(s.uncertainFrom))?.count || 0;
    const receiveWithoutUncertainFrom =
      receiveStats.find((s) => !isTruthySqliteBoolean(s.uncertainFrom))?.count || 0;

    const databaseStats = {
      receiveTransactions: txActionStats.find((s) => s.txAction === 'receive')?.count || 0,
      receiveWithUncertainFrom,
      receiveWithoutUncertainFrom,
      byTxAction,
    };

    // Get snapshot before filter (fetch all to see full picture)
    const snapshotBeforeFilter = readFeedSnapshot(10000, 0, null);
    const apiResponseBeforeFilter = snapshotBeforeFilter.feed.length;

    // Get sample of items that would be filtered
    const sampleFilteredItems = db
      .prepare(`
        SELECT
          json_extract(activity_json, '$.metadata.txHash') AS txHash,
          json_extract(activity_json, '$.metadata.txAction') AS txAction,
          json_extract(activity_json, '$.metadata.uncertainFrom') AS uncertainFrom,
          json_extract(activity_json, '$.metadata.chain') AS chain,
          json_extract(activity_json, '$.metadata.fromAddress') AS fromAddress,
          json_extract(activity_json, '$.metadata.toAddress') AS toAddress,
          json_extract(activity_json, '$.metadata.token') AS token,
          json_extract(activity_json, '$.metadata.value') AS value,
          timestamp
        FROM activity_feed
        WHERE json_extract(activity_json, '$.metadata.txAction') = 'receive'
          AND json_extract(activity_json, '$.metadata.uncertainFrom') = 1
        ORDER BY timestamp DESC
        LIMIT 5
      `)
      .all() as Array<{
        txHash: string;
        txAction: string;
        uncertainFrom: number;
        chain: string;
        fromAddress: string;
        toAddress: string;
        token: string;
        value: string;
        timestamp: number;
      }>;

    // Build suspicious sender stats
    const senderFanOutStats = new Map<
      string,
      {
        transferCount: number;
        recipientAddresses: Set<string>;
      }
    >();

    const allReceiveItems = db
      .prepare(`
        SELECT
          json_extract(activity_json, '$.metadata.chain') AS chain,
          json_extract(activity_json, '$.metadata.fromAddress') AS fromAddress,
          json_extract(activity_json, '$.metadata.toAddress') AS toAddress,
          json_extract(user_json, '$.id') AS userId
        FROM activity_feed
        WHERE json_extract(activity_json, '$.metadata.txAction') = 'receive'
          AND json_extract(activity_json, '$.metadata.uncertainFrom') = 1
          AND json_extract(activity_json, '$.metadata.fromAddress') IS NOT NULL
          AND json_extract(activity_json, '$.metadata.toAddress') IS NOT NULL
      `)
      .all() as Array<{ chain: string; fromAddress: string; toAddress: string; userId: string }>;

    const normalize = (value: string | undefined) => (value || '').trim().toLowerCase();

    for (const item of allReceiveItems) {
      const chain = normalize(item.chain);
      const fromAddress = normalize(item.fromAddress);
      const toAddress = normalize(item.toAddress);
      if (!chain || !fromAddress || !toAddress) {
        continue;
      }
      const key = `${chain}|${fromAddress}`;
      const existing = senderFanOutStats.get(key) ?? {
        transferCount: 0,
        recipientAddresses: new Set<string>(),
      };
      existing.transferCount += 1;
      existing.recipientAddresses.add(toAddress);
      senderFanOutStats.set(key, existing);
    }

    const SNAPSHOT_POISON_SENDER_FANOUT_MIN_RECIPIENTS = 3;
    const SNAPSHOT_POISON_SENDER_FANOUT_MIN_TRANSFERS = 3;

    const suspiciousSenderKeys = new Set(
      Array.from(senderFanOutStats.entries())
        .filter(
          ([, value]) =>
            value.transferCount >= SNAPSHOT_POISON_SENDER_FANOUT_MIN_TRANSFERS &&
            value.recipientAddresses.size >= SNAPSHOT_POISON_SENDER_FANOUT_MIN_RECIPIENTS
        )
        .map(([key]) => key)
    );

    const sampleSuspiciousSenders = Array.from(suspiciousSenderKeys).slice(0, 10);

    const diagnosticResult: DiagnosticResult = {
      totalInDatabase: totalResult.count,
      apiResponseBeforeFilter,
      apiResponseAfterFilter: snapshotBeforeFilter.feed.length,
      suspiciousSendersCount: suspiciousSenderKeys.size,
      sampleSuspiciousSenders,
      sampleFilteredItems: sampleFilteredItems.map((item) => ({
        txHash: item.txHash,
        txAction: item.txAction,
        uncertainFrom: Boolean(item.uncertainFrom),
        chain: item.chain,
        fromAddress: item.fromAddress,
        toAddress: item.toAddress,
        token: item.token,
        value: item.value,
        timestamp: item.timestamp,
      })),
      databaseStats,
    };

    return NextResponse.json({
      ok: true,
      result: diagnosticResult,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '诊断失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
