import 'server-only';

import { upsertEventsFromFeedRows } from '@/lib/server/eventsRepo';
import type { TelegramChannelPost, TelegramChannelSource } from '@/lib/server/telegramChannelTypes';
import { upsertEventTweetRefAndFetchMissing } from '@/lib/server/twitterLinkRefs';
import { projectTelegramChannelPostToFeed } from '@/lib/server/telegramChannelProjector';
import type { UpsertTwitterTweetInput } from '@/lib/server/twitterRepo';

export async function ingestTelegramChannelPost(params: {
  source: TelegramChannelSource;
  post: TelegramChannelPost;
  fetchTweetsByIds: (ids: string[]) => Promise<{ provider: string; tweets: UpsertTwitterTweetInput[] }>;
}) {
  const projected = projectTelegramChannelPostToFeed({
    source: params.source,
    post: params.post,
  });
  const eventId = `${projected.user.id}:${projected.activity.id}`;

  upsertEventsFromFeedRows([projected], 'telegram-channel');

  if (params.post.linkUrls.length > 0) {
    await upsertEventTweetRefAndFetchMissing({
      eventId,
      tweetUrls: params.post.linkUrls,
      refSource: 'telegram-channel',
      fetchTweetsByIds: params.fetchTweetsByIds,
    });
  }

  return {
    eventId,
    projected,
  };
}
