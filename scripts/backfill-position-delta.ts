/**
 * Backfill positionDeltaRatio (+ open/close upgrades) for recent trades.
 *
 * Reads wallet×token series with lookback so pre-window inventory can seed %,
 * but only writes rows inside --days (default 14).
 *
 * Usage:
 *   npx tsx scripts/backfill-position-delta.ts --dry
 *   npx tsx scripts/backfill-position-delta.ts --force-prod-db
 *   npx tsx scripts/backfill-position-delta.ts --force-prod-db --days=14 --lookback-days=60
 *   npx tsx scripts/backfill-position-delta.ts --force-prod-db --force-recompute
 */

import './server-only-shim.cjs';

import { getDb } from '../lib/server/sqlite';
import { fillPositionDeltaRatios } from '../lib/tradeDisplay';
import type { Activity } from '../types';
import { exitIfProdDbHeavyJobBlocked } from './lib/prodDbGuard';

function parseArgs(argv: string[]) {
  let days = 14;
  let lookbackDays = 60;
  let dry = false;
  let forceProd = false;
  let forceRecompute = false;
  let limitSeries: number | null = null;
  for (const arg of argv) {
    if (arg.startsWith('--days=')) {
      const n = Number.parseInt(arg.slice('--days='.length), 10);
      if (Number.isFinite(n) && n > 0) days = n;
    } else if (arg.startsWith('--lookback-days=')) {
      const n = Number.parseInt(arg.slice('--lookback-days='.length), 10);
      if (Number.isFinite(n) && n > 0) lookbackDays = n;
    } else if (arg.startsWith('--limit-series=')) {
      const n = Number.parseInt(arg.slice('--limit-series='.length), 10);
      if (Number.isFinite(n) && n > 0) limitSeries = n;
    } else if (arg === '--dry') {
      dry = true;
    } else if (arg === '--force-prod-db') {
      forceProd = true;
    } else if (arg === '--force-recompute') {
      forceRecompute = true;
    }
  }
  if (lookbackDays < days) lookbackDays = days;
  return { days, lookbackDays, dry, forceProd, forceRecompute, limitSeries };
}

function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

function isTradeVariant(activity: Activity) {
  const variant = normalize(activity.metadata.txActionVariant);
  if (variant === 'open' || variant === 'add' || variant === 'reduce' || variant === 'close') {
    return true;
  }
  const label = normalize(activity.metadata.displayActionVariantLabel || activity.metadata.txActionLabel);
  return label === '建仓' || label === '加仓' || label === '减仓' || label === '清仓';
}

function seriesKey(activity: Activity) {
  const wallet = normalize(activity.metadata.trackedAddress);
  const chain = normalize(activity.metadata.chain);
  const token = normalize(activity.metadata.tokenAddress);
  if (!wallet || !chain || !token) return null;
  return `${chain}|${wallet}|${token}`;
}

function ratiosClose(a: number | null | undefined, b: number | null | undefined) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < 1e-9;
}

function sameText(a: string | null | undefined, b: string | null | undefined) {
  return normalize(a) === normalize(b);
}

