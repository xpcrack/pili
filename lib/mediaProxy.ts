const ALLOWED_MEDIA_HOST_SUFFIXES = [
  'twimg.com',
  'unavatar.io',
  'dexscreener.com',
  'oklink.com',
  'okx.com',
  'gmgn.ai',
  'cf-ipfs.com',
  'ipfs.io',
  'nftstorage.link',
  'arweave.net',
];

export function isAllowedMediaUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_MEDIA_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`)
    );
  } catch {
    return false;
  }
}

const SAFE_PROXY_IMAGE_CONTENT_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export function normalizeSafeProxyImageContentType(value: string | null): string | null {
  const normalized = (value || '').split(';', 1)[0]?.trim().toLowerCase() || '';
  if (SAFE_PROXY_IMAGE_CONTENT_TYPES.has(normalized)) {
    return normalized;
  }
  // Some upstream gateways omit the real image MIME type. Serving it as PNG
  // with nosniff is safe (invalid bytes simply fail to render) and preserves
  // the existing fallback behavior without allowing SVG/HTML active content.
  if (normalized === 'application/octet-stream') {
    return 'image/png';
  }
  return null;
}

export interface AllowedRedirectFetchOptions extends RequestInit {
  maxRedirects?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch a resource while applying the same host policy to every redirect.
 * `redirect: follow` is deliberately not used: a trusted image host can
 * redirect to an arbitrary URL, which would otherwise turn this proxy into
 * an SSRF primitive.
 */
export async function fetchAllowedRedirects(
  initialUrl: string,
  options: AllowedRedirectFetchOptions = {},
  isAllowedUrl: (url: string) => boolean = isAllowedMediaUrl,
  fetchImpl: typeof fetch = fetch
): Promise<Response | null> {
  const maxRedirects = Math.max(0, Math.min(5, Math.floor(options.maxRedirects ?? 3)));
  let currentUrl = initialUrl;
  const { maxRedirects: _ignored, ...requestInit } = options;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    if (!isAllowedUrl(currentUrl)) {
      return null;
    }

    const response = await fetchImpl(currentUrl, {
      ...requestInit,
      redirect: 'manual',
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location || redirectCount === maxRedirects) {
      return null;
    }

    await response.body?.cancel().catch(() => undefined);
    try {
      currentUrl = new URL(location, currentUrl).toString();
    } catch {
      return null;
    }
  }

  return null;
}

/** Read at most `maxBytes` without first buffering an attacker-sized body. */
export async function readResponseBodyLimited(
  response: Response,
  maxBytes: number
): Promise<ArrayBuffer | null> {
  const limit = Math.max(0, Math.floor(maxBytes));
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const declaredLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      await response.body?.cancel();
      return null;
    }
  }

  if (!response.body) {
    const body = await response.arrayBuffer();
    return body.byteLength <= limit ? body : null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

/** 浏览器侧外链图床常被墙，统一经本机代理拉取（服务端有 Clash 代理）。 */
export function toProxiedMediaUrl(value: string | null | undefined) {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url) return null;
  if (url.startsWith('/api/')) return url;
  if (!isAllowedMediaUrl(url)) return url;
  return `/api/media?url=${encodeURIComponent(url)}`;
}
