/**
 * Shared timing utilities — safe for both client and server bundles.
 *
 * Replaces the ~8 local `sleep` definitions previously scattered across
 * lib/, lib/server/, and scripts/. Keep this file dependency-free.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Thrown by `withTimeout` when the wrapped operation exceeds its budget. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** 超时哨兵：`withTimeout` 用它区分「操作返回的值」与「超时」。 */
const TIMED_OUT = Symbol('timing.timeout');

/**
 * Rejects with `TimeoutError` when `run()` does not settle within `timeoutMs`.
 *
 * The wrapped operation is NOT cancelled — callers that must stop a wedged
 * client should exit the process (pm2 autorestart) instead of retrying.
 */
export async function withTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number,
  label = 'operation'
): Promise<T> {
  const raced = await Promise.race<T | typeof TIMED_OUT>([
    run(),
    sleep(timeoutMs).then(() => TIMED_OUT),
  ]);
  if (raced === TIMED_OUT) {
    throw new TimeoutError(`${label} timed out after ${timeoutMs}ms`);
  }
  return raced;
}
