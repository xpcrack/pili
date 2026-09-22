import 'server-only';

import {
  appendCompletenessRunSource,
  claimCompletenessPokes,
  createCompletenessRun,
  deleteClaimedCompletenessPokes,
  finishCompletenessRun,
  readCompletenessGlobalState,
  releaseClaimedCompletenessPokes,
  readCompletenessSourceStates,
  readPendingCompletenessPokes,
  saveCompletenessGlobalState,
  saveCompletenessSourceState,
} from '@/lib/server/completenessRepo';
import { createCompletenessMaintenanceService, computeCompletenessRetryDelayMs } from '@/lib/server/completenessMaintenanceService';
import { createBlockchainCompletenessAdapter } from '@/lib/server/completenessSourceAdapters/blockchain';
import { createTelegramBridgeCompletenessAdapter } from '@/lib/server/completenessSourceAdapters/telegramBridge';
import { createTelegramChannelCompletenessAdapter } from '@/lib/server/completenessSourceAdapters/telegramChannel';
import { createTwitterCompletenessAdapter } from '@/lib/server/completenessSourceAdapters/twitter';
import type {
  CompletenessMaintenanceRunInput,
  CompletenessMaintenanceSourceRunSummary,
} from '@/lib/server/completenessMaintenanceService';
import type { CompletenessSource, CompletenessSourceState, CompletenessTrigger } from '@/lib/server/completenessTypes';
import { appendSyncLog } from '@/lib/server/syncLogRepo';
import { getSyncStatus, triggerSync, waitForSyncCompletion } from '@/lib/server/syncService';
import { getSyncStaleAfterMs } from '@/lib/server/syncService';
import { readSystemConfig } from '@/lib/server/systemConfigRepo';
import { backfillTelegramBridgeHistory } from '@/lib/server/telegramBridgeMtprotoBackfill';
import { backfillTelegramChannelSourceHistory } from '@/lib/server/telegramChannelSync';
import { listTelegramChannelSources } from '@/lib/server/telegramChannelSourceRepo';
import { createTelegramGramjsClient } from '@/lib/server/telegramGramjsClient';
import { readTelegramMtprotoPolicy, sleep } from '@/lib/server/telegramMtprotoPolicy';
import { listTrackedTwitterUsers, readTwitterCursor } from '@/lib/server/twitterRepo';
import { runTwitterSyncAction } from '@/lib/server/twitterSyncService';
import { acquireIngestionLease, heartbeatIngestionLease, releaseIngestionLease } from '@/lib/server/twitterRepo';
import { upsertWorkerStatus } from '@/lib/server/workerStateRepo';
import { refreshCurrentHoldings } from '@/lib/server/holdingsRefreshRuntime';
import { walletActivityBackfillQueue } from '@/lib/server/walletActivityBackfillQueue';
import { countPendingLiveDoorbells } from '@/lib/server/liveDoorbellQueue';
import {
  gmgnConfiguredAccountBucketKeys,
  gmgnCooldownRemainingMs,
  gmgnEgressCooldownRemainingMs,
  gmgnLastBanAgeMs,
} from '@/lib/server/gmgnRateLimit';
import { sweepStaleWalletTimelines } from '@/lib/server/walletTimelineSweep';

const WORKER_KEY = 'completeness-maintenance';
const WORKER_TYPE = 'completeness-maintenance';
const WORKER_LEASE_TTL_MS = 90_000;
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const BUSY_RETRY_DELAY_MS = 30_000;
// When wallet-activity backfill hits a GMGN ban, hold off until the shared ban
// cooldown (gmgnRateLimit.ts, ~5.5min, renewed on every hit) naturally expires.
// Without this, the drain loop keeps hitting GMGN every cycle and renewing the
// ban forever — which also starves live-monitor (shares the same cooldown) and
// breaks the on-chain feed.
const GMGN_BAN_BACKOFF_MARGIN_MS = 10_000;
// 封禁解除后的宽限窗：live-monitor 恢复期（6min 慢启动）一过就先补扫冷却期
// 攒下的 held doorbells（实时交易）；此时 timeline 回填若立刻全速翻页，会和
// 实时路径抢同一份刚解封的配额，容易"续杯再封"把 live 再冻一小时
// （2026-09-22 Rop 三笔 $AI 卖出延迟 75min 事故）。默认封禁后 10min 内
// timeline 维护不碰 GMGN；PILI_TIMELINE_RECOVERY_GRACE_MS=0 关闭。
const _RAW_TIMELINE_GRACE = Number(process.env.PILI_TIMELINE_RECOVERY_GRACE_MS);
const TIMELINE_RECOVERY_GRACE_MS =
  Number.isFinite(_RAW_TIMELINE_GRACE) && _RAW_TIMELINE_GRACE >= 0
    ? _RAW_TIMELINE_GRACE
    : 10 * 60_000;
