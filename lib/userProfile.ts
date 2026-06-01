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

export function buildUserAvatar(handle: string, twitter?: string, avatar?: string) {
  const normalizedTwitter = normalizeTwitterHandle(twitter);

  if (normalizedTwitter) {
    const params = new URLSearchParams({
      handle: handle.trim(),
      twitter: normalizedTwitter,
      v: buildAvatarVersionSeed(handle, twitter, avatar),
    });

    return `/api/avatar?${params.toString()}`;
  }

  return buildFallbackAvatar(handle);
}

export function getUserAvatar(user: Pick<User, 'handle' | 'twitter' | 'avatar' | 'twitterAvatarUrl'>) {
  const avatar = typeof user.avatar === 'string' ? user.avatar.trim() : '';
  const twitterAvatarUrl =
    'twitterAvatarUrl' in user && typeof user.twitterAvatarUrl === 'string' ? user.twitterAvatarUrl.trim() : '';

  if (user.twitter && (isTwitterHostedAvatar(avatar) || isTwitterHostedAvatar(twitterAvatarUrl))) {
    return buildUserAvatar(user.handle, user.twitter, avatar || twitterAvatarUrl);
  }

  if (avatar) {
    return avatar;
  }

  if (twitterAvatarUrl) {
    return twitterAvatarUrl;
  }

  if (user.twitter) {
    return buildUserAvatar(user.handle, user.twitter, avatar);
  }

  return buildFallbackAvatar(user.handle);
}
