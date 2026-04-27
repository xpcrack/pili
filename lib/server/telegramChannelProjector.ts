import 'server-only';

import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import type { TelegramChannelPost, TelegramChannelSource } from '@/lib/server/telegramChannelTypes';
import type { Activity, User } from '@/types';

function buildTelegramPostUrl(params: {
  channelUsername: string | null;
  messageId: number;
}) {
  if (!params.channelUsername) {
    return null;
  }
  return `https://t.me/${params.channelUsername}/${params.messageId}`;
}

function requireUser(userId: string): User {
  const user = listTrackedUsers().find((candidate) => candidate.id === userId) || null;
  if (!user) {
    throw new Error(`telegram channel user not found: ${userId}`);
  }
  return user;
}

export function projectTelegramChannelPostToFeed(params: {
  source: TelegramChannelSource;
  post: TelegramChannelPost;
}) {
  const user = requireUser(params.source.userId);
  const title = 'Telegram 频道发帖';
  const postUrl = buildTelegramPostUrl({
    channelUsername: params.post.channelUsername || params.source.channelUsername,
    messageId: params.post.messageId,
  });
  const activity = {
    id: `telegram:${params.post.channelChatId}:${params.post.messageId}`,
    userId: user.id,
    source: 'telegram',
    type: 'post',
    title,
    content: params.post.text || '(empty)',
    timestamp: params.post.postedAtMs,
    metadata: {
      rawText: params.post.text || undefined,
      media: params.post.media.length > 0 ? params.post.media : undefined,
      replies:
        typeof params.post.replies === 'number' && Number.isFinite(params.post.replies)
          ? params.post.replies
          : undefined,
      telegramChatId: params.post.channelChatId,
      telegramChannelUsername: params.post.channelUsername || params.source.channelUsername || undefined,
      telegramChannelTitle: params.post.channelTitle || params.source.channelTitle || undefined,
      telegramMessageId: params.post.messageId,
      telegramPostUrl: postUrl || undefined,
      telegramGroupedId: params.post.groupedId || undefined,
      telegramViews:
        typeof params.post.views === 'number' && Number.isFinite(params.post.views) ? params.post.views : undefined,
      telegramForwards:
        typeof params.post.forwards === 'number' && Number.isFinite(params.post.forwards)
          ? params.post.forwards
          : undefined,
      telegramReplies:
        typeof params.post.replies === 'number' && Number.isFinite(params.post.replies)
          ? params.post.replies
          : undefined,
      telegramLinkUrls: params.post.linkUrls.length > 0 ? params.post.linkUrls : undefined,
      telegramSyncSource: 'telegram-channel' as const,
    },
  } satisfies Activity;

  return {
    user,
    activity,
  };
}
