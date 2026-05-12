import { NextRequest, NextResponse } from 'next/server';
import { normalizeTwitterHandle } from '@/lib/userProfile';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const avatarCache = new Map<string, { body: ArrayBuffer; contentType: string; expiresAt: number }>();
const negativeCache = new Map<string, number>();
const POSITIVE_CACHE_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_CACHE_MS = 5 * 60 * 1000;
const AVATAR_PROBE_TIMEOUT_MS = 7000;
const CACHE_CONTROL = 'public, max-age=3600, s-maxage=3600';
const FALLBACK_CACHE_CONTROL = 'no-store, max-age=0';
const MAX_AVATAR_BYTES = 1024 * 1024;
const AVATAR_CACHE_MAX_ENTRIES = 200;
const NEGATIVE_CACHE_MAX_ENTRIES = 2000;

function evictOldestUntilUnderLimit<K, V>(map: Map<K, V>, maxEntries: number) {
  while (map.size >= maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    map.delete(oldestKey);
  }
}

function bumpRecency<K, V>(map: Map<K, V>, key: K) {
  const value = map.get(key);
  if (value === undefined) {
    return;
  }
  map.delete(key);
  map.set(key, value);
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function colorFromSeed(seed: string) {
  const text = seed.trim().toLowerCase() || 'user';
  let hash = 0;

  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }

  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 72% 46%)`;
}

function buildFallbackSvg(handle: string) {
  const safeHandle = handle.trim() || 'user';
  const initials = escapeXml(safeHandle.slice(0, 2).toUpperCase());
  const bg = colorFromSeed(safeHandle);

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="${escapeXml(
    safeHandle
  )}">
  <rect width="128" height="128" rx="64" fill="${bg}" />
  <text x="64" y="72" text-anchor="middle" font-family="Arial, sans-serif" font-size="44" font-weight="700" fill="white">
    ${initials}
  </text>
</svg>`.trim();
}

function buildFallbackResponse(handle: string) {
  return new NextResponse(buildFallbackSvg(handle), {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': FALLBACK_CACHE_CONTROL,
    },
  });
}

async function fetchAvatarBytes(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, AVATAR_PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('image')) {
      return null;
    }

    const body = await response.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > MAX_AVATAR_BYTES) {
      return null;
    }

    return {
      body,
      contentType,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveTwitterAvatar(twitter: string) {
  const candidates = [
    `https://unavatar.io/x/${encodeURIComponent(twitter)}`,
    `https://unavatar.io/twitter/${encodeURIComponent(twitter)}`,
  ];

  const results = await Promise.all(candidates.map((candidate) => fetchAvatarBytes(candidate)));
  return results.find((result) => result !== null) ?? null;
}

export async function GET(request: NextRequest) {
  const handle = request.nextUrl.searchParams.get('handle')?.trim() || 'user';
  const twitter = normalizeTwitterHandle(request.nextUrl.searchParams.get('twitter') || '');

  if (!twitter) {
    return buildFallbackResponse(handle);
  }

  const cacheKey = twitter.toLowerCase();
  const now = Date.now();
  const cached = avatarCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    bumpRecency(avatarCache, cacheKey);
    return new NextResponse(cached.body, {
      status: 200,
      headers: {
        'Content-Type': cached.contentType,
        'Cache-Control': CACHE_CONTROL,
      },
    });
  }

  if ((negativeCache.get(cacheKey) ?? 0) > now) {
    bumpRecency(negativeCache, cacheKey);
    return buildFallbackResponse(handle);
  }

  const avatar = await resolveTwitterAvatar(twitter);

  if (!avatar) {
    evictOldestUntilUnderLimit(negativeCache, NEGATIVE_CACHE_MAX_ENTRIES);
    negativeCache.set(cacheKey, now + NEGATIVE_CACHE_MS);
    return buildFallbackResponse(handle);
  }

  evictOldestUntilUnderLimit(avatarCache, AVATAR_CACHE_MAX_ENTRIES);
  avatarCache.set(cacheKey, {
    body: avatar.body,
    contentType: avatar.contentType,
    expiresAt: now + POSITIVE_CACHE_MS,
  });
  negativeCache.delete(cacheKey);

  return new NextResponse(avatar.body, {
    status: 200,
    headers: {
      'Content-Type': avatar.contentType,
      'Cache-Control': CACHE_CONTROL,
    },
  });
}
