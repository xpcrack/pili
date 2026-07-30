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

export interface TweetEnrichmentAliasCandidate {
  symbol: string;
  name: string | null;
  address: string;
  chain: string | null;
  /** the alias phrase that triggered the candidate (e.g. "Z世代") */
  matchedAlias: string;
}

export interface TweetEnrichmentAliasConfirmation {
  address: string;
  sentiment: TweetMentionSentiment;
  confidence?: number;
}

export interface TweetEnrichmentModel {
  enrichTweet(input: {
    tweetId: string;
    text: string;
    mentions: TweetEnrichmentModelInputMention[];
  }): Promise<TweetEnrichmentModelResult>;

  /**
   * Alias-resolution gate (Chinese-capable; enrichTweet is English-only).
   * Given a tweet and candidate tokens matched by name/alias, decide which the
   * tweet genuinely refers to as a crypto asset (not a generic phrase like a
   * demographic "Z世代"). Returns confirmed tokens with sentiment. Optional —
   * if absent, alias recall is skipped (fail safe).
   */
  confirmAliasReferences?(input: {
    text: string;
    candidates: TweetEnrichmentAliasCandidate[];
  }): Promise<TweetEnrichmentAliasConfirmation[]>;
}

export function getDefaultTweetEnrichmentModel(): TweetEnrichmentModel {
  const {
    NvidaQwenEnrichmentModel,
    resolveEnrichmentApiKey,
    resolveEnrichmentBaseUrl,
    resolveEnrichmentModel,
  } = require('@/lib/server/nvidiaEnrichmentModel') as {
    NvidaQwenEnrichmentModel: new (opts: {
      apiKey: string;
      model?: string;
      baseUrl?: string;
    }) => TweetEnrichmentModel;
    resolveEnrichmentApiKey: () => string;
    resolveEnrichmentBaseUrl: () => string;
    resolveEnrichmentModel: () => string;
  };

  const apiKey = resolveEnrichmentApiKey();
  if (!apiKey) {
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

  return new NvidaQwenEnrichmentModel({
    apiKey,
    model: resolveEnrichmentModel(),
    baseUrl: resolveEnrichmentBaseUrl(),
  });
}
