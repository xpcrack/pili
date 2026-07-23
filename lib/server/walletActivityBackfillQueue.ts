/**
 * Debounced queue: newly enabled / added wallets get a 14d GMGN timeline backfill.
 * Coalesces by address_lower. Drain from completeness worker (or tests).
 */
import 'server-only';

import { getDb } from '@/lib/server/sqlite';
import { listMonitoredUsers } from '@/lib/server/trackedUsersRepo';
import {
  backfillWalletTimeline,
  DEFAULT_TIMELINE_DAYS,
  type BackfillWalletTimelineResult,
} from '@/lib/server/walletActivityBackfill';
import type { User } from '@/types';

const DEFAULT_DEBOUNCE_MS = 5_000;
const QUEUE_APP_STATE_KEY = 'wallet_activity_backfill_queue_v1';

export type EnqueueWalletActivityBackfillInput = {
  address: string;
  userId?: string | null;
  days?: number;
  reason?: string;
};

type QueueItem = {
  address: string;
  addressLower: string;
  userId: string | null;
  days: number;
  reason: string;
  enqueuedAt: number;
};

type PersistedQueue = {
  items: QueueItem[];
};

export type WalletActivityBackfillQueueDeps = {
  debounceMs?: number;
  now?: () => number;
  backfill?: typeof backfillWalletTimeline;
  listUsers?: typeof listMonitoredUsers;
  log?: (message: string) => void;
  /** When true, skip sqlite persistence (unit tests). */
  memoryOnly?: boolean;
};

function normalizeAddress(address: string) {
  return (address || '').trim();
}

function addressKey(address: string) {
  const a = normalizeAddress(address);
  return a.startsWith('0x') || a.startsWith('0X') ? a.toLowerCase() : a;
}

function loadPersisted(): QueueItem[] {
  try {
    const db = getDb();
    const row = db
      .prepare(`SELECT value_json FROM app_state WHERE key = ?`)
      .get(QUEUE_APP_STATE_KEY) as { value_json: string } | undefined;
    if (!row?.value_json) return [];
    const parsed = JSON.parse(row.value_json) as PersistedQueue;
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

function savePersisted(items: QueueItem[]) {
  try {
    const db = getDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO app_state (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).run(QUEUE_APP_STATE_KEY, JSON.stringify({ items } satisfies PersistedQueue), now);
  } catch (error) {
    console.error(
      '[wallet-activity-backfill-queue] persist failed',
      error instanceof Error ? error.message : String(error)
    );
  }
}

function findUserForAddress(users: User[], address: string, userId?: string | null): User | null {
  const lower = addressKey(address);
  if (userId) {
    const byId = users.find((u) => u.id === userId);
    if (byId) return byId;
  }
  for (const user of users) {
    for (const addr of user.addresses || []) {
      if (addressKey(addr.address || '') === lower) return user;
    }
  }
  return null;
}

export function createWalletActivityBackfillQueue(deps: WalletActivityBackfillQueueDeps = {}) {
  const memoryOnly = Boolean(deps.memoryOnly);
  const pending = new Map<string, QueueItem>();
  if (!memoryOnly) {
    for (const item of loadPersisted()) {
      pending.set(item.addressLower, item);
    }
  }

  const debounceMs =
    typeof deps.debounceMs === 'number' && Number.isFinite(deps.debounceMs)
      ? Math.max(0, deps.debounceMs)
      : DEFAULT_DEBOUNCE_MS;
  const now = deps.now ?? Date.now;
  const backfill = deps.backfill ?? backfillWalletTimeline;
  const listUsers = deps.listUsers ?? listMonitoredUsers;
  const log =
    deps.log ??
    ((message: string) => {
      console.log(`[wallet-activity-backfill-queue] ${message}`);
    });

  let draining = false;

  function persist() {
    if (memoryOnly) return;
    savePersisted([...pending.values()]);
  }

  function enqueue(input: EnqueueWalletActivityBackfillInput) {
    const address = normalizeAddress(input.address);
    if (!address) return { enqueued: false, key: null as string | null };
    const key = addressKey(address);
    const item: QueueItem = {
      address,
      addressLower: key,
      userId: input.userId ? String(input.userId) : null,
      days: input.days ?? DEFAULT_TIMELINE_DAYS,
      reason: input.reason || 'enqueue',
      enqueuedAt: now(),
    };
    pending.set(key, item);
    persist();
    // Drain is worker-driven (completeness loop). Enqueue only persists.
    return { enqueued: true, key };
  }

  function enqueueMany(inputs: EnqueueWalletActivityBackfillInput[]) {
    let n = 0;
    for (const input of inputs) {
      if (enqueue(input).enqueued) n += 1;
    }
    return { enqueued: n };
  }

  async function drain(opts?: { maxJobs?: number }): Promise<{
    processed: number;
    results: BackfillWalletTimelineResult[];
    remaining: number;
    stoppedOnBan: boolean;
  }> {
    if (draining) {
      return { processed: 0, results: [], remaining: pending.size, stoppedOnBan: false };
    }
    draining = true;
    const maxJobs = Math.max(1, opts?.maxJobs ?? 1);
    const results: BackfillWalletTimelineResult[] = [];
    let processed = 0;
    let stoppedOnBan = false;

    try {
      const users = listUsers();
      while (processed < maxJobs && pending.size > 0) {
        const next = [...pending.values()].sort((a, b) => a.enqueuedAt - b.enqueuedAt)[0];
        if (!next) break;
        pending.delete(next.addressLower);
        persist();

        const user = findUserForAddress(users, next.address, next.userId);
        if (!user) {
          log(`skip no-user ${next.address} reason=${next.reason}`);
          processed += 1;
          continue;
        }

        try {
          const result = await backfill({
            user,
            address: next.address,
            days: next.days,
            async: true,
          });
          results.push(result);
          log(
            `ok ${next.address} upserted=${result.upserted}/${result.tradeCount} raw=${result.rawCount} reason=${next.reason}`
          );
          if (result.stoppedOnBan) {
            stoppedOnBan = true;
            // re-queue remaining chains later
            pending.set(next.addressLower, { ...next, enqueuedAt: now() });
            persist();
            break;
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          log(`fail ${next.address}: ${msg}`);
          // put back for retry
          pending.set(next.addressLower, { ...next, enqueuedAt: now() });
          persist();
          break;
        }
        processed += 1;
      }
    } finally {
      draining = false;
    }

    return { processed, results, remaining: pending.size, stoppedOnBan };
  }

  function pendingCount() {
    return pending.size;
  }

  function peek() {
    return [...pending.values()];
  }

  function resetForTests() {
    pending.clear();
    draining = false;
    if (!memoryOnly) savePersisted([]);
  }

  return {
    enqueue,
    enqueueMany,
    drain,
    pendingCount,
    peek,
    resetForTests,
    debounceMs,
  };
}

/** Process-wide queue. */
export const walletActivityBackfillQueue = createWalletActivityBackfillQueue();

export function enqueueWalletActivityBackfill(input: EnqueueWalletActivityBackfillInput) {
  return walletActivityBackfillQueue.enqueue(input);
}

export function enqueueWalletActivityBackfillMany(inputs: EnqueueWalletActivityBackfillInput[]) {
  return walletActivityBackfillQueue.enqueueMany(inputs);
}

export function drainWalletActivityBackfillQueue(opts?: { maxJobs?: number }) {
  return walletActivityBackfillQueue.drain(opts);
}
