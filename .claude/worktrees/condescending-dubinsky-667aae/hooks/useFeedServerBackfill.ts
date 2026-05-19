'use client';

import { useCallback, useRef } from 'react';
import { User } from '@/types';

const SERVER_BACKFILL_ENDPOINT = '/api/users/import';
const SERVER_BACKFILL_TIMEOUT_MS = 10000;

export function useFeedServerBackfill() {
  const inFlightRef = useRef(false);
  const attemptedRef = useRef(false);

  const backfill = useCallback(
    async (localUsers: User[], signal?: AbortSignal): Promise<boolean> => {
      if (inFlightRef.current) {
        return false;
      }

      const usersWithAddresses = localUsers.filter((user) => user.addresses.length > 0);
      if (usersWithAddresses.length === 0) {
        return false;
      }

      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }

      inFlightRef.current = true;
      const controller = new AbortController();
      let abortedByExternalSignal = false;
      let detachExternalAbortListener: (() => void) | null = null;
      if (signal) {
        if (signal.aborted) {
          abortedByExternalSignal = true;
          controller.abort();
        } else {
          const handleExternalAbort = () => {
            abortedByExternalSignal = true;
            controller.abort();
          };
          signal.addEventListener('abort', handleExternalAbort, { once: true });
          detachExternalAbortListener = () => {
            signal.removeEventListener('abort', handleExternalAbort);
          };
        }
      }
      const timer = setTimeout(() => {
        controller.abort();
      }, SERVER_BACKFILL_TIMEOUT_MS);

      try {
        let response: Response;
        try {
          response = await fetch(SERVER_BACKFILL_ENDPOINT, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              users: usersWithAddresses,
              replaceExisting: false,
            }),
            signal: controller.signal,
          });
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            if (abortedByExternalSignal) {
              throw error;
            }
            throw new Error(`回灌超时（>${SERVER_BACKFILL_TIMEOUT_MS}ms）`);
          }
          throw new Error(error instanceof Error ? error.message : '回灌失败');
        }

        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error || `回灌失败（HTTP ${response.status}）`);
        }

        console.info(
          `[useFeedServerBackfill] 已将本地用户回灌到服务端 users=${usersWithAddresses.length}`
        );
        return true;
      } finally {
        clearTimeout(timer);
        detachExternalAbortListener?.();
        inFlightRef.current = false;
      }
    },
    []
  );

  const markAttempted = useCallback(() => {
    attemptedRef.current = true;
  }, []);

  const resetAttempted = useCallback(() => {
    attemptedRef.current = false;
  }, []);

  const isAttempted = useCallback(() => attemptedRef.current, []);

  return {
    backfill,
    markAttempted,
    resetAttempted,
    isAttempted,
  };
}
