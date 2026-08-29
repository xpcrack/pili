import 'server-only';

import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import type { TelegramChannelPost, TelegramChannelSource } from '@/lib/server/telegramChannelTypes';
import {
  buildFomoThesisContent,
  classifyFomoChannelPost,
  extractFomoTradeAction,
  getOrCreateFomoUser,
  isFomoSourceChannel,
  resolveFomoAttributionUser,
} from '@/lib/server/fomoChannelAttribution';
import { extractTweetTokenMentions } from '@/lib/twitter/extractTweetTokenMentions';
import { isLikelyEnglish } from '@/lib/server/nvidiaEnrichmentModel';
import { enrichMentionsMarketData } from '@/lib/server/tweetTokenEnrichment';
import {
  barkOfficialTwitterCollisionOnce,
  ensurePrimaryPoolForAddress,
  getPrimaryPoolAddressSet,
  getPrimaryPoolOfficialTwitterMap,
  getPrimaryPoolSymbolAllowlist,
} from '@/lib/server/primaryPoolSymbols';
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

export async function projectTelegramChannelPostToFeed(params: {
  source: TelegramChannelSource;
  post: TelegramChannelPost;
}) {
  const postText = params.post.text || '';

  // fomoleaderboardfeed 类交易喊单帖：按 @handle 归属。
  //  - 喊单 thesis → source='fomo'，归关注的人或 user:fomo
  //  - 关注的人的交易 buy/sell → source='blockchain'（作为其交易记录，像链上交易显示）
  //  - 不认识的人的交易帖 → 丢弃标记
  const attribution = classifyFomoChannelPost(postText);
  let user: User;
  let fomoPumpDropped = false;
  let fomoTradeAsBlockchain = false;
  if (attribution.isFomoPumpPost) {
    const resolved = resolveFomoAttributionUser({ classification: attribution });
    if (!resolved.user) {
      // 不认识的人的交易帖 → 丢弃（仍构造占位 activity，ingest 依据标记不落库）
      user = getOrCreateFomoUser();
      fomoPumpDropped = true;
    } else {
      user = resolved.user;
      // 关注的人的交易 buy/sell 不作为 fomo 类别，作为其本人的链上交易记录
      fomoTradeAsBlockchain = resolved.user.id !== getOrCreateFomoUser().id && attribution.kind === 'trade';
    }
  } else {
    user = requireUser(params.source.userId);
  }

  const title = 'Telegram 频道发帖';
  const postUrl = buildTelegramPostUrl({
    channelUsername: params.post.channelUsername || params.source.channelUsername,
    messageId: params.post.messageId,
  });
  const mentions = extractTweetTokenMentions(postText, {
    bareSymbolAllowlist: getPrimaryPoolSymbolAllowlist(),
    officialTwitterByHandle: getPrimaryPoolOfficialTwitterMap(),
    onAmbiguousOfficialTwitter: (info) => {
      // 同一批 CA 只报一次，避免频道帖重复解析连发
      void barkOfficialTwitterCollisionOnce({
        handle: info.handle,
        tokens: info.tokens,
      });
    },
  });
  // CA not in primary pool → import
  const poolAddrs = getPrimaryPoolAddressSet();
  for (const m of mentions) {
    const addr = (m.tokenAddress || '').trim();
    if (!addr || poolAddrs.has(addr.toLowerCase())) continue;
    await ensurePrimaryPoolForAddress({
      address: addr,
      symbol: m.tokenSymbol,
      chain: addr.startsWith('0x') ? null : 'solana',
      reason: 'telegram_ca_mention',
    });
  }
  const mentionedTickers = [...new Set(mentions.map(m => m.tokenSymbol).filter(Boolean))] as string[];
  const mentionedTokenAddresses = [...new Set(mentions.map(m => m.tokenAddress).filter(Boolean))] as string[];
  const tokenSentiments = mentions.map(m => ({
    tokenSymbol: m.tokenSymbol || undefined,
    tokenAddress: m.tokenAddress || undefined,
    chain: undefined as string | undefined,
    sentiment: 'neutral' as const,
    matchSource: m.matchSource,
  }));

  const isFomoSource = isFomoSourceChannel(params.post.channelUsername || params.source.channelUsername);
  const isFomoPumpKind = attribution.isFomoPumpPost && attribution.kind === 'thesis';
  // 关注的人的交易帖 → 作为其本人链上交易记录（source='blockchain', type='transfer'）。
  const fomoTradeAction = fomoTradeAsBlockchain ? extractFomoTradeAction(postText) : null;

  // 信源：交易帖(blockchain) → 交易记录；fomo 信源群喊单 → fomo；其余 → telegram。
  const activitySource: Activity['source'] = fomoTradeAsBlockchain
    ? 'blockchain'
    : isFomoSource
      ? 'fomo'
      : 'telegram';
  const activityType: Activity['type'] = fomoTradeAsBlockchain ? 'transfer' : 'post';
  const activityContent =
    fomoTradeAsBlockchain
      ? postText || '(empty)'
      : isFomoSource && isFomoPumpKind
        ? buildFomoThesisContent(postText, attribution.traderHandle)
        : postText || '(empty)';
  const activityTitle = fomoTradeAsBlockchain ? '链上监控交易' : isFomoSource ? 'FOMO 喊单' : title;

  const activity = {
    id: `telegram:${params.post.channelChatId}:${params.post.messageId}`,
    userId: user.id,
    source: activitySource,
    type: activityType,
    title: activityTitle,
    content: activityContent,
    timestamp: params.post.postedAtMs,
    metadata: {
      rawText: params.post.text || undefined,
      media: params.post.media.length > 0 ? params.post.media : undefined,
      ...(fomoTradeAsBlockchain && fomoTradeAction
        ? { txAction: fomoTradeAction, displayActionVariantLabel: fomoTradeAction === 'buy' ? '买入' : '卖出' }
        : {}),
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
      ...(attribution.isFomoPumpPost
        ? {
            fomoPumpKind: attribution.kind,
            fomoTraderHandle: attribution.traderHandle || undefined,
            ...(fomoPumpDropped ? { fomoPumpDropped: true } : {}),
          }
        : {}),
    },
  } satisfies Activity;

  return {
    user,
    activity,
  };
}

