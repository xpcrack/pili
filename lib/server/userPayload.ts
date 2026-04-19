import 'server-only';

import crypto from 'node:crypto';

import { type User } from '@/types';

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
