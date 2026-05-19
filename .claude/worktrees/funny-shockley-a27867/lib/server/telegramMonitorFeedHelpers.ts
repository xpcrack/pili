import 'server-only';

import type { Activity, User } from '@/types';

export interface TelegramMonitorMatchedUser {
  user: User;
  trackedAddress: string | null;
}

export type TelegramTrackedAddressIndex = Map<string, TelegramMonitorMatchedUser>;

export interface TelegramMonitorFeedRowLike {
  activity: Activity;
}

function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

function normalizeAliasLabel(value: string | null | undefined) {
  return (value || '')
    .trim()
    .toLowerCase()
    .replace(/#/g, '');
}

function isEvmChain(chain: string | null | undefined) {
  return chain === 'bsc' || chain === 'ethereum' || chain === 'base';
}

function isCompatibleChain(addressChain: string, eventChain: string) {
  if (addressChain === eventChain) {
    return true;
  }
  return isEvmChain(addressChain) && isEvmChain(eventChain);
}

export function buildTrackedAddressIndex(users: User[]): TelegramTrackedAddressIndex {
  const index = new Map<string, TelegramMonitorMatchedUser>();

  for (const user of users) {
    for (const address of user.addresses) {
      const key = `${normalize(address.chain)}|${normalize(address.address)}`;
      if (!key.endsWith('|')) {
        index.set(key, {
          user,
          trackedAddress: address.address,
        });

        if (isEvmChain(address.chain)) {
          for (const evmChain of ['bsc', 'ethereum', 'base']) {
            index.set(`${evmChain}|${normalize(address.address)}`, {
              user,
              trackedAddress: address.address,
            });
          }
        }
      }
    }
  }

  return index;
}

export function pickMonitoredUser(params: {
  eventWalletAliasLabel: string | null;
  trackedWalletAddress: string | null;
  chain: string;
  users: User[];
  trackedAddressIndex: TelegramTrackedAddressIndex;
}): TelegramMonitorMatchedUser | null {
  const { eventWalletAliasLabel, trackedWalletAddress, chain, users, trackedAddressIndex } = params;
  const trackedKey = `${normalize(chain)}|${normalize(trackedWalletAddress)}`;
  const matchedByAddress = trackedAddressIndex.get(trackedKey);
  if (matchedByAddress) {
    return matchedByAddress;
  }

  const aliasLabel = normalizeAliasLabel(eventWalletAliasLabel);
  if (!aliasLabel) {
    return null;
  }

  for (const user of users) {
    const userName = normalizeAliasLabel(user.name);
    if (aliasLabel === userName) {
      return {
        user,
        trackedAddress: user.addresses[0]?.address || null,
      };
    }

    for (const address of user.addresses) {
      if (!isCompatibleChain(normalize(address.chain), normalize(chain))) {
        continue;
      }
      const alias = `${normalizeAliasLabel(user.name)}${normalizeAliasLabel(address.name)}`;
      const explicitAlias = address.name.startsWith('#')
        ? `${normalizeAliasLabel(user.name)}${normalizeAliasLabel(address.name)}`
        : `${normalizeAliasLabel(user.name)}${normalizeAliasLabel(`#${address.name}`)}`;
      if (aliasLabel === alias || aliasLabel === explicitAlias || aliasLabel === normalizeAliasLabel(address.name)) {
        return {
          user,
          trackedAddress: address.address,
        };
      }
    }
  }

  return null;
}

export function buildTelegramMonitorFeedDedupKey(item: TelegramMonitorFeedRowLike) {
  return (
    item.activity.metadata.monitorTxAggregateKey ||
    [
      normalize(item.activity.metadata.chain),
      normalize(item.activity.metadata.trackedAddress),
      normalize(item.activity.metadata.txHash),
    ]
      .filter(Boolean)
      .join(':') ||
    item.activity.id
  );
}

export function dedupeTelegramMonitorFeedRows<TRow extends TelegramMonitorFeedRowLike>(rows: TRow[]) {
  const deduped = new Map<string, TRow>();

  for (const item of rows) {
    const key = buildTelegramMonitorFeedDedupKey(item);
    const existing = deduped.get(key);
    if (!existing || item.activity.timestamp >= existing.activity.timestamp) {
      deduped.set(key, item);
    }
  }

  return Array.from(deduped.values());
}
