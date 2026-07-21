'use client';

/** Shared with app/system/page.tsx. */
export const ADMIN_TOKEN_STORAGE_KEY = 'pilipili_admin_api_token';

function readStorage(storage: Storage | undefined): string {
  if (!storage) return '';
  try {
    return (storage.getItem(ADMIN_TOKEN_STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

/** Prefer localStorage (survives browser restart); migrate leftover sessionStorage once. */
export function readAdminTokenFromSession(): string {
  if (typeof window === 'undefined') return '';
  try {
    const fromLocal = readStorage(window.localStorage);
    if (fromLocal) return fromLocal;

    const fromSession = readStorage(window.sessionStorage);
    if (fromSession) {
      try {
        window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, fromSession);
        window.sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
      } catch {
        // ignore quota / private mode write failures; still return the token
      }
      return fromSession;
    }
    return '';
  } catch {
    return '';
  }
}

export function writeAdminTokenToStorage(token: string) {
  if (typeof window === 'undefined') return;
  const normalized = token.trim();
  try {
    if (normalized) {
      window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, normalized);
    } else {
      window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
  try {
    window.sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Headers for mutating/admin API calls. Empty when no token (dev insecure local admin). */
export function adminHeaders(extra?: HeadersInit): HeadersInit {
  const token = readAdminTokenFromSession();
  const headers: Record<string, string> = {};
  if (extra) {
    const base = new Headers(extra);
    base.forEach((value, key) => {
      headers[key] = value;
    });
  }
  if (token) {
    headers['x-admin-token'] = token;
  }
  return headers;
}
