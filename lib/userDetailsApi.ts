import type { UserDetailsErrorPayload, UserDetailsSuccessPayload } from '@/lib/userDetails';

function isUserDetailsSuccessPayload(payload: unknown): payload is UserDetailsSuccessPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const candidate = payload as Partial<UserDetailsSuccessPayload>;
  const user = candidate.user;
  const summary = candidate.holdingsSummary;

  return (
    candidate.ok === true &&
    !!user &&
    typeof user === 'object' &&
    typeof user.id === 'string' &&
    Array.isArray(user.addresses) &&
    typeof user.totalAssetUsd === 'number' &&
    typeof user.historicalMaxAssetUsd === 'number' &&
    (typeof user.assetUpdatedAt === 'number' || user.assetUpdatedAt === null) &&
    Array.isArray(user.tags) &&
    Array.isArray(candidate.holdings) &&
    (typeof candidate.holdingsUpdatedAt === 'number' || candidate.holdingsUpdatedAt === null) &&
    typeof candidate.holdingsThresholdUsd === 'number' &&
    !!summary &&
    typeof summary === 'object' &&
    typeof summary.visibleCount === 'number' &&
    typeof summary.partial === 'boolean' &&
    typeof summary.successfulAddressCount === 'number' &&
    typeof summary.failedAddressCount === 'number'
  );
}

function readErrorMessage(payload: unknown, status: number) {
  if (payload && typeof payload === 'object' && typeof (payload as UserDetailsErrorPayload).error === 'string') {
    return (payload as UserDetailsErrorPayload).error;
  }

  return `HTTP ${status}`;
}

export async function fetchUserDetails(userId: string): Promise<UserDetailsSuccessPayload> {
  const response = await fetch(`/api/users/${encodeURIComponent(userId)}`, {
    cache: 'no-store',
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(readErrorMessage(payload, response.status));
  }

  if (!isUserDetailsSuccessPayload(payload)) {
    throw new Error('Malformed user details payload');
  }

  return payload;
}
