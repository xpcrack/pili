import 'server-only';

import { createTwitter6551Client } from '@/lib/server/twitter6551Client';
import { createTwitterXreadClient } from '@/lib/server/twitterXreadClient';
import {
  readTwitterIdentityCache,
  upsertTwitterIdentityCache,
} from '@/lib/server/twitterProviderStateRepo';
import { normalizeTwitterHandle } from '@/lib/userProfile';
import type { User } from '@/types';

export interface ResolvedTwitterIdentity {
  provider: string;
  userId: string;
  handle: string;
  avatarUrl?: string;
}

interface TwitterIdentityLookupResult {
  provider: string;
  user: {
    id: string;
    handle: string;
    avatarUrl?: string;
  };
}

interface TwitterIdentityServiceDependencies {
  lookupUser?: (handle: string) => Promise<TwitterIdentityLookupResult | null>;
  now?: () => number;
}

const DEFAULT_IDENTITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const TWITTER_6551_CREDENTIAL_IDS = ['1', '2', '3', '4'] as const;

function normalize(value: string | undefined | null) {
  return (value || '').trim().toLowerCase();
}

async function lookupUserWithConfiguredProviders(handle: string) {
  const xreadApiKey = process.env.TWITTER_XREAD_API_KEY?.trim() || '';
  if (xreadApiKey) {
    try {
      return await createTwitterXreadClient().lookupUser({
        apiKey: xreadApiKey,
        username: handle,
      });
    } catch {
      // Try the next configured provider.
    }
  }

  const client6551 = createTwitter6551Client();
  for (const keyIndex of TWITTER_6551_CREDENTIAL_IDS) {
    const apiKey = process.env[`TWITTER_6551_API_KEY_${keyIndex}`]?.trim() || '';
    if (!apiKey) {
      continue;
    }

    try {
      return await client6551.lookupUser({
        apiKey,
        username: handle,
      });
    } catch {
      // Try the next key.
    }
  }

  return null;
}

export async function resolveTwitterIdentityForHandle(
  inputHandle: string | undefined | null,
  dependencies: TwitterIdentityServiceDependencies = {}
): Promise<ResolvedTwitterIdentity | null> {
  const handle = normalizeTwitterHandle(inputHandle || '');
  const normalizedHandle = normalize(handle);
  if (!normalizedHandle) {
    return null;
  }

  const now = dependencies.now || (() => Date.now());
  const cached = dependencies.lookupUser ? null : readTwitterIdentityCache(normalizedHandle);
  if (cached?.userId) {
    return {
      provider: cached.provider,
      userId: cached.userId,
      handle: normalize(cached.username || normalizedHandle) || normalizedHandle,
      avatarUrl: cached.avatarUrl?.trim() || undefined,
    };
  }

  const lookup = dependencies.lookupUser
    ? await dependencies.lookupUser(normalizedHandle)
    : await lookupUserWithConfiguredProviders(normalizedHandle);

  if (!lookup?.user.id || !lookup.user.handle) {
    if (!dependencies.lookupUser) {
      upsertTwitterIdentityCache({
        handle: normalizedHandle,
        provider: 'auto',
        userId: null,
        username: normalizedHandle,
        avatarUrl: null,
        expiresAtMs: now() + DEFAULT_NEGATIVE_CACHE_TTL_MS,
        lastError: 'identity_resolution_failed',
      });
    }
    return null;
  }

  const resolved = {
    provider: lookup.provider,
    userId: lookup.user.id.trim(),
    handle: normalize(lookup.user.handle),
    avatarUrl: lookup.user.avatarUrl?.trim() || undefined,
  } satisfies ResolvedTwitterIdentity;

  if (!dependencies.lookupUser) {
    upsertTwitterIdentityCache({
      handle: normalizedHandle,
      provider: resolved.provider,
      userId: resolved.userId,
      username: resolved.handle,
      avatarUrl: resolved.avatarUrl || null,
      expiresAtMs: now() + DEFAULT_IDENTITY_CACHE_TTL_MS,
      lastError: null,
    });
  }

  return resolved;
}

export function mergeTwitterIdentityIntoUser<T extends Partial<User>>(
  user: T,
  identity: ResolvedTwitterIdentity | null
): T & Partial<Pick<User, 'twitter' | 'twitterUserId' | 'twitterAvatarUrl' | 'avatar'>> {
  if (!identity) {
    return user;
  }

  const currentAvatar = user.avatar?.trim() || '';
  const shouldReplaceAvatar = Boolean(
    identity.avatarUrl &&
      (!currentAvatar || currentAvatar.startsWith('/api/avatar?'))
  );

  return {
    ...user,
    twitter: identity.handle || user.twitter,
    twitterUserId: identity.userId || user.twitterUserId,
    twitterAvatarUrl: identity.avatarUrl || user.twitterAvatarUrl,
    avatar: shouldReplaceAvatar ? identity.avatarUrl : user.avatar,
  };
}
