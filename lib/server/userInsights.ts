import 'server-only';

import { getDb } from '@/lib/server/sqlite';
import type { SqlDatabase } from '@/lib/server/sqlite';

/**
 * User insights for the profile panel:
 *  - 作息: hourly activity histogram (blockchain + social feed combined),
 *    with inferred sleep window. Cached in app_state, refreshed every 7 days.
 *  - 历史战绩: top-10 closed (realized) PnL round trips from wallet_token_pnl.
 */

const SLEEP_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface SleepWindow {
  startHour: number;
  endHour: number;
}

export interface UserRoutineInsight {
  /** 24 buckets of event counts, index = Beijing hour 0-23. */
  hourlyCounts: number[];
  totalEvents: number;
  firstEventAt: number | null;
  lastEventAt: number | null;
  sleep: SleepWindow | null;
  computedAt: number;
}

export interface TopBattle {
  tokenSymbol: string;
  chain: string;
  realizedPnlUsd: number;
  realizedMultiple: number | null;
  buyUsd: number;
  sellUsd: number;
  openedAt: number;
  closedAt: number | null;
  confidence: string;
}

export interface UserBattlesInsight {
  battles: TopBattle[];
  totalClosedRounds: number;
  winsCount: number;
  lossesCount: number;
  totalRealizedPnlUsd: number;
}

export interface UserInsightsPayload {
  ok: true;
  routine: UserRoutineInsight;
  battles: UserBattlesInsight;
}

function readAppState(db: SqlDatabase, key: string): { value: unknown; updatedAt: number } | null {
  const row = db
    .prepare('SELECT value_json, updated_at FROM app_state WHERE key = ? LIMIT 1')
    .get(key) as { value_json: string; updated_at: number } | undefined;
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value_json), updatedAt: Number(row.updated_at) };
  } catch {
    return null;
  }
}

function writeAppState(db: SqlDatabase, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO app_state (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), Date.now());
}

/**
 * Find the longest contiguous low-activity window (>=5h, each hour below
 * 25% of the active-hour mean). Ties break toward windows ending near
 * midnight/morning hours. Returns null when the user has no clear quiet span.
 */
export function inferSleepWindow(hourlyCounts: number[]): SleepWindow | null {
  const total = hourlyCounts.reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  const activeHours = hourlyCounts.filter((c) => c > 0);
  if (activeHours.length < 12) return null; // not enough coverage to judge

  const mean = activeHours.reduce((a, b) => a + b, 0) / activeHours.length;
  const threshold = mean * 0.25;

  // Double the array so wrap-around windows are a single linear scan.
  let bestStart = -1;
  let bestLen = 0;
  let runStart = 0;
  for (let i = 0; i < 48; i += 1) {
    const quiet = hourlyCounts[i % 24] <= threshold;
    if (quiet) continue;
    const len = i - runStart;
    if (len > bestLen) {
      bestLen = len;
      bestStart = runStart % 24;
    }
    runStart = i + 1;
  }
  const tailLen = 48 - runStart;
  if (tailLen > bestLen) {
    bestLen = tailLen;
    bestStart = runStart % 24;
  }

  if (bestLen < 5 || bestLen >= 16) return null;
  return { startHour: bestStart, endHour: (bestStart + bestLen) % 24 };
}

export function computeUserRoutine(db: SqlDatabase, userId: string): UserRoutineInsight {
  const rows = db
    .prepare('SELECT timestamp FROM events WHERE user_id = ?')
    .all(userId) as Array<{ timestamp: number }>;

  const hourlyCounts = new Array<number>(24).fill(0);
  let firstEventAt: number | null = null;
  let lastEventAt: number | null = null;

  for (const row of rows) {
    const ts = Number(row.timestamp);
    if (!Number.isFinite(ts)) continue;
    const hour = Math.floor(((ts + BEIJING_OFFSET_MS) % 86_400_000) / 3_600_000);
    hourlyCounts[hour] += 1;
    if (firstEventAt == null || ts < firstEventAt) firstEventAt = ts;
    if (lastEventAt == null || ts > lastEventAt) lastEventAt = ts;
  }

  return {
    hourlyCounts,
    totalEvents: rows.length,
    firstEventAt,
    lastEventAt,
    sleep: inferSleepWindow(hourlyCounts),
    computedAt: Date.now(),
  };
}

export function getUserRoutine(db: SqlDatabase, userId: string): UserRoutineInsight {
  const cacheKey = `user_routine_v1:${userId}`;
  const cached = readAppState(db, cacheKey);
  if (cached && Date.now() - cached.updatedAt < SLEEP_CACHE_TTL_MS) {
    return cached.value as UserRoutineInsight;
  }
  const fresh = computeUserRoutine(db, userId);
  writeAppState(db, cacheKey, fresh);
  return fresh;
}

export function getUserBattles(db: SqlDatabase, userId: string): UserBattlesInsight {
  // 落袋为安: closed rounds only, ranked by realized PnL. All history — the
  // table is recomputed from full events by the pnl worker/backfill, no window.
  const rows = db
    .prepare(
      `SELECT token_symbol, chain, realized_pnl_usd, realized_multiple,
              buy_usd, sell_usd, opened_at, closed_at, confidence
       FROM wallet_token_pnl
       WHERE user_id = ? AND status = 'closed'
       ORDER BY realized_pnl_usd DESC
       LIMIT 10`,
    )
    .all(userId) as Array<Record<string, unknown>>;

  const statsRow = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN realized_pnl_usd > 0 THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN realized_pnl_usd < 0 THEN 1 ELSE 0 END) AS losses,
              SUM(realized_pnl_usd) AS totalPnl
       FROM wallet_token_pnl WHERE user_id = ? AND status = 'closed'`,
    )
    .get(userId) as Record<string, unknown>;

  const battles: TopBattle[] = rows.map((row) => ({
    tokenSymbol: String(row.token_symbol ?? '?'),
    chain: String(row.chain ?? ''),
    realizedPnlUsd: Number(row.realized_pnl_usd ?? 0),
    realizedMultiple: row.realized_multiple == null ? null : Number(row.realized_multiple),
    buyUsd: Number(row.buy_usd ?? 0),
    sellUsd: Number(row.sell_usd ?? 0),
    openedAt: Number(row.opened_at ?? 0),
    closedAt: row.closed_at == null ? null : Number(row.closed_at),
    confidence: String(row.confidence ?? 'complete'),
  }));

  return {
    battles,
    totalClosedRounds: Number(statsRow.total ?? 0),
    winsCount: Number(statsRow.wins ?? 0),
    lossesCount: Number(statsRow.losses ?? 0),
    totalRealizedPnlUsd: Number(statsRow.totalPnl ?? 0),
  };
}

export function getUserInsights(userId: string): UserInsightsPayload {
  const db = getDb();
  return {
    ok: true,
    routine: getUserRoutine(db, userId),
    battles: getUserBattles(db, userId),
  };
}
