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

export function buildUserAvatar(handle: string, twitter?: string) {
  const normalizedTwitter = normalizeTwitterHandle(twitter);

  if (normalizedTwitter) {
    const params = new URLSearchParams({
      handle: handle.trim(),
      twitter: normalizedTwitter,
    });

    return `/api/avatar?${params.toString()}`;
  }

  return buildFallbackAvatar(handle);
}

export function getUserAvatar(user: Pick<User, 'handle' | 'twitter' | 'avatar'>) {
  if (user.twitter) {
    return buildUserAvatar(user.handle, user.twitter);
  }

  return user.avatar || buildFallbackAvatar(user.handle);
}
