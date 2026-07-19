import 'server-only';

import type { SystemConfigSnapshot } from '@/lib/server/systemConfigRepo';

/** Prefer conflict chat, fall back to unknown-person alert chat. */
export function pickAlertChatId(config: SystemConfigSnapshot) {
  return (
    (config.conflictNotificationTelegramChatId || '').trim() ||
    (config.telegramUnknownPersonAlertChatId || '').trim() ||
    ''
  );
}

export const ALERT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
