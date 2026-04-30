import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import type { AddressDiagnostic } from '@/lib/activityFeed';
import { buildSyncFailureAlertMessage, notifySyncAddressFetchFailures } from '@/lib/server/syncFailureNotifier';

function makeFailure(input: {
  userName: string;
  addressName: string;
  address: string;
  chain: string;
  error: string;
  fetchAttempts?: number;
  retryExhausted?: boolean;
}): AddressDiagnostic {
  return {
    userId: `user-${input.userName}`,
    userName: input.userName,
    address: input.address,
    addressName: input.addressName,
    chain: input.chain,
    ok: false,
    transactionCount: 0,
    error: input.error,
    fetchAttempts: input.fetchAttempts,
    retryExhausted: input.retryExhausted ?? true,
  };
}

async function run() {
  const baseInput = {
    runId: 9001,
    reason: 'feed-refresh',
    mode: 'refresh' as const,
    scope: 'global' as const,
    userId: null,
    beginMs: Date.UTC(2026, 3, 15, 0, 0, 0),
    endMs: Date.UTC(2026, 3, 29, 0, 0, 0),
  };

  const failureA = makeFailure({
    userName: 'wanan',
    addressName: '#2',
    address: '0xaaa',
    chain: 'bsc',
    error: 'OKX API 504: gateway timeout',
    fetchAttempts: 3,
  });
  const failureB = makeFailure({
    userName: 'KeyNG',
    addressName: '#1',
    address: '0xbbb',
    chain: 'bsc',
    error: 'OKX API 429: too many requests',
    fetchAttempts: 3,
  });

  const noFailure = await notifySyncAddressFetchFailures(
    {
      ...baseInput,
      diagnostics: [
        {
          userId: 'ok-user',
          userName: 'ok',
          address: '0xok',
          addressName: '#ok',
          chain: 'bsc',
          ok: true,
          transactionCount: 1,
          error: null,
          fetchAttempts: 1,
        },
      ],
    },
    {
      readConfig: () => ({
        telegramUnknownPersonAlertChatId: '-100',
        telegramTradeMonitorSourceChatId: null,
        telegramTwitterMonitorSourceChatId: null,
        conflictNotificationTelegramChatId: '-100',
      }),
      isQuotaAvailable: () => true,
      markQuotaConsumed: () => {},
      sendMessage: async () => ({ ok: true as const }),
    }
  );
  assert.equal(noFailure.reason, 'no-failures');
  assert.equal(noFailure.sent, false);

  const noRetryExhausted = await notifySyncAddressFetchFailures(
    {
      ...baseInput,
      diagnostics: [
        makeFailure({
          userName: 'first-attempt',
          addressName: '#3',
          address: '0xccc',
          chain: 'bsc',
          error: 'OKX API 500',
          fetchAttempts: 1,
          retryExhausted: false,
        }),
      ],
    },
    {
      readConfig: () => ({
        telegramUnknownPersonAlertChatId: '-100',
        telegramTradeMonitorSourceChatId: null,
        telegramTwitterMonitorSourceChatId: null,
        conflictNotificationTelegramChatId: '-100',
      }),
      isQuotaAvailable: () => true,
      markQuotaConsumed: () => {},
      sendMessage: async () => ({ ok: true as const }),
    }
  );
  assert.equal(noRetryExhausted.reason, 'no-retry-exhausted-failures');
  assert.equal(noRetryExhausted.sent, false);

  const missingChat = await notifySyncAddressFetchFailures(
    {
      ...baseInput,
      diagnostics: [failureA],
    },
    {
      readConfig: () => ({
        telegramUnknownPersonAlertChatId: null,
        telegramTradeMonitorSourceChatId: null,
        telegramTwitterMonitorSourceChatId: null,
        conflictNotificationTelegramChatId: null,
      }),
      isQuotaAvailable: () => true,
      markQuotaConsumed: () => {},
      sendMessage: async () => ({ ok: true as const }),
    }
  );
  assert.equal(missingChat.reason, 'missing-chat-id');
  assert.equal(missingChat.sent, false);

  const rateLimited = await notifySyncAddressFetchFailures(
    {
      ...baseInput,
      diagnostics: [failureA],
    },
    {
      readConfig: () => ({
        telegramUnknownPersonAlertChatId: '-100',
        telegramTradeMonitorSourceChatId: null,
        telegramTwitterMonitorSourceChatId: null,
        conflictNotificationTelegramChatId: '-100',
      }),
      isQuotaAvailable: () => false,
      markQuotaConsumed: () => {},
      sendMessage: async () => ({ ok: true as const }),
    }
  );
  assert.equal(rateLimited.reason, 'rate-limited');
  assert.equal(rateLimited.sent, false);

  const sentPayloadRef: { current: { chatId: string; text: string } | null } = { current: null };
  const consumedQuotaKeys: string[] = [];
  const sent = await notifySyncAddressFetchFailures(
    {
      ...baseInput,
      diagnostics: [failureA, failureB],
    },
    {
      readConfig: () => ({
        telegramUnknownPersonAlertChatId: '-200',
        telegramTradeMonitorSourceChatId: null,
        telegramTwitterMonitorSourceChatId: null,
        conflictNotificationTelegramChatId: '-100',
      }),
      isQuotaAvailable: (key) => key.includes('0xaaa'),
      markQuotaConsumed: (key) => {
        consumedQuotaKeys.push(key);
      },
      sendMessage: async (payload) => {
        sentPayloadRef.current = payload;
        return { ok: true as const };
      },
    }
  );
  assert.equal(sent.reason, 'sent');
  assert.equal(sent.sent, true);
  assert.equal(sent.totalFailed, 2);
  assert.equal(sent.alertedFailed, 1);
  assert.equal(sentPayloadRef.current?.chatId, '-100');
  assert.match(sentPayloadRef.current?.text || '', /runId: 9001/);
  assert.match(sentPayloadRef.current?.text || '', /wanan\/#2/);
  assert.doesNotMatch(sentPayloadRef.current?.text || '', /KeyNG\/#1/);
  assert.equal(consumedQuotaKeys.length, 1);
  assert.match(consumedQuotaKeys[0] || '', /0xaaa/);

  const failedSendConsumedKeys: string[] = [];
  const failedToSend = await notifySyncAddressFetchFailures(
    {
      ...baseInput,
      diagnostics: [failureA],
    },
    {
      readConfig: () => ({
        telegramUnknownPersonAlertChatId: '-100',
        telegramTradeMonitorSourceChatId: null,
        telegramTwitterMonitorSourceChatId: null,
        conflictNotificationTelegramChatId: '-100',
      }),
      isQuotaAvailable: () => true,
      markQuotaConsumed: (key) => {
        failedSendConsumedKeys.push(key);
      },
      sendMessage: async () => ({
        ok: false as const,
        reason: 'telegram_request_failed' as const,
        status: 500,
        detail: 'boom',
      }),
    }
  );
  assert.equal(failedToSend.reason, 'telegram-request-failed');
  assert.equal(failedToSend.sent, false);
  assert.equal(failedSendConsumedKeys.length, 0);

  const preview = buildSyncFailureAlertMessage({
    ...baseInput,
    totalFailed: 2,
    alertedFailed: 1,
    failures: [failureA],
  });
  assert.match(preview, /地址拉取多次重试后仍失败/);
  assert.match(preview, /失败地址: 2，触发告警: 1/);

  console.log('sync failure notifier tests: ok');
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
