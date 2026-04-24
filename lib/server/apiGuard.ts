import 'server-only';

import { NextRequest, NextResponse } from 'next/server';

import { readAdminTokenFromRequest, verifyAdminRequest } from '@/lib/server/adminAuth';
import { checkAdminRateLimit } from '@/lib/server/adminRateLimit';

export function requireAdmin(request: NextRequest) {
  const auth = verifyAdminRequest(request);
  if (auth.ok) {
    return null;
  }

  if (auth.reason === 'missing_admin_token') {
    return NextResponse.json(
      {
        ok: false,
        error: '服务端未配置 ADMIN_API_TOKEN，管理接口已锁定。',
      },
      { status: 503 }
    );
  }

  return NextResponse.json(
    {
      ok: false,
      error: 'unauthorized',
    },
    { status: 401 }
  );
}

export function enforceAdminRateLimit(
  request: NextRequest,
  params: {
    endpoint: string;
    max: number;
    windowMs: number;
  }
) {
  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '';
  const sourceKey =
    readAdminTokenFromRequest(request) ||
    forwardedFor ||
    request.headers.get('x-real-ip')?.trim() ||
    'anonymous';

  const result = checkAdminRateLimit({
    endpoint: params.endpoint,
    key: sourceKey,
    max: params.max,
    windowMs: params.windowMs,
  });

  if (result.allowed) {
    return null;
  }

  const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  return NextResponse.json(
    {
      ok: false,
      error: 'rate_limited',
      retryAfterSeconds,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSeconds),
      },
    }
  );
}