type EventRow = {
  event_id: string;
  timestamp: number;
  activity_json: string;
  metadata_json: string;
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.forceProd) {
    process.env.PILIPILI_ALLOW_PROD_DB_HEAVY = '1';
  }
  exitIfProdDbHeavyJobBlocked({ jobName: 'backfill-position-delta' });

  const db = getDb();
  const now = Date.now();
  const writeSince = now - args.days * 86_400_000;
  const readSince = now - args.lookbackDays * 86_400_000;

  console.log(
    `[position-delta] days=${args.days} lookback=${args.lookbackDays} dry=${args.dry} forceRecompute=${args.forceRecompute}`
  );

  const rows = db
    .prepare(
      `SELECT event_id, timestamp, activity_json, metadata_json
       FROM events
       WHERE source = 'blockchain'
         AND timestamp >= ?
         AND (
           json_extract(activity_json, '$.metadata.txActionVariant') IN ('open', 'add', 'reduce', 'close')
           OR json_extract(activity_json, '$.metadata.displayActionVariantLabel') IN ('建仓', '加仓', '减仓', '清仓')
           OR json_extract(activity_json, '$.metadata.txActionLabel') IN ('建仓', '加仓', '减仓', '清仓')
         )
       ORDER BY timestamp ASC, event_id ASC`
    )
    .all(readSince) as EventRow[];

  console.log(`[position-delta] loaded=${rows.length}`);

  type WorkItem = {
    eventId: string;
    timestamp: number;
    activity: Activity;
    metadataJson: string;
    originalActivityJson: string;
  };

  const work: WorkItem[] = [];
  let parseFailed = 0;
  for (const row of rows) {
    let activity: Activity;
    try {
      activity = JSON.parse(row.activity_json) as Activity;
    } catch {
      parseFailed += 1;
      continue;
    }
    if (!isTradeVariant(activity)) continue;
    if (!seriesKey(activity)) continue;
    if (args.forceRecompute) {
      delete activity.metadata.positionDeltaRatio;
    }
    work.push({
      eventId: row.event_id,
      timestamp: row.timestamp,
      activity,
      metadataJson: row.metadata_json,
      originalActivityJson: row.activity_json,
    });
  }

  console.log(`[position-delta] tradeRows=${work.length} parseFailed=${parseFailed}`);

  const filled = fillPositionDeltaRatios(work.map((item) => ({ activity: item.activity })));

  const updateStmt = db.prepare(
    `UPDATE events
     SET activity_json = ?, metadata_json = ?, updated_at = ?
     WHERE event_id = ?`
  );

  let candidates = 0;
  let updated = 0;
  let skippedUnchanged = 0;
  let skippedOutsideWindow = 0;
  let ratioFilled = 0;
  let openUpgraded = 0;
  let closeUpgraded = 0;
  let seriesTouched = 0;

  const bySeries = new Map<string, number>();
  const nowMs = Date.now();

  const applyBatch = db.transaction((patches: Array<{ eventId: string; activityJson: string; metadataJson: string }>) => {
    for (const patch of patches) {
      updateStmt.run(patch.activityJson, patch.metadataJson, nowMs, patch.eventId);
    }
  });

  const pending: Array<{ eventId: string; activityJson: string; metadataJson: string }> = [];

  for (let i = 0; i < work.length; i += 1) {
    const before = work[i]!;
    const afterActivity = filled[i]!.activity;
    const beforeMeta = before.activity.metadata;
    // restore original activity for comparison if force stripped ratio
    let originalActivity: Activity;
    try {
      originalActivity = JSON.parse(before.originalActivityJson) as Activity;
    } catch {
      originalActivity = before.activity;
    }
    const origMeta = originalActivity.metadata;

    const ratioChanged = !ratiosClose(origMeta.positionDeltaRatio, afterActivity.metadata.positionDeltaRatio);
    const variantChanged =
      !sameText(origMeta.txActionVariant, afterActivity.metadata.txActionVariant) ||
      !sameText(origMeta.txActionLabel, afterActivity.metadata.txActionLabel) ||
      !sameText(origMeta.displayActionVariantLabel, afterActivity.metadata.displayActionVariantLabel);

    if (!ratioChanged && !variantChanged) {
      skippedUnchanged += 1;
      continue;
    }

    if (before.timestamp < writeSince) {
      skippedOutsideWindow += 1;
      continue;
    }

    candidates += 1;
    const key = seriesKey(afterActivity) || 'unknown';
    bySeries.set(key, (bySeries.get(key) || 0) + 1);

    if (ratioChanged && typeof afterActivity.metadata.positionDeltaRatio === 'number') {
      ratioFilled += 1;
    }
    if (normalize(origMeta.txActionVariant) !== 'open' && normalize(afterActivity.metadata.txActionVariant) === 'open') {
      openUpgraded += 1;
    }
    if (normalize(origMeta.txActionVariant) !== 'close' && normalize(afterActivity.metadata.txActionVariant) === 'close') {
      closeUpgraded += 1;
    }

    // Keep non-metadata fields; only patch metadata fields we compute.
    const nextActivity: Activity = {
      ...originalActivity,
      metadata: {
        ...origMeta,
        ...afterActivity.metadata,
      },
    };
    const nextActivityJson = JSON.stringify(nextActivity);

    let nextMetadataJson = before.metadataJson;
    try {
      const parsedMeta = JSON.parse(before.metadataJson || '{}') as Record<string, unknown>;
      nextMetadataJson = JSON.stringify({
        ...parsedMeta,
        ...nextActivity.metadata,
      });
    } catch {
      nextMetadataJson = JSON.stringify(nextActivity.metadata || {});
    }

    if (!args.dry) {
      pending.push({
        eventId: before.eventId,
        activityJson: nextActivityJson,
        metadataJson: nextMetadataJson,
      });
      if (pending.length >= 400) {
        applyBatch(pending.splice(0, pending.length));
        updated += 400;
        if (updated % 2000 === 0) {
          console.log(`[position-delta] updated=${updated} candidates=${candidates}`);
        }
      }
    } else {
      updated += 1;
    }
  }

  if (!args.dry && pending.length > 0) {
    applyBatch(pending);
    updated += pending.length;
  }

  seriesTouched = bySeries.size;
  if (args.limitSeries != null) {
    // reserved flag for future scoped runs; currently full scan.
  }

  console.log(
    JSON.stringify(
      {
        dry: args.dry,
        writeSince,
        readSince,
        loaded: rows.length,
        tradeRows: work.length,
        candidates,
        updated,
        skippedUnchanged,
        skippedOutsideWindow,
        ratioFilled,
        openUpgraded,
        closeUpgraded,
        seriesTouched,
      },
      null,
      2
    )
  );
}

main();
