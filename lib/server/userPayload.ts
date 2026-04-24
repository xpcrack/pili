import 'server-only';

import crypto from 'node:crypto';

import { canonicalUsersToLegacy, normalizeTelegramUrl, normalizeTwitterUrl } from '@/lib/canonical';
import { type CanonicalAddress, type CanonicalUser, type User } from '@/types';

const SUPPORTED_CHAINS = new Set(['bsc', 'solana', 'ethereum']);

function isAddressArray(value: unknown): value is User['addresses'] {
  return Array.isArray(value);
}

function toNumberOrNull(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function sanitizeUsersPayload(value: unknown): User[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }

    const candidate = item as Partial<User>;

    if (
      typeof candidate.name !== 'string' ||
      typeof candidate.handle !== 'string' ||
      typeof candidate.avatar !== 'string' ||
      !isAddressArray(candidate.addresses)
    ) {
      return [];
    }

    const sanitizedAddresses = candidate.addresses
      .filter(
        (address): address is User['addresses'][number] =>
          !!address &&
          typeof address === 'object' &&
          typeof address.address === 'string' &&
          typeof address.name === 'string' &&
          SUPPORTED_CHAINS.has(address.chain)
      )
      .map((address) => ({
        address: address.address,
        name: address.name,
        chain: address.chain,
        totalAssetUsd: toNumberOrNull(address.totalAssetUsd),
        assetUpdatedAt: toNumberOrNull(address.assetUpdatedAt),
      }));

    return [
      {
        id: typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id : crypto.randomUUID(),
        name: candidate.name,
        handle: candidate.handle,
        avatar: candidate.avatar,
        twitter: typeof candidate.twitter === 'string' ? candidate.twitter : undefined,
        telegram: typeof candidate.telegram === 'string' ? candidate.telegram : undefined,
        tags: Array.isArray(candidate.tags)
          ? candidate.tags.filter((tag): tag is string => typeof tag === 'string')
          : [],
        addresses: sanitizedAddresses,
        totalAssetUsd: typeof candidate.totalAssetUsd === 'number' ? candidate.totalAssetUsd : 0,
        historicalMaxAssetUsd:
          typeof candidate.historicalMaxAssetUsd === 'number' ? candidate.historicalMaxAssetUsd : 0,
        assetUpdatedAt: toNumberOrNull(candidate.assetUpdatedAt),
      },
    ];
  });
}

function isCanonicalAddressesByUserId(
  value: unknown
): value is Record<string, CanonicalAddress[]> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return Object.values(value).every(
    (addresses) =>
      Array.isArray(addresses) &&
      addresses.every(
        (address) =>
          !!address &&
          typeof address === 'object' &&
          typeof address.address === 'string' &&
          SUPPORTED_CHAINS.has((address as CanonicalAddress).chain)
      )
  );
}

export function sanitizeCanonicalUsersPayload(value: unknown, addressesByUserIdValue: unknown): User[] {
  if (!Array.isArray(value) || !isCanonicalAddressesByUserId(addressesByUserIdValue)) {
    return [];
  }

  const users: CanonicalUser[] = value.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }

    const candidate = item as Partial<CanonicalUser>;
    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.name !== 'string' ||
      typeof candidate.avatar !== 'string'
    ) {
      return [];
    }

    return [
      {
        id: candidate.id.trim() || crypto.randomUUID(),
        name: candidate.name.trim() || '未命名人物',
        avatar: candidate.avatar.trim(),
        currentBalanceUsd: typeof candidate.currentBalanceUsd === 'number' ? candidate.currentBalanceUsd : 0,
        maxBalanceUsd: typeof candidate.maxBalanceUsd === 'number' ? candidate.maxBalanceUsd : 0,
        hasUnread: candidate.hasUnread === true,
        twitterUrl: normalizeTwitterUrl(candidate.twitterUrl) ?? null,
        telegramUrl: normalizeTelegramUrl(candidate.telegramUrl) ?? null,
      },
    ];
  });

  if (users.length === 0) {
    return [];
  }

  return canonicalUsersToLegacy(users, addressesByUserIdValue);
}