function hasMarketEnrichmentGain(
  before: Activity['metadata']['tokenSentiments'] | undefined,
  after: Activity['metadata']['tokenSentiments'] | undefined
) {
  const prev = before || [];
  const next = after || [];
  if (next.length === 0) return false;
  return next.some((item, index) => {
    const original = prev[index];
    if (!original) return Boolean(item.tokenSymbol || item.marketCapUsd || item.marketCapAtPostUsd);
    return (
      (!original.tokenSymbol && Boolean(item.tokenSymbol)) ||
      (!original.marketCapUsd && typeof item.marketCapUsd === 'number') ||
      (!original.marketCapAtPostUsd && typeof item.marketCapAtPostUsd === 'number') ||
      (!original.chain && Boolean(item.chain))
    );
  });
}

export function telegramChannelEnrichmentHasUpdates(params: {
  before: Activity;
  after: Activity;
}) {
  if (params.after.metadata.translationZh && params.after.metadata.translationZh !== params.before.metadata.translationZh) {
    return true;
  }
  return hasMarketEnrichmentGain(params.before.metadata.tokenSentiments, params.after.metadata.tokenSentiments);
}

export async function enrichTelegramChannelPost(activity: Activity): Promise<Activity> {
  const text = activity.content.trim();
  let updatedMetadata: Activity['metadata'] = { ...activity.metadata };

  // 1) Market/ticker enrichment — always run when CA mentions exist (independent of language)
  const baseSentiments = activity.metadata.tokenSentiments || [];
  const addressMentions = baseSentiments.filter((item) => Boolean((item.tokenAddress || '').trim()));
  if (addressMentions.length > 0) {
    try {
      const enrichedMentions = await enrichMentionsMarketData({
        mentions: addressMentions.map((item, index) => ({
          tokenAddress: item.tokenAddress || null,
          tokenSymbol: item.tokenSymbol || null,
          chain: item.chain || null,
          matchSource: item.matchSource || 'ca',
          sentiment: item.sentiment || 'neutral',
          confidence: null,
          rankInTweet: index,
          origin: 'text' as const,
        })),
        tweetCreatedAtMs: activity.timestamp,
        concurrency: 3,
      });

      const enrichedByAddress = new Map(
        enrichedMentions
          .filter((item) => item.tokenAddress)
          .map((item) => [item.tokenAddress!.toLowerCase(), item] as const)
      );

      const nextSentiments = baseSentiments.map((item) => {
        const key = (item.tokenAddress || '').toLowerCase();
        const enriched = key ? enrichedByAddress.get(key) : undefined;
        if (!enriched) return item;
        return {
          tokenSymbol: enriched.tokenSymbol || item.tokenSymbol || undefined,
          tokenAddress: item.tokenAddress || enriched.tokenAddress || undefined,
          chain: enriched.chain || item.chain || undefined,
          sentiment: item.sentiment,
          matchSource: enriched.matchSource || item.matchSource,
          marketCapUsd: enriched.marketCapUsd ?? undefined,
          marketCapAtPostUsd: enriched.marketCapAtPostUsd ?? undefined,
          marketCapAtPostEstimated: enriched.marketCapAtPostEstimated || undefined,
          marketCapSource: enriched.marketCapSource || undefined,
        };
      });
      const finalTickers = [
        ...new Set(
          nextSentiments
            .map((item) => (item.tokenSymbol || '').trim())
            .filter(Boolean)
        ),
      ];
      updatedMetadata = {
        ...updatedMetadata,
        tokenSentiments: nextSentiments,
        mentionedTickers: finalTickers.length > 0 ? finalTickers : updatedMetadata.mentionedTickers,
      };
    } catch (error) {
      console.warn(
        '[telegram-enrichment] market data failed:',
        error instanceof Error ? error.message : error
      );
    }
  }

  // 2) Translation + sentiment — English only, requires API key
  if (!text || !isLikelyEnglish(text)) {
    return {
      ...activity,
      metadata: updatedMetadata,
    };
  }

  try {
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
      }) => import('@/lib/server/twitterEnrichmentModel').TweetEnrichmentModel;
      resolveEnrichmentApiKey: () => string;
      resolveEnrichmentBaseUrl: () => string;
      resolveEnrichmentModel: () => string;
    };
    const apiKey = resolveEnrichmentApiKey();
    if (!apiKey) {
      return {
        ...activity,
        metadata: updatedMetadata,
      };
    }
    const model = new NvidaQwenEnrichmentModel({
      apiKey,
      model: resolveEnrichmentModel(),
      baseUrl: resolveEnrichmentBaseUrl(),
    });

    const mentions = (updatedMetadata.tokenSentiments || []).map(s => ({
      tokenSymbol: s.tokenSymbol || null,
      tokenAddress: s.tokenAddress || null,
      matchSource: s.matchSource || 'ticker' as const,
    }));

    const result = await model.enrichTweet({
      tweetId: activity.id,
      text,
      mentions,
    });

    updatedMetadata = {
      ...updatedMetadata,
      translationZh: result.translationZh || undefined,
      translationStatus: result.translationZh ? 'succeeded' as const : 'failed' as const,
    };

    if (result.sentiments.length > 0) {
      // Preserve market fields + matchSource from market enrichment above
      const originalSentiments = updatedMetadata.tokenSentiments || [];
      updatedMetadata.tokenSentiments = result.sentiments.map(s => {
        const original = originalSentiments.find(o =>
          (o.tokenSymbol || '').toLowerCase() === (s.tokenSymbol || '').toLowerCase()
          && (o.tokenAddress || '').toLowerCase() === (s.tokenAddress || '').toLowerCase()
        );
        return {
          tokenSymbol: s.tokenSymbol || original?.tokenSymbol,
          tokenAddress: s.tokenAddress || original?.tokenAddress,
          chain: original?.chain,
          sentiment: s.sentiment,
          matchSource: original?.matchSource || 'both' as const,
          marketCapUsd: original?.marketCapUsd,
          marketCapAtPostUsd: original?.marketCapAtPostUsd,
          marketCapAtPostEstimated: original?.marketCapAtPostEstimated,
          marketCapSource: original?.marketCapSource,
        };
      });
    }

    return {
      ...activity,
      metadata: updatedMetadata,
    };
  } catch (error) {
    console.warn('[telegram-enrichment] failed:', error instanceof Error ? error.message : error);
    return {
      ...activity,
      metadata: updatedMetadata,
    };
  }
}
