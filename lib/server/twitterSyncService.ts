import 'server-only';

import {
  createTwitterFetcher,
  type TwitterFetcherProvider,
  type TwitterFetcherSeedByHandle,
} from '@/lib/server/twitterFetcher';
import { projectTwitterTweetsToFeed } from '@/lib/server/twitterFeedMapper';
import { listRecentTelegramMonitorEvents } from '@/lib/server/telegramMonitorRepo';
import {
  acquireIngestionLease,
  countTwitterStaleFeedRows,
  createTwitterSyncRun,
  finishTwitterSyncRun,
  heartbeatIngestionLease,
  listTrackedTwitterUsers,
  listTwitterTweetsForReconcile,
  readIngestionLease,
  readRecentTwitterSyncRuns,
  readTwitterCursor,
  releaseIngestionLease,
  touchTwitterCursorLastSuccess,
  upsertTwitterCursor,
  upsertTwitterTweets,
  type TwitterLane,
  type TwitterRelationType,
  type TwitterSyncAction,
  type UpsertTwitterTweetInput,
} from '@/lib/server/twitterRepo';
import { isStructuredProvider } from '@/lib/server/twitterProviderRouter';
import { collectTwitterStatusUrls, upsertEventTweetRefAndFetchMissing } from '@/lib/server/twitterLinkRefs';
import { appendSyncLog, pruneSyncLogs } from '@/lib/server/syncLogRepo';

const TWITTER_SYNC_LOCK_KEY = 'twitter-sync-global';
const LEASE_TTL_MS = 180000;
const HEARTBEAT_MS = 30000;

const LOOKBACK_SEC = 900;
const LOOKBACK_WINDOW_FLOOR_SEC = 300;
const BOOTSTRAP_WINDOW_HOURS = 24;

const FETCH_MAX_ITEMS_PER_LANE = 200;

const BACKFILL_MAX_DEPTH = 2;
const BACKFILL_MAX_NODES_PER_ROOT = 40;
const BACKFILL_MAX_NODES_PER_ACCOUNT_PER_RUN = 120;
const BACKFILL_MAX_RUNTIME_MS_PER_ACCOUNT = 120000;
const BACKFILL_MAX_RETRIES_PER_NODE = 2;

interface BackfillQueueItem {
  rootTweetId: string;
  relationType: TwitterRelationType;
  targetTweetId: string;
  depth: number;
  attempts: number;
}

interface SyncSummary {
  fetchedCount: number;
  storedCount: number;
  projectedCount: number;
  backfillEnqueuedCount: number;
  backfillFetchedCount: number;
  budgetExhausted: boolean;
  budgetReasons: string[];
  userCount: number;
  laneCount: number;
  providerHits: Record<string, number>;
}

type TwitterSyncFetcher = Pick<ReturnType<typeof createTwitterFetcher>, 'fetchUserTweets' | 'fetchTweetsByIds'>;

export function shouldAdvanceTwitterCoverageCursor(input: {
  provider: TwitterFetcherProvider;
  coverageEstablished?: boolean;
}) {
  if (input.provider === 'noop') {
    return false;
  }
  if (isStructuredProvider(input.provider)) {
    return input.coverageEstablished === true;
  }
  return true;
}

function computeSinceMs(userId: string, lane: TwitterLane, nowMs: number) {
  const cursor = readTwitterCursor(userId, lane);
  if (typeof cursor?.coveredSinceMs === 'number' && !cursor?.watermarkCreatedAtMs) {
    return Math.max(0, cursor.coveredSinceMs);
  }
  if (!cursor?.watermarkCreatedAtMs) {
    return Math.max(0, nowMs - BOOTSTRAP_WINDOW_HOURS * 60 * 60 * 1000);
  }

  const lookbackMs = LOOKBACK_SEC * 1000;
  const floorMs = nowMs - LOOKBACK_WINDOW_FLOOR_SEC * 1000;
  const sinceMs = cursor.watermarkCreatedAtMs - lookbackMs;
  return Math.min(sinceMs, floorMs);
}