// B8: 严格校验——parseInt("abc")→NaN 会让刷新条件恒 false（永不刷新），
// parseInt("1h")→1 会每个 cycle 都全量刷新打爆 GMGN 配额。非法/过小值
// 回退默认并告警一次。
const _RAW_HOLDINGS_INTERVAL = Number.parseInt(process.env.PILI_HOLDINGS_REFRESH_INTERVAL_MS ?? '', 10);
const HOLDINGS_REFRESH_INTERVAL_MS =
  Number.isFinite(_RAW_HOLDINGS_INTERVAL) && _RAW_HOLDINGS_INTERVAL >= 60_000
    ? _RAW_HOLDINGS_INTERVAL
    : (() => {
        if (process.env.PILI_HOLDINGS_REFRESH_INTERVAL_MS) {
          console.warn(
            `[completeness-worker] invalid PILI_HOLDINGS_REFRESH_INTERVAL_MS=${process.env.PILI_HOLDINGS_REFRESH_INTERVAL_MS}, falling back to 3600000`
          );
        }
        return 60 * 60_000; // 默认 1 小时
      })();
// B4: 刷新失败后的短重试间隔（5 分钟），避免等完整周期。
const HOLDINGS_REFRESH_RETRY_MS = 5 * 60_000;
/** Backfill yields to live traffic only when doorbell backlog is significant.
 * 阈值必须高于稳态积压：活跃交易者持续 ring + nack 重试使队列常驻在
 * claim limit（40）附近；用 >0 判定会让 timeline 回填永久饿死
 * （2026-07 底至 09 初实际停摆）。 */
const DOORBELL_PENDING_BACKFILL_PAUSE = 100;
walletActivityBackfillQueue.setShouldPause(
  () => countPendingLiveDoorbells() > DOORBELL_PENDING_BACKFILL_PAUSE
);

function walletTimelineMaintenanceEnabled() {
  // pili is the complete local database for observed wallets. The rolling
  // activity sweep is therefore on by default; set explicit 0 only for an
  // operator maintenance window.
  return process.env.PILI_WALLET_TIMELINE_MAINTENANCE !== '0';
}

