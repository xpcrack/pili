import 'server-only';

import { extractTweetTokenMentions, type ExtractedTweetTokenMention } from '@/lib/twitter/extractTweetTokenMentions';
import {
  listTwitterTweetEnrichmentsByTweetIds,
  replaceTwitterTweetTokenMentions,
  upsertTwitterTweetEnrichment,
  type TweetEnrichmentStatus,
  type TweetMentionOrigin,
  type TweetMentionSentiment,
} from '@/lib/server/twitterEnrichmentRepo';
import { type StoredTwitterTweet, listTwitterTweetsByIds } from '@/lib/server/twitterRepo';
import {
  getDefaultTweetEnrichmentModel,
  type TweetEnrichmentModel,
  type TweetEnrichmentModelOutputSentiment,
} from '@/lib/server/twitterEnrichmentModel';
import { isLikelyEnglish } from '@/lib/server/nvidiaEnrichmentModel';
import { listImageUrlsFromSourceJson } from '@/lib/server/tweetMediaUrls';
import {
  collectTweetSourceTexts,
  extractQuotedTextFromSourceJson,
} from '@/lib/server/tweetSourceTexts';
import { extractMentionsFromImageUrls, type VisionEnrichmentModel } from '@/lib/server/visionEnrichmentModel';
import { enrichMentionsMarketData } from '@/lib/server/tweetTokenEnrichment';
import { fetchFromDexScreener } from '@/lib/server/dexscreener';
import {
  barkOfficialTwitterCollisionOnce,
  ensurePrimaryPoolForAddress,
  getPrimaryPoolAddressSet,
  getPrimaryPoolOfficialTwitterMap,
  getPrimaryPoolSymbolAllowlist,
} from '@/lib/server/primaryPoolSymbols';
import { listMonitoredUsers } from '@/lib/server/trackedUsersRepo';
import { normalizeTwitterHandle } from '@/lib/canonical';
import { findAliasHits } from '@/lib/server/tokenAliases';
import type { TweetEnrichmentAliasConfirmation } from '@/lib/server/twitterEnrichmentModel';

/** rule-v8: + KOL-scoped name/alias recall (e.g. $Z ← "gen z"/"Z世代"), LLM-gated */
const EXTRACTOR_VERSION = 'rule-v8';
const TRANSLATOR_VERSION = 'model-v4';

function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

function isValidSentiment(value: string | null | undefined): value is TweetMentionSentiment {
  return value === 'positive' || value === 'negative' || value === 'neutral';
}

/** Alias recall is KOL-scoped only (precision: low false-positive per PRD). Never throws —
 *  a failure here must not block normal mention extraction. */
