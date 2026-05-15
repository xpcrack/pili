import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

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

function parseBearerToken(headerValue: string | null) {
  const value = (headerValue || '').trim();
  if (!value.toLowerCase().startsWith('bearer ')) {
    return '';
  }
  return value.slice(7).trim();
}

function safeCompare(expected: string, provided: string) {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  if (expectedBytes.length !== providedBytes.length) {
    return false;
  }
  return timingSafeEqual(expectedBytes, providedBytes);
}

export function requireAgent(request: NextRequest) {
  const expected = (process.env.AGENT_API_TOKEN || '').trim();
  if (!expected) {
    return NextResponse.json(
      {
        ok: false,
        error: '服务端未配置 AGENT_API_TOKEN，agent 接口已锁定。',
      },
      { status: 503 }
    );
  }

  const provided = parseBearerToken(request.headers.get('authorization'));
  if (!provided || !safeCompare(expected, provided)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'unauthorized',
      },
      { status: 401 }
    );
  }

  return null;
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
