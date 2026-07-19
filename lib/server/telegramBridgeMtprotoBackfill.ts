import 'server-only';

import { listTelegramChannelSources, updateTelegramChannelSourceState } from '@/lib/server/telegramChannelSourceRepo';
import { ingestTwitterRelayPayload } from '@/lib/server/twitterRelayIngest';
import { classifyTelegramMtprotoError, readTelegramMtprotoPolicy, sleep } from '@/lib/server/telegramMtprotoPolicy';
import type { TelegramChannelSyncClient, TelegramChannelSource } from '@/lib/server/telegramChannelTypes';
import { parseTwitterRelayPayload, type TelegramMessageLike } from '@/scripts/telegram-bridge-core';

function isSkippableBridgeChannelError(error: unknown) {
  const classified = classifyTelegramMtprotoError(error);
  if (classified.kind === 'unavailable') {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /Could not find the input entity|input entity|entity for .*PeerChannel/i.test(message);
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
  const targets = channelSources.filter((source) => source.channelChatId && source.channelType === 'social');

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
    const target = targets[index]!;
    const targetLabel = target.channelTitle || target.channelRef;

    try {
      const resolved = await params.client.resolveChannel({
        channelRef: target.channelRef,
        channelUsername: target.channelUsername,
        channelChatId: target.channelChatId,
        accessHash: target.accessHash,
      });
      persistBridgeChannelResolution(target, resolved);

      const historyPage = params.client.listBridgeChatHistoryPage
        ? await params.client.listBridgeChatHistoryPage({
            chatId: resolved.channelChatId,
            channelRef: target.channelRef,
            channelUsername: resolved.channelUsername || target.channelUsername,
            accessHash: resolved.accessHash || target.accessHash,
            beforeMessageId: params.beforeByChatId?.[target.channelChatId!] ?? null,
            startMs: params.startMs ?? null,
            endMs: params.endMs ?? null,
            limit: limitPerChat,
          })
        : {
            messages: await params.client.listBridgeChatMessages!({
              chatId: resolved.channelChatId,
              channelRef: target.channelRef,
              channelUsername: resolved.channelUsername || target.channelUsername,
              accessHash: resolved.accessHash || target.accessHash,
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
        chatId: resolved.channelChatId,
        oldestScannedMessageId: historyPage.oldestScannedMessageId,
        oldestScannedMessageTimeMs: historyPage.oldestScannedMessageTimeMs,
        reachedHistoryBoundary: historyPage.reachedHistoryBoundary,
        nextBeforeMessageId: historyPage.nextBeforeMessageId,
        fetchedCount: messages.length,
        ingestedCount: chatIngestedCount,
        ignoredCount: chatIgnoredCount,
      });
    } catch (error) {
      if (!isSkippableBridgeChannelError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      updateTelegramChannelSourceState(target.id, {
        lastError: message.slice(0, 1000),
      });
      console.warn(`[telegram-bridge-backfill] skipping unresolved channel ${targetLabel} (${target.channelChatId}): ${message}`);
      continue;
    }

    if (index < targets.length - 1) {
      await sleep(policy.requestDelayMs);
    }
  }

  return {
    chatCount: chatResults.length,
    fetchedCount,
    ingestedCount,
    ignoredCount,
    chatResults,
  };
}

function persistBridgeChannelResolution(source: TelegramChannelSource, resolved: {
  channelChatId: string;
  channelUsername: string | null;
  channelTitle: string | null;
  accessHash: string | null;
}) {
  updateTelegramChannelSourceState(source.id, {
    channelChatId: resolved.channelChatId,
    channelUsername: resolved.channelUsername,
    channelTitle: resolved.channelTitle,
    accessHash: resolved.accessHash,
    syncStatus: 'ready',
    lastError: null,
  });
}