function walletTimelineDrainMaxJobs() {
  // With openapi key pool, default higher than the old serial cli path.
  const n = Number(process.env.PILI_WALLET_TIMELINE_DRAIN_MAX_JOBS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2;
}

async function runWalletTimelineMaintenance() {
  if (process.env.PILI_GMGN_RECOVERY_PAUSED === '1') {
    console.log('[completeness-worker] wallet-timeline-maintenance skip (self-holdings recovery)');
    return { sweep: null, walletBackfill: null };
  }
  const pendingDoorbells = countPendingLiveDoorbells();
  if (pendingDoorbells > DOORBELL_PENDING_BACKFILL_PAUSE) {
    console.log(
      `[completeness-worker] wallet-timeline-maintenance skip (live doorbells pending=${pendingDoorbells})`
    );
    return { sweep: null, walletBackfill: null };
  }
  // 冷却守卫：GMGN 冷却期完全不 drain（sweep 也跳过——sweep 只是入队，
  // 入队无请求，但跳过可以避免恢复瞬间队列里攒一批货全速打）。
  // 冷却解除后下一轮循环自然恢复，backfill 翻页自身另有 1.2s 间隔兜底。
  const coolRemaining = Math.max(
    gmgnCooldownRemainingMs(),
    ...gmgnConfiguredAccountBucketKeys().map((scope) =>
      gmgnEgressCooldownRemainingMs(scope)
    ),
  );
  if (coolRemaining > 0) {
    console.log(
      `[completeness-worker] wallet-timeline-maintenance skip (GMGN cooldown ${Math.ceil(coolRemaining / 1000)}s)`
    );
    return { sweep: null, walletBackfill: null };
  }
  // 封禁后宽限（基于 lastBanAt，冷却被清零/过期后依然生效）：把解封后的
  // 第一波配额让给 live-monitor 的 doorbell 补扫，见 TIMELINE_RECOVERY_GRACE_MS。
  const lastBanAgeMs = gmgnLastBanAgeMs();
  if (lastBanAgeMs < TIMELINE_RECOVERY_GRACE_MS) {
    console.log(
      `[completeness-worker] wallet-timeline-maintenance skip (post-ban grace ${Math.ceil((TIMELINE_RECOVERY_GRACE_MS - lastBanAgeMs) / 1000)}s)`
    );
    return { sweep: null, walletBackfill: null };
  }
  // Sweep (re-enqueue all stale monitored wallets) is opt-in only.
  // Drain always runs so enablement / admin / manual seeds still process.
  let sweep: ReturnType<typeof sweepStaleWalletTimelines> | null = null;
  if (walletTimelineMaintenanceEnabled()) {
    try {
      sweep = sweepStaleWalletTimelines();
      if (sweep.enqueued > 0 || sweep.scannedStale > 0) {
        console.log(
          `[completeness-worker] wallet-timeline-sweep stale=${sweep.scannedStale} enqueued=${sweep.enqueued} pending=${sweep.pendingAfter}`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[completeness-worker] wallet-timeline-sweep failed: ${message}`);
    }
  }

  let walletBackfill: {
    processed: number;
    remaining: number;
    stoppedOnBan: boolean;
  } | null = null;
  try {
    const q = await walletActivityBackfillQueue.drain({
      maxJobs: walletTimelineDrainMaxJobs(),
    });
    if (q.processed > 0 || q.remaining > 0) {
      walletBackfill = {
        processed: q.processed,
        remaining: q.remaining,
        stoppedOnBan: q.stoppedOnBan,
      };
      console.log(
        `[completeness-worker] wallet-activity-backfill processed=${q.processed} remaining=${q.remaining} ban=${q.stoppedOnBan}`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[completeness-worker] wallet-activity-backfill drain failed: ${message}`);
  }

  return { sweep, walletBackfill };
}

let lastHoldingsRefreshMs = 0;

function normalizeOptionalString(value: string | null | undefined) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isTerminalCapabilityError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Missing TELEGRAM_API_ID|Missing TELEGRAM_API_HASH|Telegram user session required|not authorized/i.test(message);
}

function buildBlockedOrRetryingResult(input: {
  state: CompletenessSourceState;
  error: unknown;
}) {
  const message = normalizeOptionalString(input.error instanceof Error ? input.error.message : String(input.error)) || 'unknown completeness source error';
  const terminal = isTerminalCapabilityError(input.error);
  return {
    status: terminal ? ('blocked' as const) : ('retrying' as const),
    provenStartMs: input.state.provenStartMs,
    provenEndMs: input.state.provenEndMs,
    fetchedCount: 0,
    storedCount: 0,
    projectedCount: 0,
    blockedReason: message,
    checkpointJson: input.state.checkpointJson,
    madeProgress: false,
  };
}

function ensureGlobalStateConfiguredStartMs() {
  const config = readSystemConfig();
  const globalState = readCompletenessGlobalState();
  if (!globalState) {
    saveCompletenessGlobalState({
      configuredStartMs: config.completenessStartMs,
      globalProvenStartMs: null,
      status: config.completenessStartMs ? 'partial' : 'idle',
      activeRunId: null,
      lastSuccessAt: null,
      lastFailureAt: null,
    });
    return config.completenessStartMs;
  }

  if (globalState.configuredStartMs !== config.completenessStartMs) {
    saveCompletenessGlobalState({
      ...globalState,
      configuredStartMs: config.completenessStartMs,
      status: config.completenessStartMs ? globalState.status : 'idle',
    });
  }
  return config.completenessStartMs;
}

function buildSourceAdapters() {
  return {
    blockchain: createBlockchainCompletenessAdapter({
      triggerBackfillStep: async ({ reason, options }) => triggerSync(reason, options),
      waitForBackfillStep: async () => {
        await waitForSyncCompletion();
      },
      readWindowState: () => getSyncStatus().windowState,
      readSyncCompletedAtMs: () => getSyncStatus().lastSuccessAt,
      readSyncStaleAfterMs: () => getSyncStaleAfterMs(),
    }),
    twitter: createTwitterCompletenessAdapter({
      listTrackedUsers: () => listTrackedTwitterUsers(),
      runSyncAction: async ({ action, userId, windowDays, force }) => {
        const result = await runTwitterSyncAction({
          action,
          userId,
          windowDays,
          force,
        });
        return {
          ok: result.ok,
          error: result.ok ? undefined : result.error,
          summary:
            'summary' in result && result.summary && typeof result.summary === 'object'
              ? {
                  budgetExhausted:
                    'budgetExhausted' in result.summary ? Boolean(result.summary.budgetExhausted) : undefined,
                  budgetReasons:
                    'budgetReasons' in result.summary && Array.isArray(result.summary.budgetReasons)
                      ? result.summary.budgetReasons.filter((value): value is string => typeof value === 'string')
                      : undefined,
                }
              : undefined,
        };
      },
      readCursor: (userId, lane) => readTwitterCursor(userId, lane),
    }),
    'telegram-bridge': createTelegramBridgeCompletenessAdapter({
      readBridgeTargets: () => {
        const config = readSystemConfig();
        return [
          config.telegramTradeMonitorSourceChatId
            ? { chatId: config.telegramTradeMonitorSourceChatId, mode: 'telegram-monitor' as const }
            : null,
          config.telegramTwitterMonitorSourceChatId
            ? { chatId: config.telegramTwitterMonitorSourceChatId, mode: 'twitter-relay' as const }
            : null,
        ].filter((item): item is { chatId: string; mode: 'telegram-monitor' | 'twitter-relay' } => Boolean(item));
      },
      backfillHistory: async ({ beforeByChatId, startMs, endMs }) => {
        const client = await createTelegramGramjsClient();
        try {
          return await backfillTelegramBridgeHistory({
            client,
            beforeByChatId,
            startMs,
            endMs,
            limitPerChat: readTelegramMtprotoPolicy().bridgeBackfillLimit,
          });
        } finally {
          await client.disconnect?.();
        }
      },
    }),
    'telegram-channel': createTelegramChannelCompletenessAdapter({
      listEnabledSources: () => listTelegramChannelSources({ enabledOnly: true }),
      backfillSourceHistory: async ({ source, beforeMessageId, startMs, endMs }) => {
        const client = await createTelegramGramjsClient();
        try {
          return await backfillTelegramChannelSourceHistory({
            sourceId: source.id,
            client,
            beforeMessageId,
            startMs,
            endMs,
          });
        } finally {
          await client.disconnect?.();
        }
      },
    }),
  } as const;
}

function buildOwnerId() {
  return `${process.pid}:${Date.now().toString(36)}:${Math.random().toString(16).slice(2, 8)}`;
}

function summarizeRun(input: {
  sourceResults: CompletenessMaintenanceSourceRunSummary[];
  status: string;
  globalProvenStartMs: number | null;
}) {
  const blockedSources = input.sourceResults.filter((result) => result.status === 'blocked').map((result) => result.source);
  const partialSources = input.sourceResults
    .filter((result) => result.status === 'partial' || result.status === 'retrying')
    .map((result) => result.source);

  return {
    status: input.status,
    globalProvenStartMs: input.globalProvenStartMs,
    blockedSources,
    partialSources,
    selectedSources: input.sourceResults.map((result) => result.source),
  };
}

function upsertCompletenessWorkerStatus(status: string, lastError?: string | null) {
  upsertWorkerStatus({
    workerKey: WORKER_KEY,
    workerType: WORKER_TYPE,
    status,
    lastError: lastError || null,
  });
}

export async function runCompletenessMaintenancePass(input: CompletenessMaintenanceRunInput) {
  const configuredStartMs = ensureGlobalStateConfiguredStartMs();
  const ownerId = buildOwnerId();
  const nowMs = Date.now();
  if (!acquireIngestionLease(WORKER_KEY, ownerId, nowMs, WORKER_LEASE_TTL_MS)) {
    return {
      started: false,
      status: readCompletenessGlobalState()?.status || 'idle',
      globalProvenStartMs: readCompletenessGlobalState()?.globalProvenStartMs ?? null,
      sourceResults: [] as CompletenessMaintenanceSourceRunSummary[],
      busy: true,
    };
  }

  // B1: 租约只在开头 acquire 一次，而 runOnce 内部（MTProto 历史回填等）单步可能
  // 超过 90s TTL。没有心跳续期时，第二个进入者会在 TTL 过期后抢走租约，造成并发
  // 回填 + checkpoint 互相覆盖。每 ttl/3 续期一次；丢租约后停止启动新的 source step。
  const leaseHeartbeatTimer = setInterval(() => {
    const alive = heartbeatIngestionLease(WORKER_KEY, ownerId, Date.now(), WORKER_LEASE_TTL_MS);
    if (!alive) {
      console.warn('[completeness-worker] lease lost during maintenance pass');
    }
    leaseAlive = alive;
  }, Math.floor(WORKER_LEASE_TTL_MS / 3));
  leaseHeartbeatTimer.unref?.();

  let leaseAlive = true;
  let run: { id: number } | null = null;
  try {
    run = createCompletenessRun({
      reason: input.reason ?? null,
      trigger: input.trigger,
      configuredStartMs,
    });
    const adapters = buildSourceAdapters();
    const service = createCompletenessMaintenanceService({
      // 丢租约后不再启动新的 source step（B1）。
      acquireLease: async () => leaseAlive,
      releaseLease: async () => {},
      readGlobalState: async () => readCompletenessGlobalState(),
      readSourceStates: async () => readCompletenessSourceStates(),
      saveGlobalState: async (state) => {
        saveCompletenessGlobalState(state);
      },
      saveSourceState: async (state) => {
        saveCompletenessSourceState(state);
      },
      appendSyncLog: async (log) => {
        appendSyncLog(log);
      },
      runSource: async (sourceInput) => {
        const adapter = adapters[sourceInput.source];
        try {
          return await adapter.runStep({
            state: sourceInput.state,
            configuredStartMs: sourceInput.configuredStartMs,
            trigger: sourceInput.trigger,
            reason: sourceInput.reason,
          });
        } catch (error) {
          return buildBlockedOrRetryingResult({
            state: sourceInput.state,
            error,
          });
        }
      },
    });

    const result = await service.runOnce(input);
    for (const sourceResult of result.sourceResults) {
      appendCompletenessRunSource({
        runId: run.id,
        source: sourceResult.source,
        requestedStartMs: sourceResult.requestedStartMs,
        provenStartMs: sourceResult.provenStartMs,
        provenEndMs: sourceResult.provenEndMs,
        status: sourceResult.status,
        fetchedCount: sourceResult.fetchedCount,
        storedCount: sourceResult.storedCount,
        projectedCount: sourceResult.projectedCount,
        blockedReason: sourceResult.blockedReason,
        checkpointJson: sourceResult.checkpointJson,
      });
    }

    finishCompletenessRun(run.id, result.status, summarizeRun(result));
    upsertCompletenessWorkerStatus(result.status, result.status === 'blocked' ? 'one or more completeness sources blocked' : null);
    return {
      ...result,
      busy: false,
    };
  } catch (error) {
    // B2: 异常路径必须给 run 一个结束状态，否则 completeness_runs 残留永久
    // running 记录、全局状态保留错误 activeRunId。收尾本身 best-effort，
    // 不能吞掉原始错误（worker loop 依赖它做重试/退避）。
    if (run) {
      try {
        finishCompletenessRun(run.id, 'blocked', {
          status: 'blocked',
          error: error instanceof Error ? error.message : String(error),
        });
      } catch (finishError) {
        console.warn('[completeness-worker] failed to mark run as blocked:', finishError instanceof Error ? finishError.message : finishError);
      }
    }
    throw error;
  } finally {
    clearInterval(leaseHeartbeatTimer);
    releaseIngestionLease(WORKER_KEY, ownerId);
  }
}

function mergePokesIntoRunInput(pokes: ReturnType<typeof readPendingCompletenessPokes>): CompletenessMaintenanceRunInput {
  const first = pokes[0];
  const uniqueSourceHints = Array.from(new Set(pokes.map((poke) => poke.sourceHint).filter((value): value is CompletenessSource => Boolean(value))));
  const reason = Array.from(new Set(pokes.map((poke) => normalizeOptionalString(poke.reason)).filter((value): value is string => Boolean(value)))).join(', ');
  return {
    trigger: first?.trigger || 'interval',
    source: uniqueSourceHints.length === 1 ? uniqueSourceHints[0] : null,
    reason: reason || (first?.reason ?? null),
  };
}

interface CompletenessMaintenanceWorkerCycleDeps {
  ensureGlobalStateConfiguredStartMs: typeof ensureGlobalStateConfiguredStartMs;
  readCompletenessGlobalState: typeof readCompletenessGlobalState;
  readPendingCompletenessPokes: typeof readPendingCompletenessPokes;
  claimCompletenessPokes: typeof claimCompletenessPokes;
  releaseClaimedCompletenessPokes: typeof releaseClaimedCompletenessPokes;
  deleteClaimedCompletenessPokes: typeof deleteClaimedCompletenessPokes;
  runCompletenessMaintenancePass: typeof runCompletenessMaintenancePass;
  readCompletenessSourceStates: typeof readCompletenessSourceStates;
  runWalletTimelineMaintenance: typeof runWalletTimelineMaintenance;
  now?: () => number;
}

export function createCompletenessMaintenanceWorkerCycle(
  overrides: Partial<CompletenessMaintenanceWorkerCycleDeps> = {}
) {
  const deps: CompletenessMaintenanceWorkerCycleDeps = {
    ensureGlobalStateConfiguredStartMs,
    readCompletenessGlobalState,
    readPendingCompletenessPokes,
    claimCompletenessPokes,
    releaseClaimedCompletenessPokes,
    deleteClaimedCompletenessPokes,
    runCompletenessMaintenancePass,
    readCompletenessSourceStates,
    runWalletTimelineMaintenance,
    ...overrides,
  };

  return async function runCompletenessMaintenanceWorkerCycle() {
    deps.ensureGlobalStateConfiguredStartMs();
    const pokes = deps.readPendingCompletenessPokes(20);
    const pendingIds = pokes.map((poke) => poke.id);
    const claimedAt = deps.now ? deps.now() : Date.now();
    const claimedIds =
      pendingIds.length > 0 ? deps.claimCompletenessPokes(pendingIds, claimedAt) : [];
    const claimedIdSet = new Set(claimedIds);
    const claimedPokes = pokes.filter((poke) => claimedIdSet.has(poke.id));
    if (claimedIds.length > 0) {
      // no-op: claiming already happened above so we can know exactly which ids we own
    }

    if (pendingIds.length > 0 && claimedIds.length === 0) {
      const globalState = deps.readCompletenessGlobalState();
      return {
        started: false,
        status: globalState?.status || 'idle',
        globalProvenStartMs: globalState?.globalProvenStartMs ?? null,
        sourceResults: [],
        busy: true,
        sleepMs: BUSY_RETRY_DELAY_MS,
        claimedPokeCount: 0,
      };
    }

    try {
      const input =
        claimedPokes.length > 0
          ? mergePokesIntoRunInput(claimedPokes)
          : { trigger: 'interval' as CompletenessTrigger, reason: 'periodic sweep' };
      const result = await deps.runCompletenessMaintenancePass(input);
      const sourceStates = deps.readCompletenessSourceStates();
      const retryDelayMs = sourceStates
        .filter((state) => state.status === 'retrying')
        .map((state) => computeCompletenessRetryDelayMs(state.failureCount))
        .reduce((best, current) => (best === null ? current : Math.min(best, current)), null as number | null);

      if (claimedIds.length > 0) {
        if (result.busy) {
          deps.releaseClaimedCompletenessPokes(claimedIds, claimedAt);
        } else {
          deps.deleteClaimedCompletenessPokes(claimedIds, claimedAt);
        }
      }

      // Rolling 14d wallet timeline: re-enqueue stale monitored addrs, then drain queue
      const { walletBackfill } = await deps.runWalletTimelineMaintenance();

      // Backfill hit the shared GMGN ban → sleep until it expires so the next
      // drain doesn't immediately renew it (which would lock out live-monitor).
      const banBackoffMs = walletBackfill?.stoppedOnBan
        ? gmgnCooldownRemainingMs() + GMGN_BAN_BACKOFF_MARGIN_MS
        : 0;

      return {
        ...result,
        sleepMs: Math.max(
          banBackoffMs,
          result.busy ? BUSY_RETRY_DELAY_MS : retryDelayMs ?? DEFAULT_INTERVAL_MS
        ),
        claimedPokeCount: claimedIds.length,
        walletActivityBackfill: walletBackfill,
      };
    } catch (error) {
      if (claimedIds.length > 0) {
        deps.releaseClaimedCompletenessPokes(claimedIds, claimedAt);
      }
      throw error;
    }
  };
}

export async function runCompletenessMaintenanceWorkerCycleWithDeps(
  overrides: Partial<CompletenessMaintenanceWorkerCycleDeps> = {}
) {
  return createCompletenessMaintenanceWorkerCycle(overrides)();
}

export const runCompletenessMaintenanceWorkerCycle = createCompletenessMaintenanceWorkerCycle();

export async function runCompletenessMaintenanceWorkerLoop() {
  upsertCompletenessWorkerStatus('running');
  // B4: 持仓刷新与完整性周期解耦——cycle 抛错时控制流不能跳过持仓刷新，
  // 否则 Telegram/Twitter 的持续错误会连带饿死持仓数据。失败后用短间隔重试
  // 而不是等完整 1h 周期。
  let lastHoldingsAttemptMs = 0;
  const maybeRefreshHoldings = async () => {
    const nowMs = Date.now();
    const dueMs = lastHoldingsRefreshMs > 0 && lastHoldingsRefreshMs === lastHoldingsAttemptMs
      ? HOLDINGS_REFRESH_RETRY_MS // 上次失败 → 短重试间隔
      : HOLDINGS_REFRESH_INTERVAL_MS;
    if (nowMs - lastHoldingsAttemptMs < dueMs) return;
    lastHoldingsAttemptMs = nowMs;
    console.log('[completeness-worker] triggering holdings refresh...');
    try {
      const result = await refreshCurrentHoldings();
      lastHoldingsRefreshMs = nowMs; // 仅成功后更新成功时间戳
      console.log(`[completeness-worker] holdings refresh: ${result.summary.refreshedWalletCount} refreshed, ${result.summary.failedWalletCount} failed`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[completeness-worker] holdings refresh failed: ${message}`);
    }
  };

  while (true) {
    let cycleSleepMs = BUSY_RETRY_DELAY_MS;
    try {
      const cycle = await runCompletenessMaintenanceWorkerCycle();
      cycleSleepMs = cycle.sleepMs;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      upsertCompletenessWorkerStatus('error', message);
    }
    // 无论 cycle 成功还是抛错，都检查持仓刷新是否到期。
    await maybeRefreshHoldings();
    await sleep(cycleSleepMs);
  }
}
