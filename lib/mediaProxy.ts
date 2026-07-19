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

/** 浏览器侧外链图床常被墙，统一经本机代理拉取（服务端有 Clash 代理）。 */
export function toProxiedMediaUrl(value: string | null | undefined) {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url) return null;
  if (url.startsWith('/api/')) return url;
  if (!isAllowedMediaUrl(url)) return url;
  return `/api/media?url=${encodeURIComponent(url)}`;
}
