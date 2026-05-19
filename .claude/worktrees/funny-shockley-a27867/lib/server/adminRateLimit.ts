import 'server-only';

interface AdminRateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, AdminRateLimitEntry>();

function cleanupExpired(now: number) {
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetAt <= now) {
      rateLimitStore.delete(key);
    }
  }
}

function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

export function checkAdminRateLimit(params: {
  endpoint: string;
  key: string;
  max: number;
  windowMs: number;
}) {
  const now = Date.now();
  cleanupExpired(now);

  const endpoint = normalize(params.endpoint);
  const key = normalize(params.key);
  const max = Math.max(1, Math.floor(params.max));
  const windowMs = Math.max(1000, Math.floor(params.windowMs));
  const bucket = `${endpoint}|${key || 'anonymous'}`;

  const current = rateLimitStore.get(bucket);
  if (!current || current.resetAt <= now) {
    const resetAt = now + windowMs;
    rateLimitStore.set(bucket, { count: 1, resetAt });
    return {
      allowed: true as const,
      remaining: max - 1,
      retryAfterMs: 0,
    };
  }

  if (current.count >= max) {
    return {
      allowed: false as const,
      remaining: 0,
      retryAfterMs: Math.max(1, current.resetAt - now),
    };
  }

  current.count += 1;
  rateLimitStore.set(bucket, current);
  return {
    allowed: true as const,
    remaining: Math.max(0, max - current.count),
    retryAfterMs: 0,
  };
}
