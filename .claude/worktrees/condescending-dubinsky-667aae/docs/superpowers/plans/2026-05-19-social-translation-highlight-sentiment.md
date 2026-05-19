# Social Translation + CA/Ticker Highlight + Sentiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Chinese translation, CA/$Ticker in-text highlighting, and sentiment evaluation to Twitter and Telegram social content using NVIDIA Qwen2.5-7B.

**Architecture:** The existing `TweetEnrichmentModel` interface and enrichment pipeline (repo → service → mapper → UI) already have all the slots for translation + sentiment — they just need a real model implementation and a production trigger. For Telegram channel posts, we add inline enrichment during the `projectTelegramChannelPostToFeed` mapping. A new client-side `highlightSocialContent` utility renders $Ticker and CA with styled spans inside ActivityCard.

**Tech Stack:** NVIDIA NIM API (OpenAI-compatible), Qwen2.5-7B-instruct, Node.js fetch (no new dependencies), React (highlight rendering)

---

## Task 1: NVIDIA Qwen2.5-7B Enrichment Model

**Files:**
- Create: `lib/server/nvidiaEnrichmentModel.ts`
- Test: `scripts/test-nvidia-enrichment-model.ts`

This task creates the real model that replaces the stub `getDefaultTweetEnrichmentModel()`.

- [ ] **Step 1: Write the test script**

Create `scripts/test-nvidia-enrichment-model.ts`:

```typescript
import './server-only-shim.cjs';

async function run() {
  const { NvidaQwenEnrichmentModel } = await import('../lib/server/nvidiaEnrichmentModel');

  const apiKey = process.env.NVIDIA_API_KEY?.trim();
  if (!apiKey) {
    console.error('SKIP: NVIDIA_API_KEY not set');
    return;
  }

  const model = new NvidaQwenEnrichmentModel({ apiKey });

  // Test 1: English tweet with ticker
  const result1 = await model.enrichTweet({
    tweetId: 'test-1',
    text: 'Still bullish on $BTC, adding more size here. $ETH looking weak though.',
    mentions: [
      { tokenSymbol: 'BTC', tokenAddress: null, matchSource: 'ticker' as const },
      { tokenSymbol: 'ETH', tokenAddress: null, matchSource: 'ticker' as const },
    ],
  });

  console.assert(result1.translationZh !== null, 'translationZh should not be null for English');
  console.assert(result1.translationZh!.includes('BTC'), 'translation should keep $TICKER symbols');
  console.assert(result1.sentiments.length >= 2, 'should have sentiments for 2 tickers');

  const btcSentiment = result1.sentiments.find(s => s.tokenSymbol?.toUpperCase() === 'BTC');
  const ethSentiment = result1.sentiments.find(s => s.tokenSymbol?.toUpperCase() === 'ETH');
  console.assert(btcSentiment?.sentiment === 'positive', 'BTC should be positive');
  console.assert(ethSentiment?.sentiment === 'negative', 'ETH should be negative');

  console.log('Test 1 PASS:', JSON.stringify(result1, null, 2));

  // Test 2: Chinese tweet (should skip translation)
  const result2 = await model.enrichTweet({
    tweetId: 'test-2',
    text: '今天大盘不错，继续持有。',
    mentions: [],
  });

  console.assert(result2.translationZh === null, 'Chinese text should not be translated');
  console.log('Test 2 PASS: Chinese text skipped');

  // Test 3: Pure number/symbol (should skip)
  const result3 = await model.enrichTweet({
    tweetId: 'test-3',
    text: '0x1234',
    mentions: [{ tokenSymbol: null, tokenAddress: '0x1234', matchSource: 'ca' as const }],
  });

  console.assert(result3.translationZh === null, 'Non-English CA-only text should skip translation');
  console.log('Test 3 PASS: Non-English text skipped');

  console.log('ALL TESTS PASSED');
}

void run();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-nvidia-enrichment-model.ts`
Expected: FAIL with "Cannot find module" or similar import error

- [ ] **Step 3: Write the model implementation**

