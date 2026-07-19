import { NextRequest, NextResponse } from '@/lib/server/httpCompat';

import { isAllowedMediaUrl } from '@/lib/mediaProxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const POSITIVE_CACHE_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_CACHE_MS = 2 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 1.5 * 1024 * 1024;
const CACHE_MAX = 300;

const mediaCache = new Map<string, { body: ArrayBuffer; contentType: string; expiresAt: number }>();
const negativeCache = new Map<string, number>();

function evict(map: Map<string, unknown>, max: number) {
  while (map.size >= max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

async function fetchMediaBytes(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('image') && !contentType.includes('octet-stream')) {
      return null;
    }
    const body = await response.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > MAX_BYTES) return null;
    return {
      body,
      contentType: contentType.includes('image') ? contentType : 'image/png',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get('url')?.trim() || '';
  if (!raw || !isAllowedMediaUrl(raw)) {
    return new NextResponse('bad media url', { status: 400 });
  }

  const cacheKey = raw;
  const now = Date.now();
  const cached = mediaCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return new NextResponse(cached.body, {
      status: 200,
      headers: {
        'Content-Type': cached.contentType,
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      },
    });
  }
  if ((negativeCache.get(cacheKey) ?? 0) > now) {
    return new NextResponse('not found', { status: 404 });
  }

  const media = await fetchMediaBytes(raw);
  if (!media) {
    evict(negativeCache as Map<string, unknown>, CACHE_MAX * 4);
    negativeCache.set(cacheKey, now + NEGATIVE_CACHE_MS);
    return new NextResponse('not found', { status: 404 });
  }

  evict(mediaCache as Map<string, unknown>, CACHE_MAX);
  mediaCache.set(cacheKey, {
    body: media.body,
    contentType: media.contentType,
    expiresAt: now + POSITIVE_CACHE_MS,
  });
  negativeCache.delete(cacheKey);

  return new NextResponse(media.body, {
    status: 200,
    headers: {
      'Content-Type': media.contentType,
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}
