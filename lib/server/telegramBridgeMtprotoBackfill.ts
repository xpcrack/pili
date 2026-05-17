import 'server-only';

import { listTelegramChannelSources } from '@/lib/server/telegramChannelSourceRepo';
import { ingestTelegramMonitorUpdate, type TelegramUpdateLike } from '@/lib/server/telegramMonitorIngest';
import { ingestTwitterRelayPayload } from '@/lib/server/twitterRelayIngest';
import { readTelegramMtprotoPolicy, sleep } from '@/lib/server/telegramMtprotoPolicy';
import type { TelegramChannelSyncClient } from '@/lib/server/telegramChannelTypes';
import { parseTwitterRelayPayload, type TelegramMessageLike } from '@/scripts/telegram-bridge-core';

function toUpdate(message: TelegramMessageLike): TelegramUpdateLike {
  return {
    update_id: message.message_id || 0,
    message,
  };
}

export async function backfillTelegramBridgeHistory(params: {
  client: TelegramChannelSyncClient;
  limitPerChat?: number;
  beforeByChatId?: Record<string, number | null>;
  startMs?: number | null;
  endMs?: number | null;
}) {
  if (!params.client.listBridgeChatMessages && !params.client.listBridgeChatHistoryPage) {
    throw new Error('Bridge history backfill requires a client with listBridgeChatMessages support.');
  }

  const policy = readTelegramMtprotoPolicy();
  const limitPerChat = params.limitPerChat || policy.bridgeBackfillLimit;
  const channelSources = listTelegramChannelSources({ enabledOnly: true });
  const targets = channelSources
    .filter((source) => source.channelChatId)
    .map((source) => ({
      chatId: source.channelChatId!,
      channelType: source.channelType,
      label: source.channelTitle || source.channelRef,
    }));

  let fetchedCount = 0;
  let ingestedCount = 0;
  let ignoredCount = 0;
  const chatResults: Array<{
    chatId: string;
    oldestScannedMessageId: number | null;
    oldestScannedMessageTimeMs: number | null;
    reachedHistoryBoundary: boolean;
    nextBeforeMessageId: number | null;
    fetchedCount: number;
    ingestedCount: number;
    ignoredCount: number;
  }> = [];

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const historyPage = params.client.listBridgeChatHistoryPage
      ? await params.client.listBridgeChatHistoryPage({
          chatId: target.chatId,
          beforeMessageId: params.beforeByChatId?.[target.chatId] ?? null,
          startMs: params.startMs ?? null,
          endMs: params.endMs ?? null,
          limit: limitPerChat,
        })
      : {
          messages: await params.client.listBridgeChatMessages!({
            chatId: target.chatId,
            limit: limitPerChat,
          }),
          oldestScannedMessageId: null,
          oldestScannedMessageTimeMs: null,
          reachedHistoryBoundary: false,
          nextBeforeMessageId: null,
        };
    const messages = historyPage.messages;
    let chatIngestedCount = 0;
    let chatIgnoredCount = 0;

    fetchedCount += messages.length;
    for (const message of messages) {
      if (target.channelType === 'news') {
        const result = await ingestTelegramMonitorUpdate(toUpdate(message), target.channelType);
        if ('ignored' in result && result.ignored) {
          ignoredCount += 1;
          chatIgnoredCount += 1;
        } else {
          ingestedCount += 1;
          chatIngestedCount += 1;
        }
        continue;
      }

      const payload = parseTwitterRelayPayload(message);
      if (!payload) {
        ignoredCount += 1;
        chatIgnoredCount += 1;
        continue;
      }
      const result = await ingestTwitterRelayPayload(payload);
      if ('ignored' in result && result.ignored) {
        ignoredCount += 1;
        chatIgnoredCount += 1;
      } else {
        ingestedCount += 1;
        chatIngestedCount += 1;
      }
    }

    chatResults.push({
      chatId: target.chatId,
      oldestScannedMessageId: historyPage.oldestScannedMessageId,
      oldestScannedMessageTimeMs: historyPage.oldestScannedMessageTimeMs,
      reachedHistoryBoundary: historyPage.reachedHistoryBoundary,
      nextBeforeMessageId: historyPage.nextBeforeMessageId,
      fetchedCount: messages.length,
      ingestedCount: chatIngestedCount,
      ignoredCount: chatIgnoredCount,
    });

    if (index < targets.length - 1) {
      await sleep(policy.requestDelayMs);
    }
  }

  return {
    chatCount: targets.length,
    fetchedCount,
    ingestedCount,
    ignoredCount,
    chatResults,
  };
}