function chooseLaneWatermark(tweets: UpsertTwitterTweetInput[]) {
  if (tweets.length === 0) {
    return null;
  }

  return tweets.reduce((best, current) => {
    if (!best) {
      return current;
    }
    if (current.createdAtMs !== best.createdAtMs) {
      return current.createdAtMs > best.createdAtMs ? current : best;
    }
    return current.tweetId.localeCompare(best.tweetId) > 0 ? current : best;
  }, null as UpsertTwitterTweetInput | null);
}

function dedupeLaneTweets(tweets: UpsertTwitterTweetInput[], lane: TwitterLane) {
  const byId = new Map<string, UpsertTwitterTweetInput>();
  for (const tweet of tweets) {
    if (!tweet.tweetId) {
      continue;
    }
    byId.set(tweet.tweetId, {
      ...tweet,
      lane,
    });
  }
  return Array.from(byId.values());
}

function enqueueBackfillRelations(
  queue: BackfillQueueItem[],
  dedupeKeys: Set<string>,
  rootNodeCounts: Map<string, number>,
  sourceTweet: UpsertTwitterTweetInput,
  depth: number,
  budgetReasons: Set<string>
) {
  const enqueue = (relationType: TwitterRelationType, targetTweetId: string | undefined) => {
    const target = (targetTweetId || '').trim();
    if (!target) {
      return;
    }

    const root = sourceTweet.tweetId;
    const currentRootCount = rootNodeCounts.get(root) || 0;
    if (currentRootCount >= BACKFILL_MAX_NODES_PER_ROOT) {
      budgetReasons.add('root_node_limit');
      return;
    }

    const key = `${relationType}|${target}`;
    if (dedupeKeys.has(key)) {
      return;
    }

    dedupeKeys.add(key);
    rootNodeCounts.set(root, currentRootCount + 1);
    queue.push({
      rootTweetId: root,
      relationType,
      targetTweetId: target,
      depth,
      attempts: 0,
    });
  };

  enqueue('reply_target', sourceTweet.replyToTweetId);
  enqueue('quote_source', sourceTweet.quoteTweetId);
}

async function processBackfillQueue(params: {
  queue: BackfillQueueItem[];
  budgetReasons: Set<string>;
  accountDeadlineMs: number;
  knownTweetIds: Set<string>;
  fetchByIds: (ids: string[]) => Promise<{ provider: string; tweets: UpsertTwitterTweetInput[] }>;
  providerHits: Record<string, number>;
}) {
  let processedNodes = 0;
  let fetchedCount = 0;
  let enqueuedCount = params.queue.length;

  const dedupeKeys = new Set(params.queue.map((item) => `${item.relationType}|${item.targetTweetId}`));
  const rootNodeCounts = new Map<string, number>();
  for (const item of params.queue) {
    rootNodeCounts.set(item.rootTweetId, (rootNodeCounts.get(item.rootTweetId) || 0) + 1);
  }

  while (params.queue.length > 0) {
    if (Date.now() > params.accountDeadlineMs) {
      params.budgetReasons.add('runtime_limit');
      break;
    }
    if (processedNodes >= BACKFILL_MAX_NODES_PER_ACCOUNT_PER_RUN) {
      params.budgetReasons.add('account_node_limit');
      break;
    }

    const item = params.queue.shift();
    if (!item) {
      break;
    }
    processedNodes += 1;

    if (item.depth > BACKFILL_MAX_DEPTH) {
      continue;
    }
    if (params.knownTweetIds.has(item.targetTweetId)) {
      continue;
    }

    const fetched = await params.fetchByIds([item.targetTweetId]);
    params.providerHits[fetched.provider] = (params.providerHits[fetched.provider] || 0) + 1;
    const fetchedTweet = fetched.tweets.find((tweet) => tweet.tweetId === item.targetTweetId);

    if (!fetchedTweet) {
      if (item.attempts < BACKFILL_MAX_RETRIES_PER_NODE) {
        params.queue.push({
          ...item,
          attempts: item.attempts + 1,
        });
      }
      continue;
    }

    const normalizedTweet: UpsertTwitterTweetInput = {
      ...fetchedTweet,
      lane: fetchedTweet.lane || 'timeline',
    };
    const stored = upsertTwitterTweets([normalizedTweet]);
    if (stored.storedCount > 0) {
      params.knownTweetIds.add(normalizedTweet.tweetId);
      fetchedCount += 1;
    }

    if (item.depth < BACKFILL_MAX_DEPTH) {
      const before = params.queue.length;
      enqueueBackfillRelations(
        params.queue,
        dedupeKeys,
        rootNodeCounts,
        normalizedTweet,
        item.depth + 1,
        params.budgetReasons
      );
      enqueuedCount += Math.max(0, params.queue.length - before);
    }
  }

  return {
    enqueuedCount,
    fetchedCount,
  };
}

