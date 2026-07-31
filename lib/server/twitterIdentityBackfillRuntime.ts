import 'server-only';

import { normalizeTwitterHandle } from '@/lib/userProfile';
import { getDb } from '@/lib/server/sqlite';
import {
  readTwitterIdentityCache,
  upsertTwitterIdentityCache,
} from '@/lib/server/twitterProviderStateRepo';
import { lookupUserWithConfiguredProviders } from '@/lib/server/twitterIdentityService';

const POSITIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const BATCH_LIMIT = 50;
const BUSY_SLEEP_MS = 60_000;
const IDLE_SLEEP_MS = 300_000;

interface BackfillCandidate {
  id: string;
  twitter: string;
}

function fetchCandidates(): BackfillCandidate[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, twitter
       FROM tracked_users
       WHERE twitter IS NOT NULL AND twitter != ''
         AND (twitter_user_id IS NULL OR twitter_user_id = '')
       LIMIT ?`
    )
    .all(BATCH_LIMIT) as BackfillCandidate[];
}

function applyResolvedIdentity(input: {
  userId: string;
  handle: string;
  avatarUrl: string | null;
  targetUserId: string;
}) {
  const db = getDb();
  const now = Date.now();
  // Only fill when still empty, so we never overwrite an identity that a
  // concurrent save already resolved.
  db.prepare(
    `UPDATE tracked_users
     SET twitter_user_id = ?, twitter_avatar_url = ?, twitter = ?, updated_at = ?
     WHERE id = ? AND (twitter_user_id IS NULL OR twitter_user_id = '')`
  ).run(
    input.userId,
    input.avatarUrl,
    input.handle,
    now,
    input.targetUserId
  );
}

/**
 * Background cycle: fill twitter_user_id / avatar for tracked users whose
 * twitter handle is set but identity was never resolved — e.g. the save path
 * hit the short network timeout (resolveTwitterIdentityForHandleFast) and
 * stored the raw handle only.
 *
 * Bypasses the identity cache's read path for fresh lookups (queries providers
 * directly) but reuses unexpired cache entries: a positive cache fills the
 * user without another provider call; a negative cache throttles retries.
 */
export async function runTwitterIdentityBackfillCycle(): Promise<{
  sleepMs: number;
  status: string;
  detail: Record<string, unknown> | null;
}> {
  const candidates = fetchCandidates();
  if (candidates.length === 0) {
    return {
      sleepMs: IDLE_SLEEP_MS,
      status: 'idle',
      detail: { scanned: 0, resolved: 0, reused: 0, skipped: 0, failed: 0 },
    };
  }

  let resolved = 0;
  let reused = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const handle = normalizeTwitterHandle(candidate.twitter);
    if (!handle) {
      skipped += 1;
      continue;
    }
    const key = handle.toLowerCase();

    const cached = readTwitterIdentityCache(key);
    if (cached?.userId) {
      // Positive cache: handle→userId already known, fill without another
      // provider call.
      applyResolvedIdentity({
        userId: cached.userId,
        handle: cached.username || handle,
        avatarUrl: cached.avatarUrl,
        targetUserId: candidate.id,
      });
      reused += 1;
      continue;
    }
    if (cached) {
      // Unexpired negative cache: recently failed to resolve — throttle.
      skipped += 1;
      continue;
    }

    let lookup: Awaited<ReturnType<typeof lookupUserWithConfiguredProviders>>;
    try {
      lookup = await lookupUserWithConfiguredProviders(key);
    } catch {
      lookup = null;
    }

    if (!lookup?.user.id || !lookup.user.handle) {
      upsertTwitterIdentityCache({
        handle: key,
        provider: 'auto',
        userId: null,
        username: key,
        avatarUrl: null,
        expiresAtMs: Date.now() + NEGATIVE_CACHE_TTL_MS,
        lastError: 'backfill_lookup_failed',
      });
      failed += 1;
      continue;
    }

    const userId = lookup.user.id.trim();
    const resolvedHandle = lookup.user.handle.trim();
    const avatarUrl = lookup.user.avatarUrl?.trim() || null;

    applyResolvedIdentity({
      userId,
      handle: resolvedHandle,
      avatarUrl,
      targetUserId: candidate.id,
    });
    upsertTwitterIdentityCache({
      handle: key,
      provider: lookup.provider,
      userId,
      username: resolvedHandle,
      avatarUrl,
      expiresAtMs: Date.now() + POSITIVE_CACHE_TTL_MS,
      lastError: null,
    });
    resolved += 1;
  }

  return {
    sleepMs: BUSY_SLEEP_MS,
    status: resolved > 0 || reused > 0 ? 'ok' : 'idle',
    detail: {
      scanned: candidates.length,
      resolved,
      reused,
      skipped,
      failed,
    },
  };
}
