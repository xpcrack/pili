import type { UserDetailsErrorPayload, UserDetailsSuccessPayload } from '@/lib/userDetails';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function isNumberOrNull(value: unknown): value is number | null {
  return typeof value === 'number' || value === null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isUserAddress(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.address === 'string' &&
    typeof value.name === 'string' &&
    typeof value.chain === 'string' &&
    isNumberOrNull(value.totalAssetUsd) &&
    isNumberOrNull(value.assetUpdatedAt)
  );
}

function isHoldingRow(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.chain === 'string' &&
    typeof value.tokenAddress === 'string' &&
    typeof value.symbol === 'string' &&
    (typeof value.name === 'string' || value.name === null) &&
    typeof value.balance === 'number' &&
    typeof value.priceUsd === 'number' &&
    typeof value.valueUsd === 'number'
  );
}

function isUserDetailsSuccessPayload(payload: unknown): payload is UserDetailsSuccessPayload {
  if (!isRecord(payload)) {
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
    typeof user.name === 'string' &&
    typeof user.handle === 'string' &&
    typeof user.avatar === 'string' &&
    Array.isArray(user.addresses) &&
    user.addresses.every(isUserAddress) &&
    typeof user.totalAssetUsd === 'number' &&
    typeof user.historicalMaxAssetUsd === 'number' &&
    (typeof user.assetUpdatedAt === 'number' || user.assetUpdatedAt === null) &&
    Array.isArray(user.tags) &&
    isStringArray(user.tags) &&
    Array.isArray(candidate.holdings) &&
    candidate.holdings.every(isHoldingRow) &&
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

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
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
  const payload = await readJsonSafely(response);

  if (!response.ok) {
    throw new Error(readErrorMessage(payload, response.status));
  }

  if (!isUserDetailsSuccessPayload(payload)) {
    throw new Error('Malformed user details payload');
  }

  return payload;
}
