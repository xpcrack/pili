import 'server-only';

export interface TelegramMtprotoPolicy {
  requestDelayMs: number;
  floodSleepThresholdSec: number;
  channelSyncLimit: number;
  bridgeBackfillLimit: number;
  channelSyncIntervalMs: number;
  channelSyncLeaseTtlMs: number;
}

function readPositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt((value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function readTelegramMtprotoPolicy(): TelegramMtprotoPolicy {
  return {
    requestDelayMs: readPositiveInt(process.env.TELEGRAM_MTPROTO_REQUEST_DELAY_MS, 1500),
    floodSleepThresholdSec: readPositiveInt(process.env.TELEGRAM_MTPROTO_FLOOD_SLEEP_THRESHOLD_SEC, 60),
    channelSyncLimit: readPositiveInt(process.env.TELEGRAM_MTPROTO_CHANNEL_SYNC_LIMIT, 50),
    bridgeBackfillLimit: readPositiveInt(process.env.TELEGRAM_MTPROTO_BRIDGE_BACKFILL_LIMIT, 100),
    channelSyncIntervalMs: readPositiveInt(process.env.TELEGRAM_CHANNEL_SYNC_INTERVAL_MS, 30_000),
    channelSyncLeaseTtlMs: readPositiveInt(process.env.TELEGRAM_CHANNEL_SYNC_LEASE_TTL_MS, 90_000),
  };
}

export function classifyTelegramMtprotoError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const floodWaitMatch =
    message.match(/FLOOD_WAIT_(\d+)/i) ||
    message.match(/A wait of (\d+) seconds is required/i) ||
    message.match(/flood wait of (\d+)/i);
  if (floodWaitMatch?.[1]) {
    const seconds = Number.parseInt(floodWaitMatch[1], 10);
    return {
      kind: 'flood_wait' as const,
      message,
      waitMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
    };
  }

  if (/AUTH_KEY_DUPLICATED|session|authorized|authorization|required/i.test(message)) {
    return {
      kind: 'auth_required' as const,
      message,
      waitMs: null,
    };
  }

  if (/USERNAME_INVALID|CHANNEL_INVALID|CHANNEL_PRIVATE|INVITE_HASH_INVALID|PEER_ID_INVALID/i.test(message)) {
    return {
      kind: 'unavailable' as const,
      message,
      waitMs: null,
    };
  }

  return {
    kind: 'generic' as const,
    message,
    waitMs: null,
  };
}

export async function sleep(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}
