import 'server-only';

import { getSyncStatus, triggerSync } from '@/lib/server/syncService';
import { listMonitoredUsers } from '@/lib/server/trackedUsersRepo';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

type FeedPrewarmStatusLike = {
  running?: boolean;
  latestRun?: {
    status?: string;
  } | null;
  windowState?: {
    globalEarliestMs?: number | null;
    perUserEarliestMs?: Record<string, number | undefined>;
  } | null;
};

interface TriggerStartupPrewarmDeps {
  now?: number;
  getStatus?: () => FeedPrewarmStatusLike;
  trigger?: typeof triggerSync;
  listUsers?: () => Array<{ id: string }>;
}

export interface FeedPrewarmProgressInput {
  now: number;
  targetBeginMs: number;
  globalEarliestMs: number | null;
  usersTotal: number;
  usersCovered: number;
  running: boolean;
}

export function computePrewarmProgress(input: FeedPrewarmProgressInput) {
  const globalCovered =
    typeof input.globalEarliestMs === 'number' && input.globalEarliestMs <= input.targetBeginMs;
  // 近 7 天 prewarm 的目标是全局时间窗覆盖到 7 天前。
  // 新人缺 perUserEarliestMs 条目不应再触发全局历史 backfill（会在 web 进程扫全量地址堵死 feed）。
  // 缺窗用户交给 live monitor / completeness / wallet-activity backfill。
  if (globalCovered) {
    return {
      done: true,
      label: '近7天已补齐',
    };
  }

  return {
    done: false,
    label: `补齐中 ${input.usersCovered}/${Math.max(1, input.usersTotal)} 地址（近7天）`,
  };
}

function countCoveredUsers(users: Array<{ id: string }>, status: FeedPrewarmStatusLike, targetBeginMs: number) {
  return users.filter((user) => {
    const earliest = status.windowState?.perUserEarliestMs?.[user.id];
    return typeof earliest === 'number' && earliest <= targetBeginMs;
  }).length;
}

function isSyncRunning(status: FeedPrewarmStatusLike) {
  return status.running === true || status.latestRun?.status === 'running';
}

export function triggerStartupPrewarmIfNeeded(deps?: TriggerStartupPrewarmDeps) {
  const getStatus = deps?.getStatus ?? getSyncStatus;
  const trigger = deps?.trigger ?? triggerSync;
  const listUsers = deps?.listUsers ?? listMonitoredUsers;
  const status = getStatus();
  if (isSyncRunning(status)) {
    return { started: false, reason: 'already-running' as const, status };
  }

  const now = deps?.now ?? Date.now();
  const targetBeginMs = now - SEVEN_DAYS_MS;
  const globalEarliestMs = status.windowState?.globalEarliestMs ?? null;
  const users = listUsers();
  const usersCovered = countCoveredUsers(users, status, targetBeginMs);
  const progress = computePrewarmProgress({
    now,
    targetBeginMs,
    globalEarliestMs,
    usersTotal: users.length,
    usersCovered,
    running: false,
  });

  if (progress.done) {
    return { started: false, reason: 'already-covered' as const, status };
  }

  const triggerResult = trigger('startup-prewarm-7d', {
    mode: 'backfill',
    scope: 'global',
    userId: null,
  });

  return {
    started: triggerResult.started,
    reason: 'triggered' as const,
    trigger: triggerResult,
    status: getStatus(),
  };
}

export function readPrewarmProgressSnapshot() {
  const status = getSyncStatus();
  const users = listMonitoredUsers();
  const now = Date.now();
  const targetBeginMs = now - SEVEN_DAYS_MS;
  const covered = countCoveredUsers(users, status, targetBeginMs);
  const running = isSyncRunning(status);
  const progress = computePrewarmProgress({
    now,
    targetBeginMs,
    globalEarliestMs: status.windowState?.globalEarliestMs ?? null,
    usersTotal: users.length,
    usersCovered: covered,
    running,
  });

  return {
    running,
    ...progress,
    usersTotal: users.length,
    usersCovered: covered,
  };
}
