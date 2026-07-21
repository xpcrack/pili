'use client';

/** Must match app/system/page.tsx storage key. */
export const ADMIN_TOKEN_STORAGE_KEY = 'pilipili_admin_api_token';

export function readAdminTokenFromSession(): string {
  if (typeof window === 'undefined') return '';
  try {
    return (window.sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || '').trim();
  } catch {
    return '';
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
