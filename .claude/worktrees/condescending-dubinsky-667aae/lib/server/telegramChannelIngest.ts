import 'server-only';

import { upsertEventsFromFeedRows } from '@/lib/server/eventsRepo';
import type { TelegramChannelPost, TelegramChannelSource } from '@/lib/server/telegramChannelTypes';
import { upsertEventTweetRefAndFetchMissing } from '@/lib/server/twitterLinkRefs';
import { projectTelegramChannelPostToFeed, enrichTelegramChannelPost } from '@/lib/server/telegramChannelProjector';
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

  // Persist the projected activity immediately (with token mentions but no translation yet)
  upsertEventsFromFeedRows([projected], 'telegram-channel');

  const eventId = `${projected.user.id}:${projected.activity.id}`;

  if (params.post.linkUrls.length > 0) {
    await upsertEventTweetRefAndFetchMissing({
      eventId,
      tweetUrls: params.post.linkUrls,
      refSource: 'telegram-channel',
      fetchTweetsByIds: params.fetchTweetsByIds,
    });
  }

  // Fire-and-forget async enrichment (translation + sentiment)
  // Re-persist on success so the feed picks up translationZh and updated sentiments
  void enrichTelegramChannelPost(projected.activity)
    .then((enrichedActivity) => {
      if (enrichedActivity.metadata.translationZh) {
        const enrichedResult = { user: projected.user, activity: enrichedActivity };
        upsertEventsFromFeedRows([enrichedResult], 'telegram-channel-enrichment');
      }
    })
    .catch((err) => {
      console.warn('[telegram-channel-enrichment] background enrichment error:', err instanceof Error ? err.message : err);
    });

  return {
    eventId,
    projected,
  };
}