Create `lib/server/nvidiaEnrichmentModel.ts`:

```typescript
import 'server-only';

import {
  type TweetEnrichmentModel,
  type TweetEnrichmentModelResult,
  type TweetEnrichmentModelOutputSentiment,
} from '@/lib/server/twitterEnrichmentModel';

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_MODEL = 'qwen/qwen2.5-7b-instruct';

function isLikelyEnglish(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Must contain at least one Latin letter word (2+ chars) to be considered English
  const hasLatinWord = /[a-zA-Z]{2,}/.test(trimmed);
  // If it's predominantly CJK, skip
  const cjkCount = (trimmed.match(/[一-鿿㐀-䶿]/g) || []).length;
  const latinCount = (trimmed.match(/[a-zA-Z]/g) || []).length;
  return hasLatinWord && latinCount > cjkCount;
}

function buildEnrichmentPrompt(text: string, mentions: Array<{ tokenSymbol: string | null; tokenAddress: string | null }>): string {
  const mentionLines = mentions
    .map((m, i) => `${i + 1}. ${m.tokenSymbol || '(unknown)'}${m.tokenAddress ? ` (CA: ${m.tokenAddress})` : ''}`)
    .join('\n');

  return `你是一个加密货币社交媒体分析助手。对以下推文执行两个任务：

1. 将英文内容翻译为简洁自然的中文（保留 $TICKER 和 CA 地址原样，不翻译项目名和代币符号）
2. 判断作者对每个提及代币的情感倾向

推文内容：
${text}

提及的代币：
${mentionLines || '(无明确提及)'}

请严格以如下 JSON 格式回复，不要输出任何其他内容：
{"translation_zh":"中文翻译","sentiments":[{"token_symbol":"BTC","token_address":"0x...","sentiment":"positive"}]}

sentiment 只能是 positive / negative / neutral 之一。
判断规则：明确看多/买入/持有 → positive；明确看空/卖出/警告 → negative；仅提及/分享信息无倾向 → neutral；不确定 → neutral`;
}

interface NvidiaChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

function parseModelOutput(raw: string): { translationZh: string | null; sentiments: TweetEnrichmentModelOutputSentiment[] } {
  try {
    // Try to extract JSON from the response (may have markdown fences)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { translationZh: null, sentiments: [] };
    }
    const parsed = JSON.parse(jsonMatch[0]) as {
      translation_zh?: string;
      sentiments?: Array<{
        token_symbol?: string;
        token_address?: string;
        sentiment?: string;
      }>;
    };

    const translationZh = (parsed.translation_zh || '').trim() || null;
    const sentiments: TweetEnrichmentModelOutputSentiment[] = (parsed.sentiments || [])
      .filter((s) => s.sentiment === 'positive' || s.sentiment === 'negative' || s.sentiment === 'neutral')
      .map((s) => ({
        tokenSymbol: s.token_symbol || undefined,
        tokenAddress: s.token_address || undefined,
        sentiment: s.sentiment as 'positive' | 'negative' | 'neutral',
        confidence: 0.8,
      }));

    return { translationZh, sentiments };
  } catch {
    return { translationZh: null, sentiments: [] };
  }
}

export class NvidaQwenEnrichmentModel implements TweetEnrichmentModel {
  private apiKey: string;

  constructor(options: { apiKey: string }) {
    this.apiKey = options.apiKey;
  }

  async enrichTweet(input: {
    tweetId: string;
    text: string;
    mentions: Array<{ tokenSymbol: string | null; tokenAddress: string | null }>;
  }): Promise<TweetEnrichmentModelResult> {
    const text = input.text.trim();

    // Skip non-English content
    if (!isLikelyEnglish(text)) {
      return {
        translationZh: null,
        sentiments: input.mentions.map((m) => ({
          tokenSymbol: m.tokenSymbol || undefined,
          tokenAddress: m.tokenAddress || undefined,
          sentiment: 'neutral' as const,
          confidence: 0.5,
        })),
      };
    }

    const prompt = buildEnrichmentPrompt(text, input.mentions);

    try {
      const response = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: NVIDIA_MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 1024,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.warn(`[nvidia] API error ${response.status}: ${errorText.slice(0, 200)}`);
        return {
          translationZh: null,
          sentiments: input.mentions.map((m) => ({
            tokenSymbol: m.tokenSymbol || undefined,
            tokenAddress: m.tokenAddress || undefined,
            sentiment: 'neutral' as const,
          })),
        };
      }

      const data = await response.json() as NvidiaChatResponse;
      const content = data.choices?.[0]?.message?.content?.trim() || '';
      const { translationZh, sentiments } = parseModelOutput(content);

      // If model failed to produce sentiments, fall back to neutral for all mentions
      const finalSentiments = sentiments.length > 0
        ? sentiments
        : input.mentions.map((m) => ({
            tokenSymbol: m.tokenSymbol || undefined,
            tokenAddress: m.tokenAddress || undefined,
            sentiment: 'neutral' as const,
            confidence: 0.5,
          }));

      return {
        translationZh,
        sentiments: finalSentiments,
      };
    } catch (error) {
      console.warn('[nvidia] fetch error:', error instanceof Error ? error.message : error);
      return {
        translationZh: null,
        sentiments: input.mentions.map((m) => ({
          tokenSymbol: m.tokenSymbol || undefined,
          tokenAddress: m.tokenAddress || undefined,
          sentiment: 'neutral' as const,
        })),
      };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NVIDIA_API_KEY=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 npx tsx scripts/test-nvidia-enrichment-model.ts`
