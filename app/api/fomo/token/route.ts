import { NextRequest } from '@/lib/server/httpCompat';

import { requireAdmin } from '@/lib/server/apiGuard';
import { apiError, apiOk } from '@/lib/server/apiResponse';
import { setFomoJwt, FomoApiError } from '@/lib/server/fomoClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/fomo/token —— 接收浏览器插件推送的新 JWT。
 * Body: { jwt: string }
 */
export async function POST(request: NextRequest) {
  const unauthorizedResponse = requireAdmin(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  try {
    const body = await request.json().catch(() => null);
    const jwt = typeof body?.jwt === 'string' ? body.jwt.trim() : '';
    if (!jwt) {
      return apiError('缺少 jwt 字段', { status: 400 });
    }
    await setFomoJwt(jwt);
    return apiOk({ updated: true });
  } catch (error) {
    if (error instanceof FomoApiError) {
      return apiError(error.message, { status: 502 });
    }
    return apiError(error, { fallback: '保存 FOMO JWT 失败' });
  }
}
