/**
 * Periodically re-enqueue monitored wallets whose 14d activity timeline is stale.
 * Drain still happens in completeness worker via walletActivityBackfillQueue.
 */
import 'server-only';

import { DEFAULT_TIMELINE_DAYS } from '@/lib/server/walletActivityBackfill';
import {
  enqueueWalletActivityBackfillMany,
  walletActivityBackfillQueue,
} from '@/lib/server/walletActivityBackfillQueue';
import { listStaleMonitoredWallets } from '@/lib/server/walletTimelineState';

export type SweepStaleWalletTimelinesResult = {
  scannedStale: number;
  enqueued: number;
  pendingAfter: number;
};

function readPositiveInt(envName: string, fallback: number) {
  const n = Number(process.env[envName]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function sweepStaleWalletTimelines(opts?: {
  windowDays?: number;
  staleAfterMs?: number;
  limit?: number;
  nowMs?: number;
}): SweepStaleWalletTimelinesResult {
  const windowDays = opts?.windowDays ?? DEFAULT_TIMELINE_DAYS;
  const limit =
    opts?.limit ?? readPositiveInt('PILI_WALLET_TIMELINE_SWEEP_LIMIT', 20);
  const staleAfterMs =
    opts?.staleAfterMs ??
    readPositiveInt('PILI_WALLET_TIMELINE_STALE_MS', 6 * 60 * 60 * 1000);

  const pendingLowers = new Set(
    walletActivityBackfillQueue.peek().map((item) => item.addressLower)
  );

  const stale = listStaleMonitoredWallets({
    nowMs: opts?.nowMs,
    windowDays,
    staleAfterMs,
    limit,
    excludeAddressLowers: pendingLowers,
  });

  if (stale.length === 0) {
    return {
      scannedStale: 0,
      enqueued: 0,
      pendingAfter: walletActivityBackfillQueue.pendingCount(),
    };
  }

  const { enqueued } = enqueueWalletActivityBackfillMany(
    stale.map((w) => ({
      address: w.address,
      days: windowDays,
      reason: 'timeline-stale',
    }))
  );

  return {
    scannedStale: stale.length,
    enqueued,
    pendingAfter: walletActivityBackfillQueue.pendingCount(),
  };
}