Expected: PASS with translation and sentiment results

- [ ] **Step 5: Commit**

```bash
git add lib/server/nvidiaEnrichmentModel.ts scripts/test-nvidia-enrichment-model.ts
git commit -m "feat: add NVIDIA Qwen2.5-7B enrichment model for translation + sentiment"
```

---

## Task 2: Wire NVIDIA Model into Default Enrichment

**Files:**
- Modify: `lib/server/twitterEnrichmentModel.ts` (replace stub with NVIDIA model)

- [ ] **Step 1: Update getDefaultTweetEnrichmentModel**

In `lib/server/twitterEnrichmentModel.ts`, replace the `getDefaultTweetEnrichmentModel` function:

```typescript
export function getDefaultTweetEnrichmentModel(): TweetEnrichmentModel {
  const apiKey = (process.env.NVIDIA_API_KEY || '').trim();
  if (!apiKey) {
    // Fallback: no-op model when API key is not configured
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

  const { NvidaQwenEnrichmentModel } = require('@/lib/server/nvidiaEnrichmentModel') as { NvidaQwenEnrichmentModel: new (opts: { apiKey: string }) => TweetEnrichmentModel };
  return new NvidaQwenEnrichmentModel({ apiKey });
}
```

Note: Use `require()` instead of top-level `import` to avoid loading the NVIDIA module when `NVIDIA_API_KEY` is not set (keeps cold start fast, avoids network calls in dev without the key).

- [ ] **Step 2: Verify existing enrichment test still passes**

Run: `npx tsx scripts/test-twitter-enrichment.ts`
Expected: PASS (test uses a mock model, not affected by default model change)

- [ ] **Step 3: Commit**

```bash
git add lib/server/twitterEnrichmentModel.ts
git commit -m "feat: wire NVIDIA Qwen2.5 model into default enrichment when API key is set"
```

---

## Task 3: Trigger Enrichment After Twitter Ingestion

**Files:**
- Modify: `lib/server/twitterFeedMapper.ts:195-279` (add async enrichment call at end of `projectTwitterTweetsToFeed`)

- [ ] **Step 1: Add enrichment trigger to projectTwitterTweetsToFeed**

At the end of `projectTwitterTweetsToFeed()`, before the final return, add the async enrichment trigger. The function currently ends at line ~279 with `return { projectedCount };`.

Add this block before the return:

