/**
 * Shared timing utilities — safe for both client and server bundles.
 *
 * Replaces the ~8 local `sleep` definitions previously scattered across
 * lib/, lib/server/, and scripts/. Keep this file dependency-free.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
