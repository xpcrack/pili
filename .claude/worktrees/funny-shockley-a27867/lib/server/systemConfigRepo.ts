import 'server-only';

import { getDb } from '@/lib/server/sqlite';

const SYSTEM_CONFIG_KEY = 'system_config_v1';
const DEFAULT_TWITTER_RELAY_COVERED_POLLING_INTERVAL_MINUTES = 360;
const DEFAULT_TWITTER_UNCOVERED_POLLING_INTERVAL_MINUTES = 30;
const MAX_TWITTER_POLLING_INTERVAL_MINUTES = 60 * 24 * 7;

export interface SystemConfigSnapshot {
  telegramUnknownPersonAlertChatId: string | null;
  telegramTradeMonitorSourceChatId: string | null;
  telegramTwitterMonitorSourceChatId: string | null;
  conflictNotificationTelegramChatId: string | null;
  completenessStartMs: number | null;
  twitterRelayCoveredPollingIntervalMinutes: number;
  twitterUncoveredPollingIntervalMinutes: number;
}

type SystemConfigUpdate = {
  [Key in keyof SystemConfigSnapshot]?: unknown;
};

function parseJSON<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeOptionalString(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizePollingIntervalMinutes(value: unknown, fallback: number) {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.min(MAX_TWITTER_POLLING_INTERVAL_MINUTES, Math.floor(parsed)));
}

function normalizePositiveIntegerTimestamp(value: unknown) {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.floor(parsed);
}

function normalizeSnapshot(value: unknown): SystemConfigSnapshot {
  const candidate = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

  return {
    telegramUnknownPersonAlertChatId: normalizeOptionalString(candidate.telegramUnknownPersonAlertChatId),
    telegramTradeMonitorSourceChatId: normalizeOptionalString(candidate.telegramTradeMonitorSourceChatId),
    telegramTwitterMonitorSourceChatId: normalizeOptionalString(candidate.telegramTwitterMonitorSourceChatId),
    conflictNotificationTelegramChatId: normalizeOptionalString(candidate.conflictNotificationTelegramChatId),
    completenessStartMs: normalizePositiveIntegerTimestamp(candidate.completenessStartMs),
    twitterRelayCoveredPollingIntervalMinutes: normalizePollingIntervalMinutes(
      candidate.twitterRelayCoveredPollingIntervalMinutes,
      DEFAULT_TWITTER_RELAY_COVERED_POLLING_INTERVAL_MINUTES
    ),
    twitterUncoveredPollingIntervalMinutes: normalizePollingIntervalMinutes(
      candidate.twitterUncoveredPollingIntervalMinutes,
      DEFAULT_TWITTER_UNCOVERED_POLLING_INTERVAL_MINUTES
    ),
  };
}

export function readSystemConfig() {
  const db = getDb();
  const row = db
    .prepare('SELECT value_json FROM app_state WHERE key = ? LIMIT 1')
    .get(SYSTEM_CONFIG_KEY) as { value_json: string } | undefined;

  if (!row?.value_json) {
    return {
      telegramUnknownPersonAlertChatId: null,
      telegramTradeMonitorSourceChatId: null,
      telegramTwitterMonitorSourceChatId: null,
      conflictNotificationTelegramChatId: null,
      completenessStartMs: null,
      twitterRelayCoveredPollingIntervalMinutes: DEFAULT_TWITTER_RELAY_COVERED_POLLING_INTERVAL_MINUTES,
      twitterUncoveredPollingIntervalMinutes: DEFAULT_TWITTER_UNCOVERED_POLLING_INTERVAL_MINUTES,
    } satisfies SystemConfigSnapshot;
  }

  return normalizeSnapshot(parseJSON(row.value_json, {}));
}

export function saveSystemConfig(input: SystemConfigUpdate) {
  const current = readSystemConfig();
  const next: SystemConfigSnapshot = {
    telegramUnknownPersonAlertChatId:
      input.telegramUnknownPersonAlertChatId !== undefined
        ? normalizeOptionalString(input.telegramUnknownPersonAlertChatId)
        : current.telegramUnknownPersonAlertChatId,
    telegramTradeMonitorSourceChatId:
      input.telegramTradeMonitorSourceChatId !== undefined
        ? normalizeOptionalString(input.telegramTradeMonitorSourceChatId)
        : current.telegramTradeMonitorSourceChatId,
    telegramTwitterMonitorSourceChatId:
      input.telegramTwitterMonitorSourceChatId !== undefined
        ? normalizeOptionalString(input.telegramTwitterMonitorSourceChatId)
        : current.telegramTwitterMonitorSourceChatId,
    conflictNotificationTelegramChatId:
      input.conflictNotificationTelegramChatId !== undefined
        ? normalizeOptionalString(input.conflictNotificationTelegramChatId)
        : current.conflictNotificationTelegramChatId,
    completenessStartMs:
      input.completenessStartMs !== undefined
        ? normalizePositiveIntegerTimestamp(input.completenessStartMs)
        : current.completenessStartMs,
    twitterRelayCoveredPollingIntervalMinutes:
      input.twitterRelayCoveredPollingIntervalMinutes !== undefined
        ? normalizePollingIntervalMinutes(
            input.twitterRelayCoveredPollingIntervalMinutes,
            DEFAULT_TWITTER_RELAY_COVERED_POLLING_INTERVAL_MINUTES
          )
        : current.twitterRelayCoveredPollingIntervalMinutes,
    twitterUncoveredPollingIntervalMinutes:
      input.twitterUncoveredPollingIntervalMinutes !== undefined
        ? normalizePollingIntervalMinutes(
            input.twitterUncoveredPollingIntervalMinutes,
            DEFAULT_TWITTER_UNCOVERED_POLLING_INTERVAL_MINUTES
          )
        : current.twitterUncoveredPollingIntervalMinutes,
  };

  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO app_state (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(SYSTEM_CONFIG_KEY, JSON.stringify(next), now);

  return next;
}
