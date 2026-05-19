import 'server-only';

import type {
  TweetEnrichmentModel,
  TweetEnrichmentModelInputMention,
  TweetEnrichmentModelOutputSentiment,
  TweetEnrichmentModelResult,
} from '@/lib/server/twitterEnrichmentModel';

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_MODEL = 'qwen/qwen2.5-7b-instruct';

/**
 * Heuristic: is the text likely English (or Latin-script dominant)?
 * Returns true when the text has enough Latin words and fewer CJK characters.
 */
export function isLikelyEnglish(text: string): boolean {
  const latinWords = text.match(/\b[a-zA-Z]{2,}\b/g);
  const latinCount = latinWords ? latinWords.length : 0;

  // Count CJK characters (Chinese, Japanese Kanji, Korean Hanja)
  const cjkChars = text.match(/[一-鿿㐀-䶿　-〿]/g);
  const cjkCount = cjkChars ? cjkChars.length : 0;

  return latinCount >= 2 && latinCount > cjkCount;
}

/**
 * Build a Chinese prompt that asks the model to:
 * 1) translate English to Chinese (preserving $TICKER and CA addresses)
 * 2) judge sentiment for each mentioned token
 * Output format: JSON {"translation_zh":"...","sentiments":[...]}
 */
export function buildEnrichmentPrompt(
  text: string,
  mentions: TweetEnrichmentModelInputMention[],
): string {
  const tokenList = mentions
    .map((m, i) => {
      const parts: string[] = [`#${i + 1}`];
      if (m.tokenSymbol) parts.push(`symbol=${m.tokenSymbol}`);
      if (m.tokenAddress) parts.push(`address=${m.tokenAddress}`);
      return parts.join(' ');
    })
    .join('\n');

  return `你是一个加密货币推文分析助手。请完成以下两个任务：

1. **翻译**：将以下英文推文翻译为中文。保留所有 $TICKER 格式（如 $BTC、$ETH）和合约地址（CA）不翻译。
2. **情感分析**：对每个提到的代币判断情感倾向（positive/negative/neutral）。

推文原文：
"""
${text}
"""

提到的代币：
${tokenList || '（无明确代币）'}

请严格按以下 JSON 格式输出，不要输出任何其他内容：
{"translation_zh":"中文翻译","sentiments":[{"tokenSymbol":"BTC","sentiment":"positive","confidence":0.9}]}

sentiment 只能是 positive、negative 或 neutral。confidence 范围 0-1。如果无法判断某个代币的情感，设为 neutral，confidence 设为 0.5。`;
}

/**
 * Extract JSON from the model response, handling markdown code fences.
 */
export function parseModelOutput(raw: string): {
  translation_zh: string | null;
  sentiments: Array<{
    tokenSymbol?: string;
    tokenAddress?: string;
    sentiment: string;
    confidence?: number;
  }>;
} | null {
  // Try to extract JSON from markdown fences first
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : raw.trim();

  try {
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed === 'object' && parsed !== null) {
      return {
        translation_zh: typeof parsed.translation_zh === 'string' ? parsed.translation_zh : null,
        sentiments: Array.isArray(parsed.sentiments) ? parsed.sentiments : [],
      };
    }
  } catch {
    // Try to find any JSON object in the string
    const braceMatch = raw.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        const parsed = JSON.parse(braceMatch[0]);
        return {
          translation_zh: typeof parsed.translation_zh === 'string' ? parsed.translation_zh : null,
          sentiments: Array.isArray(parsed.sentiments) ? parsed.sentiments : [],
        };
      } catch {
        return null;
      }
    }
  }
  return null;
}

const VALID_SENTIMENTS = new Set(['positive', 'negative', 'neutral']);

export class NvidaQwenEnrichmentModel implements TweetEnrichmentModel {
  private apiKey: string;

  constructor({ apiKey }: { apiKey: string }) {
    this.apiKey = apiKey;
  }

  async enrichTweet(input: {
    tweetId: string;
    text: string;
    mentions: TweetEnrichmentModelInputMention[];
  }): Promise<TweetEnrichmentModelResult> {
    const { text, mentions } = input;

    // Skip non-English content
    if (!isLikelyEnglish(text)) {
      return {
        translationZh: null,
        sentiments: mentions.map((m) => ({
          tokenSymbol: m.tokenSymbol || undefined,
          tokenAddress: m.tokenAddress || undefined,
          sentiment: 'neutral' as const,
          confidence: 0.5,
        })),
      };
    }

    // No mentions — no need to call model for sentiments, but still translate
    const prompt = buildEnrichmentPrompt(text, mentions);

    try {
      const response = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
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
        console.error(
          `[NvidaQwenEnrichmentModel] API error: ${response.status} ${response.statusText}`,
        );
        return this.fallbackResult(mentions);
      }

      const data = await response.json();
      const content: string | undefined = data?.choices?.[0]?.message?.content;
      if (!content) {
        console.error('[NvidaQwenEnrichmentModel] No content in response');
        return this.fallbackResult(mentions);
      }

      const parsed = parseModelOutput(content);
      if (!parsed) {
        console.error('[NvidaQwenEnrichmentModel] Failed to parse model output:', content.slice(0, 200));
        return this.fallbackResult(mentions);
      }

      // Filter sentiments to only valid values
      const validSentiments: TweetEnrichmentModelOutputSentiment[] = parsed.sentiments
        .filter((s) => VALID_SENTIMENTS.has(s.sentiment))
        .map((s) => ({
          tokenSymbol: s.tokenSymbol,
          tokenAddress: s.tokenAddress,
          sentiment: s.sentiment as 'positive' | 'negative' | 'neutral',
          confidence: typeof s.confidence === 'number' ? s.confidence : undefined,
        }));

      return {
        translationZh: parsed.translation_zh,
        sentiments:
          validSentiments.length > 0
            ? validSentiments
            : mentions.map((m) => ({
                tokenSymbol: m.tokenSymbol || undefined,
                tokenAddress: m.tokenAddress || undefined,
                sentiment: 'neutral' as const,
                confidence: 0.5,
              })),
      };
    } catch (err) {
      console.error('[NvidaQwenEnrichmentModel] Network/error:', err);
      return this.fallbackResult(mentions);
    }
  }

  private fallbackResult(
    mentions: TweetEnrichmentModelInputMention[],
  ): TweetEnrichmentModelResult {
    return {
      translationZh: null,
      sentiments: mentions.map((m) => ({
        tokenSymbol: m.tokenSymbol || undefined,
        tokenAddress: m.tokenAddress || undefined,
        sentiment: 'neutral' as const,
        confidence: 0.5,
      })),
    };
  }
}
