import { NextRequest } from '@/lib/server/httpCompat';

import { requireAdmin } from '@/lib/server/apiGuard';
import { apiError, apiOk } from '@/lib/server/apiResponse';
import { getDb } from '@/lib/server/sqlite';
import { runFomoTradesCycle, runFomoPositionsCycle, runFomoStatsCycle } from '@/lib/server/fomoRuntime';
import { listFomoBoundUsers } from '@/lib/server/fomoRepo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FOMO_JWT_STATE_KEY = 'fomo_jwt';

/** GET /api/fomo/status —— JWT 是否已配置（不回传 token 值）+ 绑定数。 */
export async function GET() {
  try {
    const row = getDb()
      .prepare('SELECT value_json, updated_at FROM app_state WHERE key = ? LIMIT 1')
      .get(FOMO_JWT_STATE_KEY) as { value_json: string; updated_at: number } | undefined;
    let configured = false;
    let updatedAt: number | null = null;
    if (row) {
      try {
        const parsed = JSON.parse(row.value_json) as { jwt?: string };
        configured = Boolean(parsed.jwt && parsed.jwt.length > 20);
      } catch {
        configured = false;
      }
      updatedAt = row.updated_at ?? null;
    }
    return apiOk({
      jwtConfigured: configured,
      jwtUpdatedAt: updatedAt,
      boundUserCount: listFomoBoundUsers().length,
    });
  } catch (error) {
    return apiError(error, { fallback: '读取 FOMO 状态失败' });
  }
}

/** POST /api/fomo/status —— 手动触发一轮采集。Body: { action: 'trades'|'positions'|'stats' } */
export async function POST(request: NextRequest) {
  const unauthorizedResponse = requireAdmin(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  try {
    const body = await request.json().catch(() => ({}));
    const action = typeof body?.action === 'string' ? body.action : 'trades';
    if (action === 'trades') {
      return apiOk({ action, result: await runFomoTradesCycle() });
    }
    if (action === 'positions') {
      return apiOk({ action, result: await runFomoPositionsCycle() });
    }
    if (action === 'stats') {
      return apiOk({ action, result: await runFomoStatsCycle() });
    }
    return apiError(`未知 action: ${action}`, { status: 400 });
  } catch (error) {
    return apiError(error, { fallback: 'FOMO 手动采集失败' });
  }
}
