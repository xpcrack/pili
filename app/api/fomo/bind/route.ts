import { NextRequest } from '@/lib/server/httpCompat';

import { requireAdmin } from '@/lib/server/apiGuard';
import { apiError, apiOk } from '@/lib/server/apiResponse';
import {
  bindFomoIdentity,
  findTrackedUserByFomoHandle,
  listFomoBoundUsers,
} from '@/lib/server/fomoRepo';
import { fetchUserByHandle, fetchFuzzySearch } from '@/lib/server/fomoClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/fomo/bind —— 列出已绑定 FOMO 身份的用户。 */
export async function GET(request: NextRequest) {
  const unauthorizedResponse = requireAdmin(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  try {
    return apiOk({ users: listFomoBoundUsers() });
  } catch (error) {
    return apiError(error, { fallback: '读取 FOMO 绑定失败' });
  }
}

/**
 * POST /api/fomo/bind —— 绑定/解绑 FOMO 身份。
 * Body: { userId, fomoHandle } 或 { userId, fomoUserId, fomoHandle }
 * 只给 fomoHandle 时先调 FOMO API 解析出 fomoUserId。
 */
export async function POST(request: NextRequest) {
  const unauthorizedResponse = requireAdmin(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  try {
    const body = await request.json().catch(() => null);
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    const fomoHandle = typeof body?.fomoHandle === 'string' ? body.fomoHandle.trim() : '';
    let fomoUserId = typeof body?.fomoUserId === 'string' ? body.fomoUserId.trim() : '';

    if (!userId) {
      return apiError('缺少 userId', { status: 400 });
    }

    // 解绑：fomoHandle 与 fomoUserId 均为空字符串。
    if (!fomoHandle && !fomoUserId) {
      const unbound = bindFomoIdentity({ userId, fomoUserId: '', fomoHandle: '' });
      return apiOk({ unbound, user: null });
    }

    if (!fomoUserId) {
      if (!fomoHandle) {
        return apiError('缺少 fomoHandle 或 fomoUserId', { status: 400 });
      }
      const resolved = await fetchUserByHandle(fomoHandle);
      fomoUserId = resolved?.user?.id ?? '';
      if (!fomoUserId) {
        return apiError(`无法解析 FOMO handle: ${fomoHandle}`, { status: 404 });
      }
    }

    const bound = bindFomoIdentity({ userId, fomoUserId, fomoHandle });
    if (!bound) {
      return apiError(`tracked_users 中不存在 id=${userId}`, { status: 404 });
    }
    return apiOk({ bound: true, userId, fomoUserId, fomoHandle });
  } catch (error) {
    return apiError(error, { fallback: '绑定 FOMO 身份失败' });
  }
}

/** PUT /api/fomo/bind —— 按 fomo handle 模糊搜索候选（人工确认前的一步）。 */
export async function PUT(request: NextRequest) {
  const unauthorizedResponse = requireAdmin(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  try {
    const body = await request.json().catch(() => null);
    const query = typeof body?.query === 'string' ? body.query.trim() : '';
    if (!query) {
      return apiError('缺少 query', { status: 400 });
    }
    const candidates = await fetchFuzzySearch(query);
    // 顺带给出本地 tracked_users 的宽松匹配，方便人工对齐。
    const localMatch = findTrackedUserByFomoHandle(query);
    return apiOk({ candidates, localMatch: localMatch ?? null });
  } catch (error) {
    return apiError(error, { fallback: 'FOMO 搜索失败' });
  }
}
