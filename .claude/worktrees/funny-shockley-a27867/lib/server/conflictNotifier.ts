import 'server-only';

import {
  markConflictNotificationRetry,
  markConflictNotificationSent,
  type PendingConflictNotificationRow,
  readPendingConflictNotifications,
} from '@/lib/server/conflictRepo';
import { readSystemConfig } from '@/lib/server/systemConfigRepo';
import { sendTelegramTextMessage } from '@/lib/server/telegramNotify';

export interface FlushConflictNotificationsResult {
  sent: number;
  skipped: number;
  reason: 'ok' | 'missing-chat-id';
}

function normalizeLimit(limit: number) {
  if (!Number.isFinite(limit)) {
    return 20;
  }
  return Math.max(1, Math.floor(limit));
}

function buildConflictFieldsLabel(notification: PendingConflictNotificationRow) {
  const fields = notification.diffJson.map((item) => item.field).filter(Boolean);
  if (fields.length === 0) {
    return '(none)';
  }
  return fields.join(', ');
}

function buildConflictMessage(notification: PendingConflictNotificationRow) {
  return [
    '[feed conflict detected]',
    `eventKey: ${notification.eventKey}`,
    `domain: ${notification.domain}`,
    `winner: ${notification.winner}`,
    `fields: ${buildConflictFieldsLabel(notification)}`,
  ].join('\n');
}

function formatTelegramFailureReason(result: Awaited<ReturnType<typeof sendTelegramTextMessage>>) {
  if (result.ok) {
    return '';
  }

  const extras: string[] = [result.reason];
  if ('status' in result && typeof result.status === 'number') {
    extras.push(`status=${result.status}`);
  }
  if ('detail' in result && typeof result.detail === 'string' && result.detail.trim()) {
    extras.push(result.detail.trim());
  }

  return extras.join(' | ');
}

function formatUnknownError(error: unknown) {
  if (error instanceof Error) {
    return error.message || error.name;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'unknown-error';
}

function markRetrySafely(notificationId: number, reason: string, attemptCount: number) {
  try {
    markConflictNotificationRetry(notificationId, reason, attemptCount);
  } catch (error) {
    console.error('[conflictNotifier] failed to mark retry', {
      notificationId,
      error: formatUnknownError(error),
    });
  }
}

export async function flushConflictNotifications(limit = 20): Promise<FlushConflictNotificationsResult> {
  await Promise.resolve();

  const chatId = readSystemConfig().conflictNotificationTelegramChatId?.trim() || '';
  if (!chatId) {
    return {
      sent: 0,
      skipped: 0,
      reason: 'missing-chat-id',
    };
  }

  const pending = readPendingConflictNotifications(normalizeLimit(limit));
  let sent = 0;
  let skipped = 0;

  for (const notification of pending) {
    const nextAttemptCount = notification.attemptCount + 1;

    try {
      const text = buildConflictMessage(notification);
      const result = await sendTelegramTextMessage({ chatId, text });

      if (!result.ok) {
        markRetrySafely(notification.id, formatTelegramFailureReason(result), nextAttemptCount);
        skipped += 1;
        continue;
      }

      try {
        markConflictNotificationSent(notification.id);
        sent += 1;
      } catch (error) {
        markRetrySafely(notification.id, formatUnknownError(error), nextAttemptCount);
        skipped += 1;
      }
    } catch (error) {
      markRetrySafely(notification.id, formatUnknownError(error), nextAttemptCount);
      skipped += 1;
    }
  }

  return {
    sent,
    skipped,
    reason: 'ok',
  };
}