function isTweetByMonitoredKOL(tweet: StoredTwitterTweet): boolean {
  try {
    const handle = normalize(normalizeTwitterHandle(tweet.authorHandle || ''));
    if (!handle) return false;
    const users = listMonitoredUsers();
    for (const user of users) {
      if (normalize(normalizeTwitterHandle(user.twitter || '')) === handle) return true;
    }
    return false;
  } catch {
    return false;
  }
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

function mentionIdentityKey(mention: {
  tokenAddress: string | null;
  tokenSymbol: string | null;
  chain?: string | null;
}) {
  const address = normalize(mention.tokenAddress);
  const symbol = normalize(mention.tokenSymbol);
  const chain = normalize(mention.chain);
  if (address) return `a:${chain}:${address}`;
  if (symbol) return `s:${symbol}`;
  return '';
}

function mergeMentions(params: {
  textMentions: ExtractedTweetTokenMention[];
  imageMentions: ExtractedTweetTokenMention[];
}): Array<ExtractedTweetTokenMention & { origin: TweetMentionOrigin }> {
  const merged: Array<ExtractedTweetTokenMention & { origin: TweetMentionOrigin }> = [];
  const seen = new Set<string>();

  const push = (mention: ExtractedTweetTokenMention, origin: TweetMentionOrigin) => {
    const key = mentionIdentityKey(mention);
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push({ ...mention, origin, rankInTweet: merged.length + 1 });
  };

  for (const mention of params.textMentions) {
    push(mention, 'text');
  }
  for (const mention of params.imageMentions) {
    push(mention, 'image');
  }
  return merged;
}

function readQuotedContent(sourceJson: string): string {
  try {
    const source = JSON.parse(sourceJson) as { quotedContent?: unknown };
    if (typeof source.quotedContent === 'string' && source.quotedContent.trim()) {
      return source.quotedContent.trim();
    }
  } catch {
    // fall through
  }
  return extractQuotedTextFromSourceJson(sourceJson);
}

function extractMentionsFromTweet(tweet: StoredTwitterTweet) {
  const blobs = [tweet.fullText, ...collectTweetSourceTexts(tweet.sourceJson)];
  const combined = blobs.filter(Boolean).join('\n');
  return extractTweetTokenMentions(combined, {
    bareSymbolAllowlist: getPrimaryPoolSymbolAllowlist(),
    officialTwitterByHandle: getPrimaryPoolOfficialTwitterMap(),
    onAmbiguousOfficialTwitter: (info) => {
      // 同一批 CA 只报一次，避免 enrichment 每条推文/TG 连发
      void barkOfficialTwitterCollisionOnce({
        handle: info.handle,
        tokens: info.tokens,
      });
    },
  });
}

/** Solana wallet addresses and token CAs share the same base58 format.
 *  Use DexScreener to distinguish: wallets return 0 pairs. */
async function isLikelyTokenAddress(address: string): Promise<boolean> {
  // EVM addresses are always CAs (not wallets)
  if (address.startsWith('0x')) return true;
  // Already in primary pool = previously validated
  const poolAddrs = getPrimaryPoolAddressSet();
  if (poolAddrs.has(address.toLowerCase())) return true;
  try {
    const dex = await fetchFromDexScreener(address, 'solana');
    return dex !== null && dex.ticker !== null;
  } catch {
    return false;
  }
}

/** CA not in primary pool → import (user rule). Best-effort, never throws. */
async function ensureExtractedCasInPrimaryPool(mentions: ExtractedTweetTokenMention[]) {
  const poolAddrs = getPrimaryPoolAddressSet();
  for (const m of mentions) {
    const addr = (m.tokenAddress || '').trim();
    if (!addr) continue;
    if (poolAddrs.has(addr.toLowerCase())) continue;
    const chain = addr.startsWith('0x') ? null : 'solana';
    // Validate Solana addresses: wallet addresses are base58 but not token CAs
    if (chain === 'solana' && !await isLikelyTokenAddress(addr)) {
      continue;
    }
    const res = ensurePrimaryPoolForAddress({
      address: addr,
      symbol: m.tokenSymbol,
      chain,
      reason: 'social_ca_mention',
    });
    if (res.entered) {
      console.log(`[primary-pool] imported CA ${addr} symbol=${m.tokenSymbol || ''}`);
    } else if (!res.ok) {
      console.warn(`[primary-pool] import CA failed ${addr}: ${res.error}`);
    }
  }
}

async function translateQuotedContent(params: {
  text: string;
  model: TweetEnrichmentModel;
}): Promise<{ translationZh: string | null; status: TweetEnrichmentStatus }> {
  const text = params.text.trim();
  if (!text) {
    return { translationZh: null, status: 'skipped' };
  }
  if (!isLikelyEnglish(text)) {
    return { translationZh: null, status: 'skipped' };
  }

  try {
    const maybeTranslateOnly = params.model as TweetEnrichmentModel & {
      translateOnly?: (value: string) => Promise<string | null>;
    };
    if (typeof maybeTranslateOnly.translateOnly === 'function') {
      const translationZh = await maybeTranslateOnly.translateOnly(text);
      return {
        translationZh,
        status: translationZh ? 'succeeded' : 'failed',
      };
    }

    const result = await params.model.enrichTweet({
      tweetId: 'quoted-content',
      text,
      mentions: [],
    });
    const translationZh = (result.translationZh || '').trim() || null;
    return {
      translationZh,
      status: translationZh ? 'succeeded' : 'failed',
    };
  } catch {
    return { translationZh: null, status: 'failed' };
  }
}

async function runEnrichmentForTweet(params: {
  tweet: StoredTwitterTweet;
  model: TweetEnrichmentModel;
  visionModel?: VisionEnrichmentModel;
  enqueueQuoteTweetIds?: string[];
}) {
  const textMentions = extractMentionsFromTweet(params.tweet);

  let visionStatus: TweetEnrichmentStatus = 'skipped';
  let imageMentions: ExtractedTweetTokenMention[] = [];
  const imageUrls = listImageUrlsFromSourceJson(params.tweet.sourceJson);
  if (imageUrls.length > 0) {
    try {
      imageMentions = await extractMentionsFromImageUrls(imageUrls, params.visionModel);
      visionStatus = 'succeeded';
    } catch (err) {
      console.warn(
        '[enrichment] vision failed:',
        err instanceof Error ? err.message : err
      );
      visionStatus = 'failed';
    }
  }

  const mergedMentions = mergeMentions({ textMentions, imageMentions });
  await ensureExtractedCasInPrimaryPool(mergedMentions);

  upsertTwitterTweetEnrichment({
    tweetId: params.tweet.tweetId,
    translationZh: null,
    translationStatus: 'processing',
    extractionStatus: 'processing',
    extractorVersion: EXTRACTOR_VERSION,
    translatorVersion: TRANSLATOR_VERSION,
    quotedTranslationZh: null,
    quotedTranslationStatus: 'pending',
    visionStatus: visionStatus === 'skipped' ? 'skipped' : 'processing',
    visionProcessedAtMs: Date.now(),
    lastProcessedAtMs: Date.now(),
    lastError: null,
  });

  let translationZh: string | null = null;
  let translationStatus: TweetEnrichmentStatus = 'failed';
  let sentiments: TweetEnrichmentModelOutputSentiment[] = [];
  let lastError: string | null = null;

  try {
    const result = await params.model.enrichTweet({
      tweetId: params.tweet.tweetId,
      text: params.tweet.fullText,
      mentions: mergedMentions.map((mention) => ({
        tokenAddress: mention.tokenAddress,
        tokenSymbol: mention.tokenSymbol,
        matchSource: mention.matchSource,
      })),
    });
    translationZh = (result.translationZh || '').trim() || null;
    translationStatus = translationZh ? 'succeeded' : isLikelyEnglish(params.tweet.fullText) ? 'failed' : 'skipped';
    sentiments = result.sentiments || [];
  } catch (error) {
    lastError = error instanceof Error ? error.message : 'unknown_enrichment_error';
    translationStatus = 'failed';
  }

  // Alias-based recall (token name / alt spelling, e.g. $Z ← "gen z" / "Z世代").
  // KOL-scoped + Chinese-capable LLM gate (enrichTweet above is English-only).
  const aliasMentions: Array<ExtractedTweetTokenMention & { origin: TweetMentionOrigin }> = [];
  let aliasSentiments: TweetEnrichmentAliasConfirmation[] = [];
  if (isTweetByMonitoredKOL(params.tweet) && typeof params.model.confirmAliasReferences === 'function') {
    const combinedText = [params.tweet.fullText, ...collectTweetSourceTexts(params.tweet.sourceJson)]
      .filter(Boolean)
      .join('\n');
    const alreadyAddr = new Set(mergedMentions.map((m) => normalize(m.tokenAddress)).filter(Boolean));
    const alreadySym = new Set(mergedMentions.map((m) => normalize(m.tokenSymbol)).filter(Boolean));
    const hits = findAliasHits(combinedText).filter(
      (h) =>
        !alreadyAddr.has(h.entry.address.toLowerCase()) &&
        !alreadySym.has(h.entry.symbol.toLowerCase()),
    );
    if (hits.length > 0) {
      try {
        aliasSentiments = await params.model.confirmAliasReferences!({
          text: combinedText,
          candidates: hits.map((h) => ({
            symbol: h.entry.symbol,
            name: h.entry.name,
            address: h.entry.address,
            chain: h.entry.chain,
            matchedAlias: h.matchedAlias,
          })),
        });
      } catch (err) {
        console.warn('[enrichment] alias confirm failed:', err instanceof Error ? err.message : err);
        aliasSentiments = [];
      }
      const confirmedAddr = new Set(aliasSentiments.map((a) => a.address.toLowerCase()));
      for (const h of hits) {
        if (!confirmedAddr.has(h.entry.address.toLowerCase())) continue;
        aliasMentions.push({
          tokenAddress: h.entry.address,
          tokenSymbol: h.entry.symbol,
          matchSource: 'ticker',
          rankInTweet: 0,
          origin: 'alias',
        });
      }
    }
  }
  const allMentions = [...mergedMentions, ...aliasMentions].map((mention, idx) => ({
    ...mention,
    rankInTweet: idx + 1,
  }));
  const combinedSentiments: TweetEnrichmentModelOutputSentiment[] = [
    ...sentiments,
    ...aliasSentiments.map((a) => ({
      tokenAddress: a.address,
      sentiment: a.sentiment,
      confidence: a.confidence,
    })),
  ];

  const withSentiment = allMentions.map((mention) => {
    const matched = pickMentionSentiment({ mention, sentiments: combinedSentiments });
    return {
      tokenAddress: mention.tokenAddress,
      tokenSymbol: mention.tokenSymbol,
      chain: null as string | null,
      matchSource: mention.matchSource,
      sentiment: (isValidSentiment(matched?.sentiment) ? matched.sentiment : 'neutral') as TweetMentionSentiment,
      confidence:
        typeof matched?.confidence === 'number' && Number.isFinite(matched.confidence)
          ? matched.confidence
          : null,
      rankInTweet: mention.rankInTweet,
      origin: mention.origin,
    };
  });

  const enrichedMentions = (await enrichMentionsMarketData({
    mentions: withSentiment,
    tweetCreatedAtMs: params.tweet.createdAtMs,
    concurrency: 3,
  })).filter((mention) => {
    // Solana wallet addresses match the same base58 regex as token CAs.
    // After DexScreener lookup, wallets have no chain → drop them.
    if (mention.matchSource === 'ca' && !mention.chain && !mention.tokenSymbol) {
      return false;
    }
    return true;
  });

  replaceTwitterTweetTokenMentions({
    tweetId: params.tweet.tweetId,
    mentions: enrichedMentions.map((mention) => ({
      tokenAddress: mention.tokenAddress,
      tokenSymbol: mention.tokenSymbol,
      chain: mention.chain,
      matchSource: mention.matchSource,
      sentiment: mention.sentiment,
      confidence: mention.confidence,
      rankInTweet: mention.rankInTweet,
      origin: mention.origin,
      marketCapUsd: mention.marketCapUsd,
      marketCapAtPostUsd: mention.marketCapAtPostUsd,
      marketCapAtPostEstimated: mention.marketCapAtPostEstimated,
      marketCapSource: mention.marketCapSource,
      resolvedAtMs: mention.resolvedAtMs,
    })),
  });

  // Quote translation
  let quotedTranslationZh: string | null = null;
  let quotedTranslationStatus: TweetEnrichmentStatus = 'skipped';
  const quoteTweetId = params.tweet.quoteTweetId?.trim() || '';
  const quotedText = readQuotedContent(params.tweet.sourceJson);
  const previous = listTwitterTweetEnrichmentsByTweetIds([params.tweet.tweetId])[0] || null;
  if (quoteTweetId) {
    params.enqueueQuoteTweetIds?.push(quoteTweetId);
  }
  // Always try quoted body translation when we have text (relay or nested source_json).
  // Projection still prefers the quoted tweet's own enrichment when available.
  if (quotedText) {
    const quoted = await translateQuotedContent({ text: quotedText, model: params.model });
    if (quoted.translationZh) {
      quotedTranslationZh = quoted.translationZh;
      quotedTranslationStatus = 'succeeded';
    } else if (previous?.quotedTranslationZh) {
      // Keep last good quote translation if this attempt failed
      quotedTranslationZh = previous.quotedTranslationZh;
      quotedTranslationStatus = previous.quotedTranslationStatus || 'succeeded';
    } else {
      quotedTranslationZh = null;
      quotedTranslationStatus = quoted.status;
    }
  } else if (quoteTweetId) {
    quotedTranslationStatus = 'skipped';
  } else if (previous?.quotedTranslationZh) {
    quotedTranslationZh = previous.quotedTranslationZh;
    quotedTranslationStatus = previous.quotedTranslationStatus || 'succeeded';
  }

  upsertTwitterTweetEnrichment({
    tweetId: params.tweet.tweetId,
    translationZh,
    translationStatus,
    extractionStatus: 'succeeded',
    extractorVersion: EXTRACTOR_VERSION,
    translatorVersion: TRANSLATOR_VERSION,
    quotedTranslationZh,
    quotedTranslationStatus,
    visionStatus,
    visionProcessedAtMs: Date.now(),
    lastProcessedAtMs: Date.now(),
    lastError,
  });

  // Extraction always completes; treat as success unless hard exception earlier.
  // Translation may fail independently without blocking ticker/MC/quote work.
  return true;
}

export async function runTweetEnrichmentForTweetIds(params: {
  tweetIds: string[];
  model?: TweetEnrichmentModel;
  visionModel?: VisionEnrichmentModel;
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
  const quoteTweetIdsToEnqueue: string[] = [];

  let succeeded = 0;
  let failed = 0;
  for (const tweet of tweets) {
    const ok = await runEnrichmentForTweet({
      tweet,
      model,
      visionModel: params.visionModel,
      enqueueQuoteTweetIds: quoteTweetIdsToEnqueue,
    });
    if (ok) {
      succeeded += 1;
    } else {
      failed += 1;
    }
  }

  // Ensure quoted source tweets also get their own enrichment (for independent translation)
  const pendingQuotes = Array.from(
    new Set(quoteTweetIdsToEnqueue.map((id) => id.trim()).filter(Boolean))
  ).filter((id) => !uniqueTweetIds.includes(id));

  if (pendingQuotes.length > 0) {
    const quoteTweets = listTwitterTweetsByIds(pendingQuotes);
    for (const tweet of quoteTweets) {
      try {
        await runEnrichmentForTweet({
          tweet,
          model,
          visionModel: params.visionModel,
        });
      } catch (err) {
        console.warn(
          '[enrichment] quote tweet enrich failed:',
          tweet.tweetId,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  return {
    total: tweets.length,
    succeeded,
    failed,
  };
}
