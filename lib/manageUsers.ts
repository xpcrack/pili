import { groupAddressesForDisplay } from '@/lib/addressBook';
import type { User } from '@/types';

function normalizeSearchValue(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

function compactFields(fields: Array<string | null | undefined>) {
  return fields
    .map((field) => field?.trim())
    .filter((field): field is string => Boolean(field));
}

export function getManageAddressDisplayText(address: string) {
  return address.trim();
}

export function buildManageUserSearchText(user: User) {
  const fields = compactFields([
    user.name,
    user.handle,
    user.twitter,
    user.twitter ? `@${user.twitter}` : undefined,
    user.telegram,
    ...user.tags,
  ]);

  for (const address of user.addresses) {
    fields.push(address.address, address.name, address.chain);
  }

  for (const address of groupAddressesForDisplay(user.addresses)) {
    fields.push(
      address.address,
      address.name,
      address.networkLabel,
      address.chain,
      ...address.chains
    );
  }

  return normalizeSearchValue(fields.join('\n'));
}

export function matchesManageUserSearch(user: User, query: string) {
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) {
    return true;
  }

  const haystack = buildManageUserSearchText(user);
  return normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

export function filterManageUsers(users: readonly User[], query: string) {
  return users.filter((user) => matchesManageUserSearch(user, query));
}

function buildManageAddressKey(address: User['addresses'][number]) {
  return `${address.chain}:${normalizeSearchValue(address.address)}`;
}

export function mergeManageUsersWithServer(localUsers: readonly User[], serverUsers: readonly User[]) {
  const localById = new Map(localUsers.map((user) => [user.id, user] as const));
  const mergedServerUsers = serverUsers.map((serverUser) => {
    const localUser = localById.get(serverUser.id);
    if (!localUser) {
      return serverUser;
    }

    const seenAddressKeys = new Set(serverUser.addresses.map(buildManageAddressKey));
    const localOnlyAddresses = localUser.addresses.filter((address) => {
      const key = buildManageAddressKey(address);
      if (seenAddressKeys.has(key)) {
        return false;
      }
      seenAddressKeys.add(key);
      return true;
    });

    return {
      ...serverUser,
      addresses: [...serverUser.addresses, ...localOnlyAddresses],
    };
  });

  const serverIds = new Set(serverUsers.map((user) => user.id));
  const localOnlyUsers = localUsers.filter((user) => !serverIds.has(user.id));

  return [...mergedServerUsers, ...localOnlyUsers];
}

function normalizeTags(tags: readonly string[]) {
  return tags.map((tag) => tag.trim()).filter(Boolean).sort();
}

function normalizeSyncAddress(address: User['addresses'][number]) {
  return {
    chain: address.chain,
    address: address.address.trim(),
    addressLower: normalizeSearchValue(address.address),
    name: address.name.trim(),
  };
}

export function buildManageServerSyncSignature(users: readonly User[]) {
  const payload = users
    .filter((user) => user.addresses.length > 0)
    .map((user) => ({
      id: user.id,
      name: user.name.trim(),
      handle: user.handle.trim(),
      avatar: user.avatar.trim(),
      twitter: user.twitter?.trim() || '',
      telegram: user.telegram?.trim() || '',
      tags: normalizeTags(user.tags),
      addresses: user.addresses
        .map(normalizeSyncAddress)
        .sort((left, right) =>
          `${left.chain}:${left.addressLower}:${left.name}`.localeCompare(
            `${right.chain}:${right.addressLower}:${right.name}`
          )
        ),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return JSON.stringify(payload);
}

function hashString(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function buildManageServerSyncKey(users: readonly User[]) {
  const signature = buildManageServerSyncSignature(users);
  return `manage-server-sync:${signature.length}:${hashString(signature)}`;
}
