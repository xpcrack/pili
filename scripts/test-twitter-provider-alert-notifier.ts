import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import {
  buildTwitterProviderFailureAlertMessage,
  notifyTwitterProviderFailures,
} from '@/lib/server/twitterProviderAlertNotifier';

async function run() {
  const baseInput = {
    runId: 8801,
    failures: [
      {
        userId: 'user-1',
        userName: '孙哥',
        handle: '0xsunnft',
        lane: 'replies' as const,
        providerChain: ['6551', 'xread'],
      },
    ],
  };

  const missingChat = await notifyTwitterProviderFailures(baseInput, {
    readConfig: () => ({
      telegramUnknownPersonAlertChatId: null,
      telegramTradeMonitorSourceChatId: null,
      telegramTwitterMonitorSourceChatId: null,
      conflictNotificationTelegramChatId: null,
    }),
    isQuotaAvailable: () => true,
    markQuotaConsumed: () => {},
    sendMessage: async () => ({ ok: true as const }),
  });
  assert.equal(missingChat.sent, false);
  assert.equal(missingChat.reason, 'missing-chat-id');

  const rateLimited = await notifyTwitterProviderFailures(baseInput, {
    readConfig: () => ({
      telegramUnknownPersonAlertChatId: '-200',
      telegramTradeMonitorSourceChatId: null,
      telegramTwitterMonitorSourceChatId: null,
      conflictNotificationTelegramChatId: '-100',
    }),
    isQuotaAvailable: () => false,
    markQuotaConsumed: () => {},
    sendMessage: async () => ({ ok: true as const }),
  });
  assert.equal(rateLimited.sent, false);
  assert.equal(rateLimited.reason, 'rate-limited');

  const sentRef: { current: { chatId: string; text: string } | null } = { current: null };
  const consumedKeys: string[] = [];
  const sent = await notifyTwitterProviderFailures(baseInput, {
    readConfig: () => ({
      telegramUnknownPersonAlertChatId: '-200',
      telegramTradeMonitorSourceChatId: null,
      telegramTwitterMonitorSourceChatId: null,
      conflictNotificationTelegramChatId: '-100',
    }),
    isQuotaAvailable: () => true,
    markQuotaConsumed: (key) => {
      consumedKeys.push(key);
    },
    sendMessage: async (payload) => {
      sentRef.current = payload;
      return { ok: true as const };
    },
  });
  assert.equal(sent.sent, true);
  assert.equal(sent.reason, 'sent');
  assert.equal(sent.failureCount, 1);
  assert.equal(sentRef.current?.chatId, '-100');
  assert.match(sentRef.current?.text || '', /Twitter 结构化源抓取失败/);
  assert.match(sentRef.current?.text || '', /@0xsunnft/);
  assert.equal(consumedKeys.length, 1);

  const failedSend = await notifyTwitterProviderFailures(baseInput, {
    readConfig: () => ({
      telegramUnknownPersonAlertChatId: null,
      telegramTradeMonitorSourceChatId: null,
      telegramTwitterMonitorSourceChatId: null,
      conflictNotificationTelegramChatId: '-100',
    }),
    isQuotaAvailable: () => true,
    markQuotaConsumed: () => {},
    sendMessage: async () => ({
      ok: false as const,
      reason: 'telegram_request_failed' as const,
      status: 500,
      detail: 'boom',
    }),
  });
  assert.equal(failedSend.sent, false);
  assert.equal(failedSend.reason, 'telegram-request-failed');

  const preview = buildTwitterProviderFailureAlertMessage(baseInput);
  assert.match(preview, /runId: 8801/);
  assert.match(preview, /孙哥 @0xsunnft replies/);

  console.log('twitter provider alert notifier tests: ok');
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
