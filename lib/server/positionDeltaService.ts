import 'server-only';

import { getDb, withTransaction } from '@/lib/server/sqlite';
import { fillPositionDeltaRatios } from '@/lib/tradeDisplay';
import type { Activity } from '@/types';

/**
 * Server-side owner of `positionDeltaRatio`.
 *
 * The client can only see its currently loaded feed window, so any ratio it
 * derives there is a guess that shifts as you scroll (it renders with a `~`).
 * Here we read a wide lookback so pre-window inventory can seed the balance,
 * which makes the written ratio stable and authoritative — once persisted, the
 * client keeps it as-is and drops the `~`.
 */

export interface PositionDeltaFillOptions {
  /** Only write rows newer than this many days. */
  days?: number;
  /** Read this far back so pre-window inventory can seed balances. */
  lookbackDays?: number;
  /** Compute + report without writing. */
  dry?: boolean;
  /** Drop existing ratios and recompute from scratch. */
  forceRecompute?: boolean;
}

export interface PositionDeltaFillResult {
  writeSince: number;
  readSince: number;
  loaded: number;
  tradeRows: number;
  candidates: number;
  updated: number;
  skippedUnchanged: number;
  skippedOutsideWindow: number;
  ratioFilled: number;
  openUpgraded: number;
  closeUpgraded: number;
  seriesTouched: number;
  parseFailed: number;
}

const WRITE_BATCH_SIZE = 400;

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

interface EventRow {
  event_id: string;
  timestamp: number;
  activity_json: string;
  metadata_json: string;
}

interface WorkItem {
  eventId: string;
  timestamp: number;
  activity: Activity;
  metadataJson: string;
  originalActivityJson: string;
}

export function runPositionDeltaFill(options: PositionDeltaFillOptions = {}): PositionDeltaFillResult {
  const days = options.days && options.days > 0 ? options.days : 14;
  const lookbackDays = Math.max(options.lookbackDays && options.lookbackDays > 0 ? options.lookbackDays : 60, days);
  const dry = options.dry === true;
  const forceRecompute = options.forceRecompute === true;

  const db = getDb();
  const now = Date.now();
  const writeSince = now - days * 86_400_000;
  const readSince = now - lookbackDays * 86_400_000;

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
    if (forceRecompute) {
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

  // No markEstimated here: a full-history read makes these authoritative.
  const filled = fillPositionDeltaRatios(work.map((item) => ({ activity: item.activity })));

  let candidates = 0;
  let updated = 0;
  let skippedUnchanged = 0;
  let skippedOutsideWindow = 0;
  let ratioFilled = 0;
  let openUpgraded = 0;
  let closeUpgraded = 0;

  const bySeries = new Set<string>();
  const pending: Array<{ eventId: string; activityJson: string; metadataJson: string }> = [];

  const flush = () => {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    withTransaction(() => {
      const handle = getDb();
      const updateStmt = handle.prepare(
        `UPDATE events
         SET activity_json = ?, metadata_json = ?, updated_at = ?
         WHERE event_id = ?`
      );
      const writtenAt = Date.now();
      for (const patch of batch) {
        updateStmt.run(patch.activityJson, patch.metadataJson, writtenAt, patch.eventId);
      }
    });
    updated += batch.length;
  };

  for (let index = 0; index < work.length; index += 1) {
    const before = work[index]!;
    const afterActivity = filled[index]!.activity;

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
    bySeries.add(seriesKey(afterActivity) || 'unknown');

    if (ratioChanged && typeof afterActivity.metadata.positionDeltaRatio === 'number') {
      ratioFilled += 1;
    }
    if (normalize(origMeta.txActionVariant) !== 'open' && normalize(afterActivity.metadata.txActionVariant) === 'open') {
      openUpgraded += 1;
    }
    if (normalize(origMeta.txActionVariant) !== 'close' && normalize(afterActivity.metadata.txActionVariant) === 'close') {
      closeUpgraded += 1;
    }

    if (dry) {
      updated += 1;
      continue;
    }

    // Keep non-metadata fields; only patch metadata fields we compute.
    const nextActivity: Activity = {
      ...originalActivity,
      metadata: {
        ...origMeta,
        ...afterActivity.metadata,
      },
    };

    let nextMetadataJson: string;
    try {
      const parsedMeta = JSON.parse(before.metadataJson || '{}') as Record<string, unknown>;
      nextMetadataJson = JSON.stringify({ ...parsedMeta, ...nextActivity.metadata });
    } catch {
      nextMetadataJson = JSON.stringify(nextActivity.metadata || {});
    }

    pending.push({
      eventId: before.eventId,
      activityJson: JSON.stringify(nextActivity),
      metadataJson: nextMetadataJson,
    });

    if (pending.length >= WRITE_BATCH_SIZE) {
      flush();
    }
  }

  flush();

  return {
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
    seriesTouched: bySeries.size,
    parseFailed,
  };
}

const CYCLE_INTERVAL_MS = 10 * 60_000;
const CYCLE_WRITE_DAYS = 3;
const CYCLE_LOOKBACK_DAYS = 60;

/** Recurring pass so fresh trades get an authoritative ratio without a manual backfill. */
export async function runPositionDeltaCycle(): Promise<{
  sleepMs: number;
  status: string;
  detail: Record<string, unknown>;
}> {
  const result = runPositionDeltaFill({
    days: CYCLE_WRITE_DAYS,
    lookbackDays: CYCLE_LOOKBACK_DAYS,
  });

  return {
    sleepMs: CYCLE_INTERVAL_MS,
    status: 'ok',
    detail: {
      tradeRows: result.tradeRows,
      updated: result.updated,
      ratioFilled: result.ratioFilled,
      openUpgraded: result.openUpgraded,
      closeUpgraded: result.closeUpgraded,
      seriesTouched: result.seriesTouched,
    },
  };
}