function getTwitterSyncOverview() {
  const lease = readIngestionLease(TWITTER_SYNC_LOCK_KEY);
  const nowMs = Date.now();
  const runs = readRecentTwitterSyncRuns(20);
  const latestRun = (runs[0] || null) as { id?: number; status?: string } | null;
  const leaseActive = Boolean(lease && lease.expires_at_ms > nowMs);
  const stale = Boolean(latestRun && latestRun.status === 'running' && !leaseActive);

  return {
    running: leaseActive && !stale,
    stale,
    lockOwner: lease?.owner || null,
    leaseExpiresAtMs: lease?.expires_at_ms || null,
    heartbeatAtMs: lease?.heartbeat_at_ms || null,
    latestRun,
    runs,
  };
}

async function runSyncAction(options: {
  userId?: string | null;
  seedByHandle?: TwitterFetcherSeedByHandle;
  windowDays?: number;
  runId?: number;
  fetcherOverride?: TwitterSyncFetcher;
}) {
  const runId = typeof options.runId === 'number' ? options.runId : null;
  const fetcher = options.fetcherOverride || createTwitterFetcher(options.seedByHandle);
  const trackedUsers = listTrackedTwitterUsers().filter((user) =>
    options.userId?.trim() ? user.id === options.userId.trim() : true
  );
  const lanes: TwitterLane[] = ['timeline', 'replies'];

  const summary: SyncSummary = {
    fetchedCount: 0,
    storedCount: 0,
    projectedCount: 0,
    backfillEnqueuedCount: 0,
    backfillFetchedCount: 0,
    budgetExhausted: false,
    budgetReasons: [],
    userCount: trackedUsers.length,
    laneCount: 0,
    providerHits: {},
  };

  if (trackedUsers.length === 0) {
    appendSyncLog({
      runKind: 'twitter',
      runId,
      level: 'warn',
      phase: 'empty',
      message: 'no tracked twitter users',
    });
    return summary;
  }

  appendSyncLog({
    runKind: 'twitter',
    runId,
    level: 'info',
    phase: 'start',
    message: 'twitter sync started',
    payload: {
      userCount: trackedUsers.length,
      windowDays: options.windowDays ?? null,
    },
  });

  const budgetReasons = new Set<string>();
  const windowDaysOverride =
    typeof options.windowDays === 'number' && Number.isFinite(options.windowDays)
      ? Math.max(1, Math.min(30, Math.floor(options.windowDays)))
      : null;
  const overrideSinceMs = windowDaysOverride
    ? Date.now() - windowDaysOverride * 24 * 60 * 60 * 1000
    : null;

  for (const user of trackedUsers) {
    appendSyncLog({
      runKind: 'twitter',
      runId,
      level: 'info',
      phase: 'user-start',
      message: `sync user @${user.twitterHandle}`,
      payload: {
        userId: user.id,
        userName: user.name,
      },
    });

    const accountDeadlineMs = Date.now() + BACKFILL_MAX_RUNTIME_MS_PER_ACCOUNT;
    let projectionSinceMs = Number.MAX_SAFE_INTEGER;
    const knownTweetIds = new Set<string>();

    for (const lane of lanes) {
      const nowMs = Date.now();
      const baseSinceMs = computeSinceMs(user.id, lane, nowMs);
      const sinceMs = overrideSinceMs === null ? baseSinceMs : Math.min(baseSinceMs, overrideSinceMs);
      projectionSinceMs = Math.min(projectionSinceMs, sinceMs);
      const fetched = await fetcher.fetchUserTweets({
        handle: user.twitterHandle,
        lane,
        sinceMs,
        maxItems: FETCH_MAX_ITEMS_PER_LANE,
      });
      summary.providerHits[fetched.provider] = (summary.providerHits[fetched.provider] || 0) + 1;
      appendSyncLog({
        runKind: 'twitter',
        runId,
        level: 'debug',
        phase: 'lane-fetch',
        message: `fetched lane ${lane} via ${fetched.provider}`,
        payload: {
          userId: user.id,
          handle: user.twitterHandle,
          lane,
          provider: fetched.provider,
          fetchedCount: fetched.tweets.length,
        },
      });
      const laneTweets = dedupeLaneTweets(fetched.tweets, lane);

      for (const tweet of laneTweets) {
        knownTweetIds.add(tweet.tweetId);
      }

      summary.fetchedCount += laneTweets.length;
      const stored = upsertTwitterTweets(laneTweets);
      summary.storedCount += stored.storedCount;
      summary.laneCount += 1;

      const queue: BackfillQueueItem[] = [];
      const queueDedupe = new Set<string>();
      const rootNodeCounts = new Map<string, number>();
      for (const tweet of laneTweets) {
        enqueueBackfillRelations(queue, queueDedupe, rootNodeCounts, tweet, 1, budgetReasons);
      }

      const backfill = await processBackfillQueue({
        queue,
        budgetReasons,
        accountDeadlineMs,
        knownTweetIds,
        providerHits: summary.providerHits,
        fetchByIds: (ids: string[]) => fetcher.fetchTweetsByIds({ ids, intent: 'detail' }),
      });
      summary.backfillEnqueuedCount += backfill.enqueuedCount;
      summary.backfillFetchedCount += backfill.fetchedCount;

      const existingCursor = readTwitterCursor(user.id, lane);
      const shouldAdvanceCoverage = shouldAdvanceTwitterCoverageCursor({
        provider: fetched.provider,
        coverageEstablished: fetched.coverageEstablished,
      });
      const watermark = chooseLaneWatermark(laneTweets);
      const shouldStickIncompleteBootstrapCoverage =
        fetched.provider !== 'noop' &&
        isStructuredProvider(fetched.provider) &&
        fetched.coverageEstablished === false &&
        existingCursor?.watermarkCreatedAtMs == null;
      const coveredSinceMs = shouldAdvanceCoverage
        ? watermark
          ? sinceMs
          : null
        : shouldStickIncompleteBootstrapCoverage
          ? existingCursor?.coveredSinceMs ?? sinceMs
          : existingCursor?.coveredSinceMs ?? null;
      const nextWatermark = shouldAdvanceCoverage ? watermark : null;

      if (nextWatermark) {
        upsertTwitterCursor({
          userId: user.id,
          lane,
          coveredSinceMs,
          watermarkCreatedAtMs: nextWatermark.createdAtMs,
          watermarkTweetId: nextWatermark.tweetId,
          lastSuccessAtMs: Date.now(),
        });
      } else if (fetched.provider !== 'noop' && coveredSinceMs !== null) {
        touchTwitterCursorLastSuccess(user.id, lane, Date.now(), coveredSinceMs);
      } else if (shouldAdvanceCoverage) {
        touchTwitterCursorLastSuccess(user.id, lane, Date.now(), coveredSinceMs);
      }
    }

    const projected = projectTwitterTweetsToFeed({
      userId: user.id,
      sinceMs: projectionSinceMs === Number.MAX_SAFE_INTEGER ? 0 : projectionSinceMs,
    });
    summary.projectedCount += projected.projectedCount;

    appendSyncLog({
      runKind: 'twitter',
      runId,
      level: 'info',
      phase: 'user-done',
      message: `user sync done @${user.twitterHandle}`,
      payload: {
        userId: user.id,
        projectedCount: projected.projectedCount,
        fetchedCount: summary.fetchedCount,
        storedCount: summary.storedCount,
      },
    });
  }

  summary.budgetExhausted = budgetReasons.size > 0;
  summary.budgetReasons = Array.from(budgetReasons.values());
  appendSyncLog({
    runKind: 'twitter',
    runId,
    level: summary.budgetExhausted ? 'warn' : 'info',
    phase: 'done',
    message: 'twitter sync completed',
    payload: {
      fetchedCount: summary.fetchedCount,
      storedCount: summary.storedCount,
      projectedCount: summary.projectedCount,
      backfillFetchedCount: summary.backfillFetchedCount,
      providerHits: summary.providerHits,
      budgetExhausted: summary.budgetExhausted,
      budgetReasons: summary.budgetReasons,
    },
  });
  pruneSyncLogs();
  return {
    ...summary,
    windowDays: windowDaysOverride,
  };
}

