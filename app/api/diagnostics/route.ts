import { NextResponse } from 'next/server';

import { getDb } from '@/lib/server/sqlite';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DiagnosticSourceMode = 'parser' | 'telegram';

interface DiagnosticResult {
  sourceMode: DiagnosticSourceMode;
  totalInDatabase: number;
  apiResponseBeforeFilter: number;
  apiResponseAfterFilter: number;
  suspiciousSendersCount: number;
  sampleSuspiciousSenders: string[];
  hiddenByMinUsdCount: number;
  pendingValuationCount: number;
  filterReasonStats: Record<string, number>;
  sampleHiddenOrPendingItems: Array<{
    txHash: string;
    decision: string;
    reasonCode: string;
    reasonText: string;
    computedUsdValue: number | null;
    txAction: string;
    chain: string;
    token: string;
    value: string;
    quoteToken: string;
    quoteAmount: string;
    fromAddress: string;
    toAddress: string;
    timestamp: number | null;
  }>;
  databaseStats: {
    judgmentCount: number;
    visibleCount: number;
    hiddenCount: number;
    pendingCount: number;
    receiveTransactions: number;
    receiveWithUncertainFrom: number;
    receiveWithoutUncertainFrom: number;
    byTxAction: Record<string, number>;
    byDecision: Record<string, number>;
  };
}

function normalize(value: string | undefined | null) {
  return (value || '').trim().toLowerCase();
}

function getDiagnosticSourceMode(): DiagnosticSourceMode {
  const mode =
    process.env.FEED_SOURCE_MODE?.trim().toLowerCase() ||
    process.env.NEXT_PUBLIC_FEED_SOURCE_MODE?.trim().toLowerCase() ||
    '';
  return mode === 'telegram' ? 'telegram' : 'parser';
}

