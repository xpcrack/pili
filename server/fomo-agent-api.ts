import { Hono } from 'hono';

import { NextRequest } from '@/lib/server/httpCompat';
import { requireAgent } from '@/lib/server/apiGuard';
import { getDb } from '@/lib/server/sqlite';

/**
 * FOMO agent API —— 给 newone 消费。
 * 鉴权与 /agent/opportunities 相同（AGENT_API_TOKEN Bearer）。
 *
 * GET /api/agent/fomo/trades?userId=&limit=  —— 最近成交（含喊单 comment）
 * GET /api/agent/fomo/positions?userId=      —— 每用户最新一轮持仓快照
 * GET /api/agent/fomo/stats                  —— 全部绑定用户的最新 7d 战绩
 */

function readFomoBoundRows() {
  return getDb()
    .prepare(
      `SELECT id, name, handle, fomo_user_id, fomo_handle
       FROM tracked_users
       WHERE fomo_user_id IS NOT NULL AND fomo_user_id != ''`
    )
    .all() as Array<{
    id: string;
    name: string;
    handle: string;
    fomo_user_id: string;
    fomo_handle: string;
  }>;
}

export function registerFomoAgentRoutes(app: Hono) {
  const agent = new Hono();

  agent.use('*', async (c, next) => {
    const unauthorized = requireAgent(new NextRequest(c.req.raw));
    if (unauthorized) {
      return unauthorized;
    }
    c.header('Cache-Control', 'no-store');
    await next();
  });

  // 每用户最新成交
  agent.get('/fomo/trades', (c) => {
    const boundRows = readFomoBoundRows();
    if (boundRows.length === 0) {
      return c.json({ ok: true, trades: [] });
    }

    const userIdParam = c.req.query('userId')?.trim() || '';
    const limitParam = Number(c.req.query('limit') ?? '50');
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;

    const piliUserId = userIdParam
      ? boundRows.find((row) => row.fomo_user_id === userIdParam || row.id === userIdParam)?.id
      : null;
    if (userIdParam && !piliUserId) {
      return c.json({ ok: false, error: 'userId 未绑定 FOMO' }, 404);
    }

    const rows = (
      piliUserId
        ? getDb()
            .prepare(
              `SELECT * FROM fomo_trades WHERE user_id = ? ORDER BY COALESCE(closed_at, opened_at, created_at) DESC LIMIT ?`
            )
            .all(piliUserId, limit)
        : getDb()
            .prepare(
              `SELECT * FROM fomo_trades ORDER BY COALESCE(closed_at, opened_at, created_at) DESC LIMIT ?`
            )
            .all(limit)
    ) as Array<Record<string, unknown>>;

    return c.json({ ok: true, trades: rows });
  });

  // 每用户每代币最新一轮持仓
  agent.get('/fomo/positions', (c) => {
    const rows = getDb()
      .prepare(
        `SELECT s.*
         FROM fomo_position_snapshots s
         JOIN (
           SELECT user_id, token_address, MAX(snapshot_at) AS max_at
           FROM fomo_position_snapshots
           GROUP BY user_id, token_address
         ) latest
         ON s.user_id = latest.user_id
        AND s.token_address = latest.token_address
        AND s.snapshot_at = latest.max_at
         ORDER BY s.value_usd DESC`
      )
      .all() as Array<Record<string, unknown>>;
    return c.json({ ok: true, positions: rows });
  });

  // 最新 7d 战绩
  agent.get('/fomo/stats', (c) => {
    const rows = getDb()
      .prepare(`SELECT * FROM fomo_user_stats ORDER BY realized_pnl_7d_usd DESC`)
      .all() as Array<Record<string, unknown>>;
    return c.json({ ok: true, stats: rows });
  });

  app.route('/agent', agent);
}
