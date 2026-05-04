import { NextResponse } from 'next/server';

import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import { getDb } from '@/lib/server/sqlite';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;

interface ActivityStatsRow {
  social_count_7d: number;
  wallet_count_7d: number;
  total_count_7d: number;
  total_count_all: number;
}

export async function GET() {
  const nowMs = Date.now();
  const sinceMs = nowMs - WINDOW_7D_MS;
  const users = listTrackedUsers();
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT
         user_id,
         CAST(SUM(CASE WHEN timestamp >= ? AND source IN ('twitter', 'telegram') THEN 1 ELSE 0 END) AS INTEGER) AS social_count_7d,
         CAST(SUM(CASE WHEN timestamp >= ? AND source = 'blockchain' THEN 1 ELSE 0 END) AS INTEGER) AS wallet_count_7d,
         CAST(SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) AS INTEGER) AS total_count_7d,
         CAST(COUNT(1) AS INTEGER) AS total_count_all
       FROM events
       GROUP BY user_id`
    )
    .all(sinceMs, sinceMs, sinceMs) as Array<{ user_id: string } & ActivityStatsRow>;

  const rowByUserId = new Map(rows.map((row) => [row.user_id, row] as const));
  const statsByUserId: Record<
    string,
    {
      socialCount7d: number;
      walletCount7d: number;
      totalCount7d: number;
      totalCountAll: number;
    }
  > = {};

  for (const user of users) {
    const row = rowByUserId.get(user.id);
    statsByUserId[user.id] = {
      socialCount7d: row?.social_count_7d ?? 0,
      walletCount7d: row?.wallet_count_7d ?? 0,
      totalCount7d: row?.total_count_7d ?? 0,
      totalCountAll: row?.total_count_all ?? 0,
    };
  }

  return NextResponse.json({
    ok: true,
    sinceMs,
    statsByUserId,
  });
}
