import 'server-only';

import { NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

function normalizeEnvValue(value: string | undefined | null) {
  return (value || '').trim();
}

function safeCompare(expected: string, provided: string) {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  if (expectedBytes.length !== providedBytes.length) {
    return false;
  }
  return timingSafeEqual(expectedBytes, providedBytes);
}

function parseBearerToken(headerValue: string | null) {
  const value = (headerValue || '').trim();
  if (!value.toLowerCase().startsWith('bearer ')) {
    return '';
  }
  return value.slice(7).trim();
}

export function getConfiguredAdminToken() {
  return normalizeEnvValue(process.env.ADMIN_API_TOKEN);
}

export function readAdminTokenFromRequest(request: NextRequest) {
  const fromBearer = parseBearerToken(request.headers.get('authorization'));
  if (fromBearer) {
    return fromBearer;
  }
  return normalizeEnvValue(request.headers.get('x-admin-token'));
}

export function verifyAdminRequest(request: NextRequest) {
  const expected = getConfiguredAdminToken();
  if (!expected) {
    return {
      ok: false as const,
      reason: 'missing_admin_token' as const,
    };
  }

  const provided = readAdminTokenFromRequest(request);
  if (!provided || !safeCompare(expected, provided)) {
    return {
      ok: false as const,
      reason: 'unauthorized' as const,
    };
  }

  return {
    ok: true as const,
    reason: null,
  };
}
