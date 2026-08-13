import 'server-only';

import { createTelegramGramjsClient, type LiveTelegramNewMessageEvent, type TelegramLiveClient } from '@/lib/server/telegramGramjsClient';
import {
  listTelegramChannelSources,
  updateTelegramChannelSourceState,
} from '@/lib/server/telegramChannelSourceRepo';
import { upsertTelegramChannelPost } from '@/lib/server/telegramChannelPostRepo';
import { ingestTelegramChannelPost } from '@/lib/server/telegramChannelIngest';
import { createTwitterFetcher } from '@/lib/server/twitterFetcher';
import type { TelegramChannelSource } from '@/lib/server/telegramChannelTypes';

/**
 * MTProto 即时路径：channel worker 常驻一个 gramjs client，
 * 通过 updates 长连接（NewMessage 事件）把新 channel 消息即时入库，
 * 替代「5s 周期轮询」——把 Telegram channel 端到端延迟从 0–16s 收敛到 ~1–3s。
 *
 * 兜底：worker 的周期 sync（syncAllTelegramChannelSources）保持不变，
 * 覆盖重启窗口 / 断线期间的消息；upsert 幂等，双路径安全。
 */

let liveClient: TelegramLiveClient | null = null;

export async function ensureLiveTelegramChannelClient(): Promise<{
  client: TelegramLiveClient | null;
  error: string | null;
}> {
  try {
    if (!liveClient) {
      liveClient = await createTelegramGramjsClient();
      liveClient.addNewMessageHandler(handleLiveTelegramNewMessage);
    } else if (!liveClient.isConnected()) {
      await liveClient.reconnect();
    }
    return { client: liveClient, error: null };
  } catch (error) {
    return {
      client: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizePeerChatId(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  // source.channelChatId 存的是 getPeerId 格式（-100 前缀）；事件 chatId 是裸 channel id
  return String(raw).replace(/^-100/, '').replace(/^-/, '');
}

function matchChannelSource(chatId: string): TelegramChannelSource | null {
  const want = normalizePeerChatId(chatId);
  if (!want) {
    return null;
  }
  for (const source of listTelegramChannelSources({ enabledOnly: true })) {
    if (normalizePeerChatId(source.channelChatId) === want) {
      return source;
    }
  }
  return null;
}

async function handleLiveTelegramNewMessage(event: LiveTelegramNewMessageEvent) {
  if (!event.isChannelPost || !liveClient) {
    return;
  }
  const source = matchChannelSource(event.chatId);
  if (!source) {
    return;
  }

  try {
    const resolved = await liveClient.resolveChannel({
      channelRef: source.channelRef,
      channelUsername: source.channelUsername,
      channelChatId: source.channelChatId,
      accessHash: source.accessHash,
    });

    const message = event.message;
    const post = upsertTelegramChannelPost({
      channelChatId: resolved.channelChatId,
      channelUsername: resolved.channelUsername,
      channelTitle: resolved.channelTitle,
      messageId: message.messageId,
      groupedId: message.groupedId,
      postedAtMs: message.postedAtMs,
      editDateMs: message.editDateMs,
      text: message.text,
      textEntities: message.textEntities,
      media: message.media,
      linkUrls: message.linkUrls,
      channelType: source.channelType,
      forwardInfo: message.forwardInfo,
      views: message.views,
      forwards: message.forwards,
      replies: message.replies,
      raw: message.raw,
    });

    await ingestTelegramChannelPost({
      source: {
        ...source,
        channelChatId: resolved.channelChatId,
        channelUsername: resolved.channelUsername,
        channelTitle: resolved.channelTitle,
        accessHash: resolved.accessHash,
        syncStatus: 'ready',
      },
      post,
      fetchTweetsByIds: async (ids: string[]) => {
        const fetcher = createTwitterFetcher();
        return fetcher.fetchTweetsByIds({ ids, intent: 'detail' });
      },
    });

    updateTelegramChannelSourceState(source.id, {
      channelChatId: resolved.channelChatId,
      channelUsername: resolved.channelUsername,
      channelTitle: resolved.channelTitle,
      accessHash: resolved.accessHash,
      syncStatus: 'ready',
      lastMessageId: Math.max(source.lastMessageId || 0, message.messageId),
      lastSyncedAtMs: Date.now(),
      lastError: null,
    });

    console.log(
      `[telegram-live] ingested chat=${resolved.channelChatId} msg=${message.messageId} delay=${Date.now() - message.postedAtMs}ms`
    );
  } catch (error) {
    console.warn(
      '[telegram-live] ingest error:',
      error instanceof Error ? error.message : error,
      `chat=${event.chatId} msg=${event.message.messageId}`
    );
  }
}
