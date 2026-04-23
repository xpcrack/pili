import 'server-only';

import { getDb } from '@/lib/server/sqlite';

const SYSTEM_CONFIG_KEY = 'system_config_v1';

export interface SystemConfigSnapshot {
  telegramUnknownPersonAlertChatId: string | null;
  telegramTradeMonitorSourceChatId: string | null;
  telegramTwitterMonitorSourceChatId: string | null;
  conflictNotificationTelegramChatId: string | null;
}

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

function normalizeSnapshot(value: unknown): SystemConfigSnapshot {
  const candidate = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

  return {
    telegramUnknownPersonAlertChatId: normalizeOptionalString(candidate.telegramUnknownPersonAlertChatId),
    telegramTradeMonitorSourceChatId: normalizeOptionalString(candidate.telegramTradeMonitorSourceChatId),
    telegramTwitterMonitorSourceChatId: normalizeOptionalString(candidate.telegramTwitterMonitorSourceChatId),
    conflictNotificationTelegramChatId: normalizeOptionalString(candidate.conflictNotificationTelegramChatId),
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
    } satisfies SystemConfigSnapshot;
  }

  return normalizeSnapshot(parseJSON(row.value_json, {}));
}

export function saveSystemConfig(input: Partial<SystemConfigSnapshot>) {
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