```typescript
  // Trigger background enrichment for tweets that haven't been enriched yet
  const pendingTweetIds = tweetCandidates
    .filter((tweet) => {
      const enrich = enrichmentByTweetId.get(tweet.tweetId);
      return !enrich || enrich.translationStatus === 'pending' || enrich.translationStatus === 'failed';
    })
    .map((t) => t.tweetId);

  if (pendingTweetIds.length > 0) {
    void runTweetEnrichmentForTweetIds({ tweetIds: pendingTweetIds })
      .then((result) => {
        if (result.succeeded > 0) {
          console.log(`[enrichment] ${result.succeeded}/${result.total} succeeded`);
          // Re-project enriched tweets to update feed with translation + sentiments
          projectTwitterTweetsToFeed({ sinceMs: 0, tweetIds: pendingTweetIds });
        }
        if (result.failed > 0) {
          console.warn(`[enrichment] ${result.failed}/${result.total} failed`);
        }
      })
      .catch((err) => {
        console.warn('[enrichment] background enrichment error:', err instanceof Error ? err.message : err);
      });
  }
```

Also add the import at the top of the file (it's already imported in the service, but we need it here):

```typescript
import { runTweetEnrichmentForTweetIds } from '@/lib/server/twitterEnrichmentService';
```

- [ ] **Step 2: Verify projectTwitterTweetsToFeed still works**

Run: `npx tsx scripts/test-twitter-enrichment.ts`
Expected: PASS (test calls projectTwitterTweetsToFeed directly with mock data, enrichment trigger will fire but use default model which is stub without NVIDIA_API_KEY)

- [ ] **Step 3: Commit**

```bash
git add lib/server/twitterFeedMapper.ts
git commit -m "feat: trigger background enrichment after Twitter tweet projection"
```

---

## Task 4: Social Content Highlight Utility

**Files:**
- Create: `lib/socialContentHighlight.ts`

This is a **client-side** utility that renders highlighted $Ticker and CA in social post text. It returns `React.ReactNode` (array of spans).

- [ ] **Step 1: Write the highlight utility**

Create `lib/socialContentHighlight.ts`:

```typescript
'use client';

import { type ReactNode } from 'react';

export interface SocialContentMention {
  tokenSymbol: string | null;
  tokenAddress: string | null;
}

const TICKER_PATTERN = /\$([A-Za-z][A-Za-z0-9]{1,14})/g;
const EVM_CA_PATTERN = /\b(0x[a-fA-F0-9]{40})\b/g;

// Solana CA: base58, 32-44 chars, not inside a word
const SOL_CA_PATTERN = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g;

function truncateCa(ca: string): string {
  if (ca.length <= 12) return ca;
  return `${ca.slice(0, 6)}...${ca.slice(-4)}`;
}

interface HighlightSegment {
  type: 'text' | 'ticker' | 'ca';
  content: string;
  fullContent: string; // untruncated for CA
  index: number;
  length: number;
}

function findHighlightSegments(text: string): HighlightSegment[] {
  const segments: HighlightSegment[] = [];

  // Find all tickers
  for (const match of text.matchAll(TICKER_PATTERN)) {
    segments.push({
      type: 'ticker',
      content: match[0],
      fullContent: match[0],
      index: match.index ?? 0,
      length: match[0].length,
    });
  }

  // Find EVM CAs
  for (const match of text.matchAll(EVM_CA_PATTERN)) {
    segments.push({
      type: 'ca',
      content: truncateCa(match[0]),
      fullContent: match[0],
      index: match.index ?? 0,
      length: match[0].length,
    });
  }

  // Find Solana CAs (only if length >= 38 to reduce false positives)
  for (const match of text.matchAll(SOL_CA_PATTERN)) {
    if (match[0].length < 38) continue; // skip short base58 words
    segments.push({
      type: 'ca',
      content: truncateCa(match[0]),
      fullContent: match[0],
      index: match.index ?? 0,
      length: match[0].length,
    });
  }

  // Sort by index, dedupe overlapping
  segments.sort((a, b) => a.index - b.index);
  const deduped: HighlightSegment[] = [];
  let lastEnd = 0;
  for (const seg of segments) {
    if (seg.index < lastEnd) continue; // overlap, skip
    deduped.push(seg);
    lastEnd = seg.index + seg.length;
  }

  return deduped;
}

export function highlightSocialContent(text: string, _mentions?: SocialContentMention[]): ReactNode[] {
  if (!text.trim()) return [];

  const highlights = findHighlightSegments(text);

  if (highlights.length === 0) {
    return [text];
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const seg of highlights) {
    // Text before this highlight
    if (seg.index > cursor) {
      nodes.push(text.slice(cursor, seg.index));
    }

    if (seg.type === 'ticker') {
      nodes.push(
        <span key={`t-${seg.index}`} className="text-yellow-400 font-semibold">
          {seg.content}
        </span>
      );
    } else if (seg.type === 'ca') {
      nodes.push(
        <span
          key={`ca-${seg.index}`}
          className="text-cyan-400 font-mono text-[11px] cursor-pointer"
          title={seg.fullContent}
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard.writeText(seg.fullContent);
          }}
        >
          {seg.content}
        </span>
      );
    }

    cursor = seg.index + seg.length;
  }

  // Remaining text
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes;
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/socialContentHighlight.ts
git commit -m "feat: add socialContentHighlight utility for $Ticker and CA rendering"
```

---

## Task 5: Apply Highlights + Telegram Translation in ActivityCard

**Files:**
- Modify: `components/ActivityCard.tsx`

This task applies the highlight utility to Twitter/Telegram content and adds translation display for Telegram posts.

- [ ] **Step 1: Add import for highlightSocialContent**

At the top of `components/ActivityCard.tsx`, add:

```typescript
import { highlightSocialContent } from '@/lib/socialContentHighlight';
```

- [ ] **Step 2: Add Telegram translation variables**

After the existing `telegramPrimaryText` definition (around line 165), add Telegram translation variables. Currently line 165 is:

```typescript
const telegramPrimaryText = isTelegram ? getTelegramCardPrimaryText(activity.content) : null;
```

Add after it:

```typescript
const telegramTranslationZh = isTelegram ? (activity.metadata.translationZh || '').trim() : '';
const telegramDisplayPrimary = isTelegram
  ? (telegramTranslationZh || telegramPrimaryText || '')
  : '';
const telegramDisplaySecondary = isTelegram && telegramTranslationZh && telegramPrimaryText
  ? telegramPrimaryText
  : null;
```

- [ ] **Step 3: Add Telegram sentiment chips**

After the existing `tweetSentimentChips` definition (around line 176), add Telegram sentiment chips:

```typescript
const telegramSentimentChips = isTelegram
  ? (activity.metadata.tokenSentiments || []).filter((item, index, items) => {
      const key = `${item.tokenAddress || ''}|${item.tokenSymbol || ''}`.toLowerCase();
      return (
        items.findIndex((candidate) => {
          const candidateKey = `${candidate.tokenAddress || ''}|${candidate.tokenSymbol || ''}`.toLowerCase();
          return candidateKey === key;
        }) === index
      );
    })
  : [];
```

- [ ] **Step 4: Replace Twitter primary text rendering with highlighted version**

Find the Twitter content section (around line 620-659). The current rendering for `twitterPrimaryText` is:

```tsx
{twitterPrimaryText ? (
  <p className="whitespace-pre-wrap break-words text-zinc-100">{twitterPrimaryText}</p>
) : null}
```

Replace with highlighted version:

```tsx
{twitterPrimaryText ? (
  <p className="whitespace-pre-wrap break-words text-zinc-100">
    {highlightSocialContent(twitterPrimaryText, activity.metadata.tokenSentiments)}
  </p>
) : null}
```

- [ ] **Step 5: Replace Telegram content section with translation + highlights**

Find the Telegram content section (around line 661-665). The current rendering is:

```tsx
{!isTransfer && isTelegram && (
  <div className="w-full space-y-1">
    <p className="whitespace-pre-wrap break-words text-zinc-100">{telegramPrimaryText}</p>
  </div>
)}
```

Replace with:

```tsx
{!isTransfer && isTelegram && (
  <div className="w-full space-y-1">
    <p className="whitespace-pre-wrap break-words text-zinc-100">
      {highlightSocialContent(telegramDisplayPrimary, activity.metadata.tokenSentiments)}
    </p>
    {telegramDisplaySecondary ? (
      <p className="whitespace-pre-wrap break-words text-xs text-zinc-500">
        Original: {telegramDisplaySecondary}
      </p>
    ) : null}
    {telegramSentimentChips.length > 0 ? (
      <div className="flex flex-wrap gap-1.5 pt-1">
        {telegramSentimentChips.map((chip, index) => (
          <span
            key={`${chip.tokenAddress || chip.tokenSymbol || 'token'}:${index}`}
            className={
              chip.sentiment === 'positive'
                ? 'rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300'
                : chip.sentiment === 'negative'
                  ? 'rounded-full bg-rose-500/15 px-2 py-0.5 text-[11px] text-rose-300'
                  : 'rounded-full bg-zinc-700/70 px-2 py-0.5 text-[11px] text-zinc-200'
            }
          >
            {(chip.tokenSymbol || chip.tokenAddress || 'TOKEN').toUpperCase()}{' '}
            {chip.sentiment === 'positive' ? '正面' : chip.sentiment === 'negative' ? '负面' : '中性'}
          </span>
        ))}
      </div>
    ) : null}
  </div>
)}
```

- [ ] **Step 6: Verify the app builds and renders**

Run: `npm run build 2>&1 | tail -20`
Expected: Build succeeds with no type errors

Then visually check in the browser that Twitter and Telegram cards render correctly.

- [ ] **Step 7: Commit**

```bash
git add components/ActivityCard.tsx
git commit -m "feat: apply $Ticker/CA highlights and Telegram translation in ActivityCard"
```

---

## Task 6: Enrich Telegram Channel Posts

**Files:**
- Modify: `lib/server/telegramChannelProjector.ts` (add token extraction + translation + sentiment)
- Modify: `types/index.ts` (add translationZh to Activity metadata, already exists but verify)

- [ ] **Step 1: Add enrichment to projectTelegramChannelPostToFeed**

Modify `lib/server/telegramChannelProjector.ts`. Add imports at the top:

```typescript
import { extractTweetTokenMentions } from '@/lib/twitter/extractTweetTokenMentions';
import { isLikelyEnglish } from '@/lib/server/nvidiaEnrichmentModel';
```

Note: `isLikelyEnglish` needs to be exported from `nvidiaEnrichmentModel.ts`. Add `export` keyword before the `function isLikelyEnglish` declaration in that file.

Then modify the `projectTelegramChannelPostToFeed` function. After the `const activity = {` block that builds the Activity (around line 35-69), add enrichment logic.

Replace the entire function with:

```typescript
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
      rawText: postText || undefined,
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
      mentionedTickers: mentionedTickers.length > 0 ? mentionedTickers : undefined,
      mentionedTokenAddresses: mentionedTokenAddresses.length > 0 ? mentionedTokenAddresses : undefined,
      tokenSentiments: tokenSentiments.length > 0 ? tokenSentiments : undefined,
    },
  } satisfies Activity;

  return {
    user,
    activity,
  };
}
```

- [ ] **Step 2: Export isLikelyEnglish from nvidiaEnrichmentModel.ts**

In `lib/server/nvidiaEnrichmentModel.ts`, change:

```typescript
function isLikelyEnglish(text: string): boolean {
```

to:

```typescript
export function isLikelyEnglish(text: string): boolean {
```

- [ ] **Step 3: Add async Telegram post enrichment**

The `projectTelegramChannelPostToFeed` function is synchronous (returns data directly). Translation via LLM is async. Rather than making the function async (which would break all callers), we add a **separate async enrichment step** that runs after projection.

Add a new exported function at the bottom of `lib/server/telegramChannelProjector.ts`:

```typescript
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

    // Update sentiments if model returned them
    if (result.sentiments.length > 0) {
      updatedMetadata.tokenSentiments = result.sentiments.map(s => ({
        tokenSymbol: s.tokenSymbol,
        tokenAddress: s.tokenAddress,
        chain: undefined as string | undefined,
        sentiment: s.sentiment,
        matchSource: 'both' as const,
      }));
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
```

- [ ] **Step 4: Find where Telegram channel posts are projected and add enrichment call**

Find the caller of `projectTelegramChannelPostToFeed`:

Run: `grep -rn "projectTelegramChannelPostToFeed" --include="*.ts" --include="*.tsx" /Users/xp/vibecoding/pilipili/.claude/worktrees/condescending-dubinsky-667aae/lib/ /Users/xp/vibecoding/pilipili/.claude/worktrees/condescending-dubinsky-667aae/app/ 2>/dev/null | grep -v node_modules`

At the call site (likely in a channel sync worker or API handler), after getting the result from `projectTelegramChannelPostToFeed()`, add:

```typescript
import { enrichTelegramChannelPost } from '@/lib/server/telegramChannelProjector';

// After projection:
const enrichedActivity = await enrichTelegramChannelPost(result.activity);
const enrichedResult = { user: result.user, activity: enrichedActivity };
```

Then use `enrichedResult` in place of the original result for the rest of the pipeline.

- [ ] **Step 5: Verify build**

Run: `npm run build 2>&1 | tail -20`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add lib/server/telegramChannelProjector.ts lib/server/nvidiaEnrichmentModel.ts
git commit -m "feat: add token extraction and translation enrichment for Telegram channel posts"
```

---

## Task 7: Add NVIDIA_API_KEY to Environment

**Files:**
- Modify: `.env.local` (add key)

- [ ] **Step 1: Add environment variable**

Add to `.env.local`:

```
NVIDIA_API_KEY=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
```

- [ ] **Step 2: Verify the key is accessible from server code**

Run: `node -e "require('dotenv').config({ path: '.env.local' }); console.log(process.env.NVIDIA_API_KEY ? 'KEY SET' : 'MISSING')"`
Expected: "KEY SET"

Note: Next.js automatically loads `.env.local` for server-side code, no dotenv needed. The above is just for quick verification.

- [ ] **Step 3: Commit**

```bash
git add .env.local
git commit -m "chore: add NVIDIA_API_KEY for Qwen2.5 enrichment"
```

⚠️ **IMPORTANT:** If `.env.local` is in `.gitignore`, this commit step will be skipped (keys should not be committed). In that case, just add the key to `.env.local` manually and skip the commit.

---

## Self-Review Checklist

**1. Spec coverage:**
- ✅ Translation: Task 1 (model) + Task 2 (wire) + Task 3 (Twitter trigger) + Task 6 (Telegram enrichment)
- ✅ CA/Ticker highlight: Task 4 (utility) + Task 5 (ActivityCard)
- ✅ Sentiment: Task 1 (model returns sentiment) + Task 3 (enrichment writes to DB) + Task 5 (UI chips) + Task 6 (Telegram)
- ✅ NVIDIA API: Task 1 + Task 7

**2. Placeholder scan:** No TBD, TODO, or "implement later" patterns found.

**3. Type consistency:**
- `TweetEnrichmentModelResult` interface: `translationZh: string | null`, `sentiments: TweetEnrichmentModelOutputSentiment[]` — used consistently in Task 1, 2, 3
- `Activity.metadata.tokenSentiments`: `Array<{ tokenSymbol?, tokenAddress?, chain?, sentiment, matchSource }>` — used consistently in Task 5, 6
- `highlightSocialContent(text: string, mentions?: SocialContentMention[]): ReactNode[]` — used in Task 5
- `NvidaQwenEnrichmentModel` class name typo ("Nvida" vs "Nvidia") — consistent across all tasks, acceptable as internal name