export async function GET() {
  try {
    const db = getDb();
    const sourceMode = getDiagnosticSourceMode();

    if (sourceMode === 'telegram') {
      const telegramTotalRow = db.prepare(
        "SELECT COUNT(1) AS count FROM telegram_monitor_events WHERE provider = 'xxyy'"
      ).get() as { count: number };

      const total = telegramTotalRow.count;
      const result: DiagnosticResult = {
        sourceMode,
        totalInDatabase: total,
        apiResponseBeforeFilter: total,
        apiResponseAfterFilter: total,
        suspiciousSendersCount: 0,
        sampleSuspiciousSenders: [],
        hiddenByMinUsdCount: 0,
        pendingValuationCount: 0,
        filterReasonStats: {},
        sampleHiddenOrPendingItems: [],
        databaseStats: {
          judgmentCount: 0,
          visibleCount: total,
          hiddenCount: 0,
          pendingCount: 0,
          receiveTransactions: 0,
          receiveWithUncertainFrom: 0,
          receiveWithoutUncertainFrom: 0,
          byTxAction: {},
          byDecision: {
            visible: total,
            hidden: 0,
            pending: 0,
          },
        },
      };

      return NextResponse.json({ ok: true, result });
    }

    const totalResult = db.prepare('SELECT COUNT(1) AS count FROM activity_feed').get() as { count: number };
    const judgmentCountRow = db
      .prepare('SELECT COUNT(1) AS count FROM activity_judgments')
      .get() as { count: number };

    const txActionStats = db
      .prepare(`
        SELECT tx_action AS txAction, COUNT(1) AS count
        FROM activity_judgments
        WHERE tx_action IS NOT NULL
        GROUP BY tx_action
      `)
      .all() as Array<{ txAction: string; count: number }>;

    const byTxAction: Record<string, number> = {};
    txActionStats.forEach((stat) => {
      byTxAction[stat.txAction] = stat.count;
    });

    const decisionStats = db
      .prepare(`
        SELECT decision, COUNT(1) AS count
        FROM activity_judgments
        WHERE decision IS NOT NULL
        GROUP BY decision
      `)
      .all() as Array<{ decision: string; count: number }>;

    const byDecision: Record<string, number> = {};
    decisionStats.forEach((stat) => {
      byDecision[stat.decision] = stat.count;
    });

    const receiveStats = db
      .prepare(`
        SELECT uncertain_from AS uncertainFrom, COUNT(1) AS count
        FROM activity_judgments
        WHERE tx_action = 'receive'
        GROUP BY uncertain_from
      `)
      .all() as Array<{ uncertainFrom: number; count: number }>;

    const receiveWithUncertainFrom = receiveStats.find((s) => s.uncertainFrom === 1)?.count || 0;
    const receiveWithoutUncertainFrom = receiveStats.find((s) => s.uncertainFrom !== 1)?.count || 0;

    const hiddenByMinUsdRow = db
      .prepare(`
        SELECT COUNT(1) AS count
        FROM activity_judgments
        WHERE decision = 'hidden' AND reason_code = 'below_min_usd'
      `)
      .get() as { count: number };

    const pendingValuationRow = db
      .prepare(`
        SELECT COUNT(1) AS count
        FROM activity_judgments
        WHERE decision = 'pending' AND reason_code = 'pending_valuation'
      `)
      .get() as { count: number };

    const reasonRows = db
      .prepare(`
        SELECT reason_code AS reasonCode, COUNT(1) AS count
        FROM activity_judgments
        WHERE reason_code IS NOT NULL
        GROUP BY reason_code
      `)
      .all() as Array<{ reasonCode: string; count: number }>;

    const filterReasonStats: Record<string, number> = {};
    reasonRows.forEach((row) => {
      filterReasonStats[row.reasonCode] = row.count;
    });

    const sampleHiddenOrPendingItems = db
      .prepare(`
        SELECT
          tx_hash AS txHash,
          decision,
          reason_code AS reasonCode,
          reason_text AS reasonText,
          computed_usd_value AS computedUsdValue,
          tx_action AS txAction,
          chain,
          token,
          value,
          quote_token AS quoteToken,
          quote_amount AS quoteAmount,
          from_address AS fromAddress,
          to_address AS toAddress,
          tx_time AS timestamp
        FROM activity_judgments
        WHERE decision <> 'visible'
        ORDER BY COALESCE(tx_time, updated_at) DESC
        LIMIT 10
      `)
      .all() as Array<{
        txHash: string;
        decision: string;
        reasonCode: string;
        reasonText: string;
        computedUsdValue: number | null;
        txAction: string;
        chain: string;
        token: string;
        value: string;
        quoteToken: string;
        quoteAmount: string;
        fromAddress: string;
        toAddress: string;
        timestamp: number | null;
      }>;

    const senderFanOutStats = new Map<
      string,
      {
        transferCount: number;
        recipientAddresses: Set<string>;
      }
    >();

    const allReceiveItems = db
      .prepare(`
        SELECT chain, from_address AS fromAddress, to_address AS toAddress
        FROM activity_judgments
        WHERE tx_action = 'receive'
          AND uncertain_from = 1
          AND from_address IS NOT NULL
      `)
      .all() as Array<{ chain: string; fromAddress: string; toAddress: string }>;

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

    const suspiciousSenderKeys = new Set(
      Array.from(senderFanOutStats.entries())
        .filter(([, value]) => value.transferCount >= 3 && value.recipientAddresses.size >= 3)
        .map(([key]) => key)
    );

    const visibleCount = byDecision.visible ?? 0;
    const diagnosticResult: DiagnosticResult = {
      sourceMode,
      totalInDatabase: totalResult.count,
      apiResponseBeforeFilter: judgmentCountRow.count,
      apiResponseAfterFilter: visibleCount,
      suspiciousSendersCount: suspiciousSenderKeys.size,
      sampleSuspiciousSenders: Array.from(suspiciousSenderKeys).slice(0, 10),
      hiddenByMinUsdCount: hiddenByMinUsdRow.count,
      pendingValuationCount: pendingValuationRow.count,
      filterReasonStats,
      sampleHiddenOrPendingItems,
      databaseStats: {
        judgmentCount: judgmentCountRow.count,
        visibleCount,
        hiddenCount: byDecision.hidden ?? 0,
        pendingCount: byDecision.pending ?? 0,
        receiveTransactions: byTxAction.receive ?? 0,
        receiveWithUncertainFrom,
        receiveWithoutUncertainFrom,
        byTxAction,
        byDecision,
      },
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
