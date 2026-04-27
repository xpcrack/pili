import 'server-only';

import { readSystemConfig } from '@/lib/server/systemConfigRepo';
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
}) {
  if (!params.client.listBridgeChatMessages) {
    throw new Error('Bridge history backfill requires a client with listBridgeChatMessages support.');
  }

  const config = readSystemConfig();
  const policy = readTelegramMtprotoPolicy();
  const limitPerChat = params.limitPerChat || policy.bridgeBackfillLimit;
  const targets = [
    {
      chatId: config.telegramTradeMonitorSourceChatId?.trim() || '',
      mode: 'telegram-monitor' as const,
    },
    {
      chatId: config.telegramTwitterMonitorSourceChatId?.trim() || '',
      mode: 'twitter-relay' as const,
    },
  ].filter((item) => item.chatId);

  let fetchedCount = 0;
  let ingestedCount = 0;
  let ignoredCount = 0;

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const messages = await params.client.listBridgeChatMessages({
      chatId: target.chatId,
      limit: limitPerChat,
    });

    fetchedCount += messages.length;
    for (const message of messages) {
      if (target.mode === 'telegram-monitor') {
        const result = await ingestTelegramMonitorUpdate(toUpdate(message));
        if ('ignored' in result && result.ignored) {
          ignoredCount += 1;
        } else {
          ingestedCount += 1;
        }
        continue;
      }

      const payload = parseTwitterRelayPayload(message);
      if (!payload) {
        ignoredCount += 1;
        continue;
      }
      const result = await ingestTwitterRelayPayload(payload);
      if ('ignored' in result && result.ignored) {
        ignoredCount += 1;
      } else {
        ingestedCount += 1;
      }
    }

    if (index < targets.length - 1) {
      await sleep(policy.requestDelayMs);
    }
  }

  return {
    chatCount: targets.length,
    fetchedCount,
    ingestedCount,
    ignoredCount,
  };
}
