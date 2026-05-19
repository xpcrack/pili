import 'server-only';

import { extractTweetTokenMentions } from '@/lib/twitter/extractTweetTokenMentions';
import {
  replaceTwitterTweetTokenMentions,
  upsertTwitterTweetEnrichment,
  type TweetMentionSentiment,
} from '@/lib/server/twitterEnrichmentRepo';
import { type StoredTwitterTweet, listTwitterTweetsByIds } from '@/lib/server/twitterRepo';
import {
  getDefaultTweetEnrichmentModel,
  type TweetEnrichmentModel,
  type TweetEnrichmentModelOutputSentiment,
} from '@/lib/server/twitterEnrichmentModel';

const EXTRACTOR_VERSION = 'rule-v1';
const TRANSLATOR_VERSION = 'model-v1';

function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

function isValidSentiment(value: string | null | undefined): value is TweetMentionSentiment {
  return value === 'positive' || value === 'negative' || value === 'neutral';
}

function pickMentionSentiment(params: {
  mention: { tokenSymbol: string | null; tokenAddress: string | null };
  sentiments: TweetEnrichmentModelOutputSentiment[];
}) {
  const mentionAddress = normalize(params.mention.tokenAddress);
  const mentionSymbol = normalize(params.mention.tokenSymbol);

  for (const sentiment of params.sentiments) {
    const sentimentAddress = normalize(sentiment.tokenAddress);
    if (mentionAddress && sentimentAddress && mentionAddress === sentimentAddress) {
      return sentiment;
    }
  }

  for (const sentiment of params.sentiments) {
    const sentimentSymbol = normalize(sentiment.tokenSymbol);
    if (mentionSymbol && sentimentSymbol && mentionSymbol === sentimentSymbol) {
      return sentiment;
    }
  }

  return null;
}

async function runEnrichmentForTweet(params: {
  tweet: StoredTwitterTweet;
  model: TweetEnrichmentModel;
}) {
  const mentions = extractTweetTokenMentions(params.tweet.fullText);
  upsertTwitterTweetEnrichment({
    tweetId: params.tweet.tweetId,
    translationZh: null,
    translationStatus: 'processing',
    extractionStatus: 'processing',
    extractorVersion: EXTRACTOR_VERSION,
    translatorVersion: TRANSLATOR_VERSION,
    lastProcessedAtMs: Date.now(),
    lastError: null,
  });

  try {
    const result = await params.model.enrichTweet({
      tweetId: params.tweet.tweetId,
      text: params.tweet.fullText,
      mentions: mentions.map((mention) => ({
        tokenAddress: mention.tokenAddress,
        tokenSymbol: mention.tokenSymbol,
        matchSource: mention.matchSource,
      })),
    });

    replaceTwitterTweetTokenMentions({
      tweetId: params.tweet.tweetId,
      mentions: mentions.map((mention) => {
        const matched = pickMentionSentiment({
          mention,
          sentiments: result.sentiments || [],
        });
        return {
          tokenAddress: mention.tokenAddress,
          tokenSymbol: mention.tokenSymbol,
          chain: null,
          matchSource: mention.matchSource,
          sentiment: isValidSentiment(matched?.sentiment) ? matched.sentiment : 'neutral',
          confidence: typeof matched?.confidence === 'number' && Number.isFinite(matched.confidence)
            ? matched.confidence
            : null,
          rankInTweet: mention.rankInTweet,
        };
      }),
    });

    const translationZh = (result.translationZh || '').trim() || null;
    upsertTwitterTweetEnrichment({
      tweetId: params.tweet.tweetId,
      translationZh,
      translationStatus: translationZh ? 'succeeded' : 'failed',
      extractionStatus: 'succeeded',
      extractorVersion: EXTRACTOR_VERSION,
      translatorVersion: TRANSLATOR_VERSION,
      lastProcessedAtMs: Date.now(),
      lastError: null,
    });
    return true;
  } catch (error) {
    replaceTwitterTweetTokenMentions({
      tweetId: params.tweet.tweetId,
      mentions: mentions.map((mention) => ({
        tokenAddress: mention.tokenAddress,
        tokenSymbol: mention.tokenSymbol,
        chain: null,
        matchSource: mention.matchSource,
        sentiment: 'neutral',
        confidence: null,
        rankInTweet: mention.rankInTweet,
      })),
    });

    upsertTwitterTweetEnrichment({
      tweetId: params.tweet.tweetId,
      translationZh: null,
      translationStatus: 'failed',
      extractionStatus: 'succeeded',
      extractorVersion: EXTRACTOR_VERSION,
      translatorVersion: TRANSLATOR_VERSION,
      lastProcessedAtMs: Date.now(),
      lastError: error instanceof Error ? error.message : 'unknown_enrichment_error',
    });
    return false;
  }
}

export async function runTweetEnrichmentForTweetIds(params: {
  tweetIds: string[];
  model?: TweetEnrichmentModel;
}) {
  const uniqueTweetIds = Array.from(new Set(params.tweetIds.map((value) => value.trim()).filter(Boolean)));
  if (uniqueTweetIds.length === 0) {
    return {
      total: 0,
      succeeded: 0,
      failed: 0,
    };
  }

  const tweets = listTwitterTweetsByIds(uniqueTweetIds);
  const model = params.model || getDefaultTweetEnrichmentModel();

  let succeeded = 0;
  let failed = 0;
  for (const tweet of tweets) {
    const ok = await runEnrichmentForTweet({
      tweet,
      model,
    });
    if (ok) {
      succeeded += 1;
    } else {
      failed += 1;
    }
  }

  return {
    total: tweets.length,
    succeeded,
    failed,
  };
}
