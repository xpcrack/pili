import 'server-only';

import { NextResponse } from 'next/server';

/**
 * Shared response helpers for app/api/* routes.
 *
 * Consolidates the previously-duplicated pattern:
 *
 *   try {
 *     ...
 *     return NextResponse.json({ ok: true, ...payload });
 *   } catch (error) {
 *     const message = error instanceof Error ? error.message : '<fallback>';
 *     return NextResponse.json({ ok: false, error: message }, { status: 500 });
 *   }
 *
 * Replace with:
 *
 *   try {
 *     ...
 *     return apiOk({ ...payload });
 *   } catch (error) {
 *     return apiError(error, { fallback: '<fallback>' });
 *   }
 *
 * For validation:  return apiError('请求体必须是 JSON 对象', { status: 400 });
 *
 * Response shape is unchanged from the existing `{ ok: boolean, ... }` contract,
 * so client code keeps working without changes.
 */

export type ApiOkPayload = Record<string, unknown>;

export function apiOk<T extends ApiOkPayload>(payload: T = {} as T) {
  return NextResponse.json({ ok: true as const, ...payload });
}

export interface ApiErrorOptions {
  /** Fallback message when `messageOrError` is neither a string nor an Error. */
  fallback?: string;
  /** HTTP status code. Defaults to 500. */
  status?: number;
  /** Extra fields merged into the JSON body alongside `error`. */
  extra?: Record<string, unknown>;
  /** Extra HTTP headers. */
  headers?: HeadersInit;
}

export function apiError(messageOrError: unknown, options: ApiErrorOptions = {}) {
  const fallback = options.fallback ?? '服务器内部错误';
  const status = options.status ?? 500;

  let message: string;
  if (messageOrError instanceof Error) {
    message = messageOrError.message || fallback;
  } else if (typeof messageOrError === 'string' && messageOrError.trim()) {
    message = messageOrError;
  } else {
    message = fallback;
  }

  const init: ResponseInit = { status };
  if (options.headers) {
    init.headers = options.headers;
  }

  return NextResponse.json(
    { ok: false as const, error: message, ...(options.extra ?? {}) },
    init
  );
}
