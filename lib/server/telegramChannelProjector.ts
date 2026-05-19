import 'server-only';

import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import type { TelegramChannelPost, TelegramChannelSource } from '@/lib/server/telegramChannelTypes';
import { extractTweetTokenMentions } from '@/lib/twitter/extractTweetTokenMentions';
import { isLikelyEnglish } from '@/lib/server/nvidiaEnrichmentModel';
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
  const postText = params.post.text || '';
  const mentions = extractTweetTokenMentions(postText);
  const mentionedTickers = [...new Set(mentions.map(m => m.tokenSymbol).filter(Boolean))] as string[];
  const mentionedTokenAddresses = [...new Set(mentions.map(m => m.tokenAddress).filter(Boolean))] as string[];
  const tokenSentiments = mentions.map(m => ({
    tokenSymbol: m.tokenSymbol || undefined,
    tokenAddress: m.tokenAddress || undefined,
    chain: undefined as string | undefined,
    sentiment: 'neutral' as const,
    matchSource: m.matchSource,
  }));

  const activity = {
    id: `telegram:${params.post.channelChatId}:${params.post.messageId}`,
    userId: user.id,
    source: 'telegram',
    type: 'post',
    title,
    content: postText || '(empty)',
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
      mentionedTickers: mentionedTickers.length > 0 ? mentionedTickers : undefined,
      mentionedTokenAddresses: mentionedTokenAddresses.length > 0 ? mentionedTokenAddresses : undefined,
      tokenSentiments: tokenSentiments.length > 0 ? tokenSentiments : undefined,
      telegramSyncSource: 'telegram-channel' as const,
    },
  } satisfies Activity;

  return {
    user,
    activity,
  };
}

export async function enrichTelegramChannelPost(activity: Activity): Promise<Activity> {
  const text = activity.content.trim();
  if (!text || !isLikelyEnglish(text)) {
    return activity;
  }

  const apiKey = (process.env.NVIDIA_API_KEY || '').trim();
  if (!apiKey) {
    return activity;
  }

  try {
    const { NvidaQwenEnrichmentModel } = require('@/lib/server/nvidiaEnrichmentModel') as {
      NvidaQwenEnrichmentModel: new (opts: { apiKey: string }) => import('@/lib/server/twitterEnrichmentModel').TweetEnrichmentModel;
    };
    const model = new NvidaQwenEnrichmentModel({ apiKey });

    const mentions = (activity.metadata.tokenSentiments || []).map(s => ({
      tokenSymbol: s.tokenSymbol || null,
      tokenAddress: s.tokenAddress || null,
      matchSource: s.matchSource || 'ticker' as const,
    }));

    const result = await model.enrichTweet({
      tweetId: activity.id,
      text,
      mentions,
    });

    const updatedMetadata = {
      ...activity.metadata,
      translationZh: result.translationZh || undefined,
      translationStatus: result.translationZh ? 'succeeded' as const : 'failed' as const,
    };

    if (result.sentiments.length > 0) {
      // Preserve original matchSource from pre-enrichment metadata
      const originalSentiments = activity.metadata.tokenSentiments || [];
      updatedMetadata.tokenSentiments = result.sentiments.map(s => {
        const original = originalSentiments.find(o =>
          (o.tokenSymbol || '').toLowerCase() === (s.tokenSymbol || '').toLowerCase()
          && (o.tokenAddress || '').toLowerCase() === (s.tokenAddress || '').toLowerCase()
        );
        return {
          tokenSymbol: s.tokenSymbol,
          tokenAddress: s.tokenAddress,
          chain: undefined as string | undefined,
          sentiment: s.sentiment,
          matchSource: original?.matchSource || 'both' as const,
        };
      });
    }

    return {
      ...activity,
      metadata: updatedMetadata,
    };
  } catch (error) {
    console.warn('[telegram-enrichment] failed:', error instanceof Error ? error.message : error);
    return activity;
  }
}
