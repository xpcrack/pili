import 'server-only';

import { getDb } from '@/lib/server/sqlite';

const SYSTEM_CONFIG_KEY = 'system_config_v1';
// Relay-covered: relay already delivers near-real-time; API poll is backup.
const DEFAULT_TWITTER_RELAY_COVERED_POLLING_INTERVAL_MINUTES = 360;
// Uncovered: 顺序 pass 时代 5min 形同虚设（pass 本身 ~10min）。
// sync 用户级并行后 revisit 受 interval 约束，3min 是速率核算后的折中
// （66 uncovered × 2 lanes / 180s ≈ 0.73 req/s ≈ 2.5x 实测安全包络）。
// 真 <10s 只能靠 twitter relay（外部监控覆盖），轮询只是兜底。
const DEFAULT_TWITTER_UNCOVERED_POLLING_INTERVAL_MINUTES = 3;
const MAX_TWITTER_POLLING_INTERVAL_MINUTES = 60 * 24 * 7;

/**
 * Trade-signal defaults.
 *
 * Off by default: pushing to a phone is not something a code deploy should
 * switch on. The market-cap band matches the 200k–1M "二段" entry range.
 */
export const TRADE_SIGNAL_DEFAULTS = {
  enabled: false,
  minWinRate: 0.45,
  minRoundTrips: 10,
  // 跟单分 percentile within the cohort; 0 disables this gate.
  minFollowability: 0.6,
  minTradeUsd: 500,
  minMarketCapUsd: 200_000,
  maxMarketCapUsd: 1_000_000,
  coHitMinUsers: 2,
  coHitWindowMinutes: 180,
  cooldownMinutes: 60,
} as const;

export interface SystemConfigSnapshot {
  telegramUnknownPersonAlertChatId: string | null;
  telegramTradeMonitorSourceChatId: string | null;
  telegramTwitterMonitorSourceChatId: string | null;
  conflictNotificationTelegramChatId: string | null;
  completenessStartMs: number | null;
  twitterRelayCoveredPollingIntervalMinutes: number;
  twitterUncoveredPollingIntervalMinutes: number;
  tradeSignalEnabled: boolean;
  /** 0–1. A person must beat this win rate to be worth a push. */
  tradeSignalMinWinRate: number;
  /** Sample floor — 1 win from 1 trade is not a 100% win rate. */
  tradeSignalMinRoundTrips: number;
  /** 0–1 跟单分 floor. Keeps high-frequency wallets out even when they win often. */
  tradeSignalMinFollowability: number;
  tradeSignalMinTradeUsd: number;
  /** null = no bound on that side of the market-cap band. */
  tradeSignalMinMarketCapUsd: number | null;
  tradeSignalMaxMarketCapUsd: number | null;
  tradeSignalCoHitMinUsers: number;
  tradeSignalCoHitWindowMinutes: number;
  tradeSignalCooldownMinutes: number;
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

function normalizeNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeOptionalNumber(value: unknown, fallback: number | null) {
  if (value === null) return null;
  if (value === undefined) return fallback;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function normalizeBoolean(value: unknown, fallback: boolean) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return fallback;
}

/**
 * Build a full snapshot from a partial one, filling every default.
 * Exported so callers and tests never hand-write the full field list —
 * that is how adding a field silently breaks them.
 */
export function buildSystemConfigSnapshot(partial: Partial<SystemConfigSnapshot> = {}): SystemConfigSnapshot {
  return normalizeSnapshot(partial);
}

function normalizeSnapshot(value: unknown): SystemConfigSnapshot {
  const candidate = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

  return {
    tradeSignalEnabled: normalizeBoolean(candidate.tradeSignalEnabled, TRADE_SIGNAL_DEFAULTS.enabled),
    tradeSignalMinWinRate: normalizeNumber(
      candidate.tradeSignalMinWinRate,
      TRADE_SIGNAL_DEFAULTS.minWinRate,
      0,
      1
    ),
    tradeSignalMinRoundTrips: Math.floor(
      normalizeNumber(candidate.tradeSignalMinRoundTrips, TRADE_SIGNAL_DEFAULTS.minRoundTrips, 1, 10_000)
    ),
    tradeSignalMinFollowability: normalizeNumber(
      candidate.tradeSignalMinFollowability,
      TRADE_SIGNAL_DEFAULTS.minFollowability,
      0,
      1
    ),
    tradeSignalMinTradeUsd: normalizeNumber(
      candidate.tradeSignalMinTradeUsd,
      TRADE_SIGNAL_DEFAULTS.minTradeUsd,
      0,
      100_000_000
    ),
    tradeSignalMinMarketCapUsd: normalizeOptionalNumber(
      candidate.tradeSignalMinMarketCapUsd,
      TRADE_SIGNAL_DEFAULTS.minMarketCapUsd
    ),
    tradeSignalMaxMarketCapUsd: normalizeOptionalNumber(
      candidate.tradeSignalMaxMarketCapUsd,
      TRADE_SIGNAL_DEFAULTS.maxMarketCapUsd
    ),
    tradeSignalCoHitMinUsers: Math.floor(
      normalizeNumber(candidate.tradeSignalCoHitMinUsers, TRADE_SIGNAL_DEFAULTS.coHitMinUsers, 2, 100)
    ),
    tradeSignalCoHitWindowMinutes: Math.floor(
      normalizeNumber(
        candidate.tradeSignalCoHitWindowMinutes,
        TRADE_SIGNAL_DEFAULTS.coHitWindowMinutes,
        5,
        60 * 24 * 7
      )
    ),
    tradeSignalCooldownMinutes: Math.floor(
      normalizeNumber(
        candidate.tradeSignalCooldownMinutes,
        TRADE_SIGNAL_DEFAULTS.cooldownMinutes,
        1,
        60 * 24 * 30
      )
    ),
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

  // normalizeSnapshot already supplies every default, so an absent row and an
  // empty row take the same path — one place to add a field, not two.
  return normalizeSnapshot(row?.value_json ? parseJSON(row.value_json, {}) : {});
}

export function saveSystemConfig(input: SystemConfigUpdate) {
  const current = readSystemConfig();

  // Overlay only the keys the caller actually sent, then re-normalize the whole
  // thing. Keeps PATCH semantics (absent key = unchanged) without restating
  // every field, which is how a new field silently fails to persist.
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  const next = normalizeSnapshot(merged);

  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO app_state (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(SYSTEM_CONFIG_KEY, JSON.stringify(next), now);

  return next;
}
