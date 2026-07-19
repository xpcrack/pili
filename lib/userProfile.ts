import { User } from '@/types';

export function normalizeTwitterHandle(input?: string) {
  if (!input) return '';

  const trimmed = input.trim();

  if (!trimmed) {
    return '';
  }

  const withoutProtocol = trimmed.replace(/^https?:\/\//i, '');
  const withoutDomain = withoutProtocol.replace(/^(www\.)?(x|twitter)\.com\//i, '');
  const withoutAt = withoutDomain.replace(/^@/, '');

  return withoutAt.split('/')[0].split('?')[0].trim();
}

function buildFallbackAvatar(handle: string) {
  return `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(handle.trim())}`;
}

function buildAvatarVersionSeed(handle: string, twitter?: string, avatar?: string) {
  const normalizedTwitter = normalizeTwitterHandle(twitter);
  const normalizedAvatar = (avatar || '').trim();
  return normalizedAvatar || normalizedTwitter || handle.trim();
}

function isTwitterHostedAvatar(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'pbs.twimg.com' || hostname.endsWith('.twimg.com');
  } catch {
    return false;
  }
}

function isUnavatarUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'unavatar.io' || hostname.endsWith('.unavatar.io');
  } catch {
    return false;
  }
}

function extractTwitterFromUnavatar(value: string) {
  try {
    const parsed = new URL(value);
    const parts = parsed.pathname.split('/').filter(Boolean);
    // /x/{handle} or /twitter/{handle}
    if (parts.length >= 2 && (parts[0] === 'x' || parts[0] === 'twitter')) {
      return normalizeTwitterHandle(parts[1]);
    }
    return '';
  } catch {
    return '';
  }
}

export function buildUserAvatar(handle: string, twitter?: string, avatar?: string) {
  const normalizedTwitter = normalizeTwitterHandle(twitter);
  if (!normalizedTwitter) {
    return buildFallbackAvatar(handle);
  }

  const params = new URLSearchParams({
    handle: handle.trim() || normalizedTwitter,
    twitter: normalizedTwitter,
    v: buildAvatarVersionSeed(handle, twitter, avatar),
  });
  const preferred = (avatar || '').trim();
  // 服务端优先用已缓存的 pbs/unavatar URL（走本机代理），失败再 unavatar 兜底
  if (preferred && (isTwitterHostedAvatar(preferred) || isUnavatarUrl(preferred))) {
    params.set('url', preferred);
  }

  return `/api/avatar?${params.toString()}`;
}

export function getUserAvatar(user: Pick<User, 'handle' | 'twitter' | 'avatar' | 'twitterAvatarUrl'>) {
  const avatar = typeof user.avatar === 'string' ? user.avatar.trim() : '';
  const twitterAvatarUrl =
    'twitterAvatarUrl' in user && typeof user.twitterAvatarUrl === 'string' ? user.twitterAvatarUrl.trim() : '';
  const twitter =
    normalizeTwitterHandle(user.twitter) ||
    extractTwitterFromUnavatar(avatar) ||
    extractTwitterFromUnavatar(twitterAvatarUrl);

  // 有推特身份：一律走 /api/avatar（浏览器直连 pbs/unavatar 会空）
  if (twitter) {
    const preferred = isTwitterHostedAvatar(twitterAvatarUrl)
      ? twitterAvatarUrl
      : isTwitterHostedAvatar(avatar)
        ? avatar
        : twitterAvatarUrl || avatar;
    return buildUserAvatar(user.handle, twitter, preferred);
  }

  if (avatar && !isUnavatarUrl(avatar) && !isTwitterHostedAvatar(avatar)) {
    return avatar;
  }

  if (twitterAvatarUrl && !isUnavatarUrl(twitterAvatarUrl) && !isTwitterHostedAvatar(twitterAvatarUrl)) {
    return twitterAvatarUrl;
  }

  return buildFallbackAvatar(user.handle);
}
