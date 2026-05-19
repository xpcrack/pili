import 'server-only';

import type { TweetMentionSentiment, TweetMentionMatchSource } from '@/lib/server/twitterEnrichmentRepo';

export interface TweetEnrichmentModelInputMention {
  tokenSymbol: string | null;
  tokenAddress: string | null;
  matchSource: TweetMentionMatchSource;
}

export interface TweetEnrichmentModelOutputSentiment {
  tokenSymbol?: string;
  tokenAddress?: string;
  sentiment: TweetMentionSentiment;
  confidence?: number;
}

export interface TweetEnrichmentModelResult {
  translationZh: string | null;
  sentiments: TweetEnrichmentModelOutputSentiment[];
}

export interface TweetEnrichmentModel {
  enrichTweet(input: {
    tweetId: string;
    text: string;
    mentions: TweetEnrichmentModelInputMention[];
  }): Promise<TweetEnrichmentModelResult>;
}

export function getDefaultTweetEnrichmentModel(): TweetEnrichmentModel {
  return {
    async enrichTweet(input) {
      return {
        translationZh: null,
        sentiments: input.mentions.map((mention) => ({
          tokenSymbol: mention.tokenSymbol || undefined,
          tokenAddress: mention.tokenAddress || undefined,
          sentiment: 'neutral' as const,
          confidence: 0.5,
        })),
      };
    },
  };
}