async function runReplayAction(options: { userId?: string | null; windowDays: number }) {
  const windowDays = Math.max(1, Math.min(30, Math.floor(options.windowDays)));
  const sinceMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const projected = projectTwitterTweetsToFeed({
    userId: options.userId || null,
    sinceMs,
  });

  return {
    fetchedCount: 0,
    storedCount: 0,
    projectedCount: projected.projectedCount,
    backfillEnqueuedCount: 0,
    backfillFetchedCount: 0,
    budgetExhausted: false,
    budgetReasons: [],
    windowDays,
  };
}

async function runReconcileAction(options: { userId?: string | null; windowDays: number }) {
  const windowDays = Math.max(1, Math.min(30, Math.floor(options.windowDays)));
  const sinceMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const missingBefore = listTwitterTweetsForReconcile({
    userId: options.userId || null,
    sinceMs,
  });
  const projected = projectTwitterTweetsToFeed({
    userId: options.userId || null,
    sinceMs,
    tweetIds: missingBefore,
  });
  const missingAfter = listTwitterTweetsForReconcile({
    userId: options.userId || null,
    sinceMs,
  });
  const staleProjection = countTwitterStaleFeedRows();

  return {
    fetchedCount: 0,
    storedCount: 0,
    projectedCount: projected.projectedCount,
    backfillEnqueuedCount: 0,
    backfillFetchedCount: 0,
    budgetExhausted: false,
    budgetReasons: [],
    missingInFeedBefore: missingBefore.length,
    missingInFeedAfter: missingAfter.length,
    staleProjection,
    windowDays,
  };
}

export async function backfillRecentTelegramMonitorTweetRefs(limit = 200) {
  const rows = listRecentTelegramMonitorEvents(limit);
  const fetcher = createTwitterFetcher();

  let scanned = 0;
  let linked = 0;
  let fetched = 0;
  for (const row of rows) {
    scanned += 1;
    const tweetUrls = Array.from(
      new Set([...(row.messageLinks || []), ...collectTwitterStatusUrls(row.rawText || '')])
    );
    if (tweetUrls.length === 0) {
      continue;
    }

    const eventId = `xxyy-monitor:${row.chain}:${row.txHash || row.tokenAddress}:${row.eventTimeMs}`;
    const result = await upsertEventTweetRefAndFetchMissing({
      eventId,
      tweetUrls,
      refSource: 'historical-backfill',
      fetchTweetsByIds: async (ids) => fetcher.fetchTweetsByIds({ ids, intent: 'detail' }),
    });
    linked += result.refCount;
    fetched += result.fetchedCount;
  }

  return {
    scanned,
    linked,
    fetched,
  };
}

export async function runTwitterSyncAction(input?: {
  action?: TwitterSyncAction;
  userId?: string | null;
  windowDays?: number;
  seedByHandle?: TwitterFetcherSeedByHandle;
  fetcherOverride?: TwitterSyncFetcher;
}) {
  const action: TwitterSyncAction =
    input?.action === 'replay' || input?.action === 'reconcile' ? input.action : 'sync';
  const userId = typeof input?.userId === 'string' && input.userId.trim() ? input.userId.trim() : null;
  const owner = `${process.pid}:${Date.now().toString(36)}:${Math.random().toString(16).slice(2, 8)}`;

  if (!acquireIngestionLease(TWITTER_SYNC_LOCK_KEY, owner, Date.now(), LEASE_TTL_MS)) {
    return {
      ok: false,
      error: '同步正在进行中',
      errorCode: 'lease_not_acquired',
      status: getTwitterSyncOverview(),
    };
  }

  const run = createTwitterSyncRun(action, userId, null);
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let response:
    | {
        ok: true;
        action: TwitterSyncAction;
        runId: number;
        status: 'success' | 'partial';
        summary: unknown;
        syncStatus: ReturnType<typeof getTwitterSyncOverview>;
      }
    | {
        ok: false;
        action: TwitterSyncAction;
        runId: number;
        error: string;
        errorCode: 'runtime_error';
        status: ReturnType<typeof getTwitterSyncOverview>;
      };
  try {
    heartbeatTimer = setInterval(() => {
      heartbeatIngestionLease(TWITTER_SYNC_LOCK_KEY, owner, Date.now(), LEASE_TTL_MS);
    }, HEARTBEAT_MS);

    const summary =
      action === 'sync'
        ? await runSyncAction({
            userId,
            seedByHandle: input?.seedByHandle,
            windowDays: input?.windowDays,
            runId: run.id,
            fetcherOverride: input?.fetcherOverride,
          })
        : action === 'replay'
          ? await runReplayAction({
              userId,
              windowDays: input?.windowDays || 7,
            })
          : await runReconcileAction({
              userId,
              windowDays: input?.windowDays || 7,
            });

    const status = summary.budgetExhausted ? 'partial' : 'success';
    finishTwitterSyncRun(run.id, status, run.startedAtMs, {
      ...summary,
      budgetExhausted: summary.budgetExhausted,
      summary,
    });

    response = {
      ok: true,
      action,
      runId: run.id,
      status,
      summary,
      syncStatus: getTwitterSyncOverview(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'twitter 同步失败';
    appendSyncLog({
      runKind: 'twitter',
      runId: run.id,
      level: 'error',
      phase: 'failed',
      message,
      payload: {
        action,
      },
    });
    finishTwitterSyncRun(run.id, 'failed', run.startedAtMs, {
      errorCode: 'runtime_error',
      errorMessage: message,
      summary: {
        action,
      },
    });
    response = {
      ok: false,
      action,
      runId: run.id,
      error: message,
      errorCode: 'runtime_error',
      status: getTwitterSyncOverview(),
    };
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    releaseIngestionLease(TWITTER_SYNC_LOCK_KEY, owner);
  }

  if (response.ok) {
    return {
      ...response,
      syncStatus: getTwitterSyncOverview(),
    };
  }
  return {
    ...response,
    status: getTwitterSyncOverview(),
  };
}

export function getTwitterSyncStatus() {
  return getTwitterSyncOverview();
}
