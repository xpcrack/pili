import 'server-only';

import type {
  TweetEnrichmentModel,
  TweetEnrichmentModelInputMention,
  TweetEnrichmentModelOutputSentiment,
  TweetEnrichmentModelResult,
  TweetEnrichmentAliasCandidate,
  TweetEnrichmentAliasConfirmation,
} from '@/lib/server/twitterEnrichmentModel';
import type { TweetMentionSentiment } from '@/lib/server/twitterEnrichmentRepo';
import { listPreserveTickerSymbols } from '@/lib/twitter/extractTweetTokenMentions';
import {
  getPrimaryPoolOfficialTwitterMap,
  getPrimaryPoolSymbolAllowlist,
} from '@/lib/server/primaryPoolSymbols';

/** OpenAI-compatible chat base. Prefer local AxonHub relay over NVIDIA NIM. */
export const DEFAULT_ENRICHMENT_BASE_URL = 'http://127.0.0.1:8090/v1';
export const DEFAULT_ENRICHMENT_MODEL = 'haiku';
/** @deprecated use DEFAULT_ENRICHMENT_MODEL */
export const DEFAULT_NVIDIA_ENRICHMENT_MODEL = DEFAULT_ENRICHMENT_MODEL;

export function resolveEnrichmentBaseUrl() {
  return (
    (process.env.ENRICHMENT_LLM_BASE_URL || '').trim() ||
    (process.env.AXONHUB_BASE_URL || '').trim() ||
    (process.env.NVIDIA_BASE_URL || '').trim() ||
    DEFAULT_ENRICHMENT_BASE_URL
  ).replace(/\/+$/, '');
}

export function resolveEnrichmentApiKey() {
  return (
    (process.env.ENRICHMENT_LLM_API_KEY || '').trim() ||
    (process.env.AXONHUB_API_KEY || '').trim() ||
    (process.env.NVIDIA_API_KEY || '').trim()
  );
}

export function resolveNvidiaEnrichmentModel() {
  return (
    (process.env.ENRICHMENT_LLM_MODEL || '').trim() ||
    (process.env.AXONHUB_MODEL || '').trim() ||
    (process.env.NVIDIA_MODEL || '').trim() ||
    DEFAULT_ENRICHMENT_MODEL
  );
}

export function resolveEnrichmentModel() {
  return resolveNvidiaEnrichmentModel();
}

/**
 * Wall-clock budget for one enrichment request, covering the whole call
 * including body read. The local AxonHub relay has a long tail, so a hard abort
 * that is never recorded as an error leaves the tweet re-queued forever. Keep
 * these overridable so a slow relay can be tuned without a code change.
 */
export function resolveEnrichmentTimeoutMs(
  kind: 'enrichTweet' | 'translateOnly' | 'confirmAlias',
): number {
  const envKey =
    kind === 'enrichTweet'
      ? 'ENRICHMENT_LLM_TIMEOUT_MS'
      : kind === 'translateOnly'
        ? 'ENRICHMENT_LLM_TIMEOUT_MS_TRANSLATE'
        : 'ENRICHMENT_LLM_TIMEOUT_MS_ALIAS';
  const fallback = kind === 'enrichTweet' ? 60_000 : kind === 'translateOnly' ? 45_000 : 30_000;
  const raw = Number((process.env[envKey] || '').trim());
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * A fetch abort and a timeout both surface as a bare AbortError. Label them so
 * downstream backoff logic can tell "the relay was too slow" apart from
 * "the relay refused".
 */
function describeRequestFailure(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && err.name === 'AbortError') {
    return `aborted after ${timeoutMs}ms (request timeout)`;
  }
  return err instanceof Error ? err.message : String(err);
}

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

function sanitizeTranslationZh(value: string | null | undefined): string | null {
  const text = (value || '').trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (
    text === '中文翻译' ||
    text === '翻译' ||
    text === '...' ||
    text === '…' ||
    text === '<这里写完整中文译文>' ||
    lower === 'todo' ||
    lower === 'n/a' ||
    lower === 'null' ||
    text.startsWith('首先，') ||
    text.startsWith('用户要求')
  ) {
    return null;
  }
  return text;
}

/**
 * Mask ticker symbols / CAs so the LLM cannot transliterate them (Jimothy→吉米).
 * Longer symbols first to avoid partial overlaps.
 */
export function maskPreserveTokens(
  text: string,
  symbols: string[],
): { masked: string; tokens: string[] } {
  const tokens: string[] = [];
  let masked = text;

  const unique = Array.from(
    new Set(
      symbols
        .map((s) => (s || '').trim())
        .filter((s) => s.length >= 2)
    )
  ).sort((a, b) => b.length - a.length);

  for (const symbol of unique) {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // ASCII word boundary; CJK matched as literal substring.
    const isAscii = /^[A-Za-z][A-Za-z0-9_]*$/.test(symbol);
    const pattern = isAscii
      ? new RegExp(`\\b${escaped}\\b`, 'gi')
      : new RegExp(escaped, 'g');
    if (!pattern.test(masked)) continue;
    // reset lastIndex after test()
    pattern.lastIndex = 0;
    const idx = tokens.length;
    const placeholder = `⟦TK${idx}⟧`;
    masked = masked.replace(pattern, () => {
      // Always restore the canonical symbol casing from the list entry.
      tokens[idx] = symbol;
      return placeholder;
    });
    if (tokens[idx] === undefined) {
      tokens[idx] = symbol;
    }
  }

  // Also mask naked EVM/SOL CAs that may not be in symbol list.
  masked = masked.replace(/\b0x[a-fA-F0-9]{40}\b/g, (ca) => {
    const idx = tokens.length;
    tokens.push(ca);
    return `⟦TK${idx}⟧`;
  });

  return { masked, tokens };
}

export function unmaskPreserveTokens(text: string, tokens: string[]): string {
  if (!text || tokens.length === 0) return text;
  return text.replace(/⟦TK(\d+)⟧/g, (full, rawIdx: string) => {
    const idx = Number.parseInt(rawIdx, 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= tokens.length) return full;
    return tokens[idx];
  });
}

/**
 * Build a Chinese prompt that asks the model to:
 * 1) translate English to Chinese (preserving $TICKER, bare tickers, and CA addresses)
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

1. **翻译**：将以下英文推文翻译为中文。
   - 保留所有 $TICKER / #TAG、合约地址（CA）、以及代币专有名（如 Jimothy、Pepe）的**原文拉丁拼写**，禁止音译成中文人名/昵称（错误示例：Jimothy→吉米）。
   - 文中形如 ⟦TK0⟧ / ⟦TK1⟧ 的占位符必须原样保留，不得翻译或删除。
   - 翻译必须是完整中文句子，不要输出占位词。
2. **情感分析**：对每个提到的代币判断情感倾向（positive/negative/neutral）。

推文原文：
"""
${text}
"""

提到的代币：
${tokenList || '（无明确代币）'}

请严格按以下 JSON 格式输出，不要输出任何其他内容：
{"translation_zh":"<这里写完整中文译文>","sentiments":[{"tokenSymbol":"BTC","sentiment":"positive","confidence":0.9}]}

规则：
- sentiment 只能是 positive、negative 或 neutral
- confidence 范围 0-1；不确定时用 neutral + 0.5
- translation_zh 必须是真实译文，禁止输出「中文翻译」「翻译」「TODO」等占位词
- 代币名/⟦TKn⟧/CA 保持原样，不要本地化
- 不要在 translation_zh 里使用未转义的换行；如需换行请使用 \\n`;
}

/**
 * Extract JSON from the model response, handling markdown code fences.
 */
function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Models often emit raw newlines inside string values → invalid JSON.
    // Soft-repair: escape control chars that appear between quotes loosely.
    try {
      const repaired = text.replace(
        /"translation_zh"\s*:\s*"([\s\S]*?)"\s*(,|\})/,
        (_full, body: string, tail: string) => {
          const escaped = body
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\r/g, '\\r')
            .replace(/\n/g, '\\n')
            .replace(/\t/g, '\\t');
          return `"translation_zh":"${escaped}"${tail}`;
        }
      );
      const parsed = JSON.parse(repaired);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function extractTranslationByRegex(raw: string): string | null {
  const match = raw.match(/"translation_zh"\s*:\s*"([\s\S]*?)"\s*(,|\})/);
  if (!match) return null;
  return match[1]
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .trim() || null;
}

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
  const candidates = [
    fenceMatch ? fenceMatch[1].trim() : '',
    raw.trim(),
    (raw.match(/\{[\s\S]*\}/) || [])[0] || '',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const parsed = tryParseJsonObject(candidate);
    if (parsed) {
      return {
        translation_zh: sanitizeTranslationZh(
          typeof parsed.translation_zh === 'string'
            ? parsed.translation_zh
            : extractTranslationByRegex(candidate)
        ),
        sentiments: Array.isArray(parsed.sentiments)
          ? (parsed.sentiments as Array<{
              tokenSymbol?: string;
              tokenAddress?: string;
              sentiment: string;
              confidence?: number;
            }>)
          : [],
      };
    }
  }

  // Last resort: pull translation_zh even when full JSON is unparseable
  const translationOnly = sanitizeTranslationZh(extractTranslationByRegex(raw));
  if (translationOnly) {
    return { translation_zh: translationOnly, sentiments: [] };
  }
  return null;
}

const VALID_SENTIMENTS = new Set(['positive', 'negative', 'neutral']);

/** Build the alias-resolution prompt. Chinese-capable; no English gate. */
function buildAliasConfirmPrompt(text: string, candidates: TweetEnrichmentAliasCandidate[]): string {
  const lines = candidates.map((c, i) => {
    const parts = [`$${c.symbol}`];
    if (c.name) parts.push(`项目名/全名: "${c.name}"`);
    parts.push(`命中词: "${c.matchedAlias}"`);
    if (c.chain) parts.push(`链: ${c.chain}`);
    parts.push(`合约: ${c.address}`);
    return `${i + 1}. ${parts.join('；')}`;
  });
  return [
    '下面是一条推文（可能是中文或英文）：',
    '"""',
    text,
    '"""',
    '',
    '针对下面每个"候选代币"，判断这条推文是否真的在谈【这个代币本身】（讨论/交易/推荐/点评该加密货币），',
    '而不是把该词当成普通含义使用（例如 "Z世代/gen z" 指人群、"pepe" 指表情包 meme 而非币等）。',
    '只有推文确实把该词当作一个加密货币来谈论时才确认；如果只是顺带提及人群、泛指、或与该币无关，不要确认。',
    '',
    '候选代币：',
    lines.join('\n'),
    '',
    '只回复一个 JSON，不要任何解释或 markdown：',
    '{"confirmed":[{"address":"<合约地址>","sentiment":"positive|negative|neutral"}]}',
    '没有命中任何代币时返回 {"confirmed":[]}。',
  ].join('\n');
}

export function parseAliasConfirmOutput(raw: string): TweetEnrichmentAliasConfirmation[] {
  const text = (raw || '').trim();
  if (!text) return [];
  const tryParse = (s: string): { confirmed?: unknown } | null => {
    try {
      return JSON.parse(s) as { confirmed?: unknown };
    } catch {
      return null;
    }
  };
  let obj = tryParse(text);
  if (!obj) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) obj = tryParse(m[0]);
  }
  if (!obj || !Array.isArray(obj.confirmed)) return [];
  const out: TweetEnrichmentAliasConfirmation[] = [];
  for (const item of obj.confirmed) {
    if (!item || typeof item !== 'object') continue;
    const address = String((item as { address?: unknown }).address || '').trim().toLowerCase();
    const sentiment = String((item as { sentiment?: unknown }).sentiment || '').trim().toLowerCase();
    if (!address || !VALID_SENTIMENTS.has(sentiment)) continue;
    out.push({ address, sentiment: sentiment as TweetMentionSentiment });
  }
  return out;
}

export class NvidaQwenEnrichmentModel implements TweetEnrichmentModel {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private lastFailureReason: string | null = null;

  constructor({
    apiKey,
    model,
    baseUrl,
  }: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  }) {
    this.apiKey = apiKey;
    this.model = (model || '').trim() || resolveEnrichmentModel();
    this.baseUrl = ((baseUrl || '').trim() || resolveEnrichmentBaseUrl()).replace(/\/+$/, '');
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

    const preserveSymbols = listPreserveTickerSymbols(
      text,
      mentions.map((m) => m.tokenSymbol),
      {
        bareSymbolAllowlist: getPrimaryPoolSymbolAllowlist(),
        officialTwitterByHandle: getPrimaryPoolOfficialTwitterMap(),
      },
    );
    const { masked, tokens } = maskPreserveTokens(text, preserveSymbols);
    const prompt = buildEnrichmentPrompt(masked, mentions);

    // Resolved before the try block: it is needed in the catch to label the
    // abort, and a const declared inside try is not visible from catch.
    const timeoutMs = resolveEnrichmentTimeoutMs('enrichTweet');
    try {
      const controller = new AbortController();
      // MIMO reasoning models can be slower than plain instruct
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'system',
              content:
                'You are a JSON API. Reply with a single JSON object only. No markdown, no reasoning, no preface. Keep ⟦TKn⟧ placeholders unchanged.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 4096,
        }),
        signal: controller.signal,
      });

      try {
        if (!response.ok) {
          const errBody = await response.text().catch(() => '');
          const reason = `API error ${response.status} ${response.statusText}: ${errBody.slice(0, 200)}`;
          console.error(
            `[enrichment-model] ${reason} model=${this.model} base=${this.baseUrl} tweet=${input.tweetId}`,
          );
          return { ...this.fallbackResult(mentions), error: reason };
        }

        const data = await response.json();
        const message = data?.choices?.[0]?.message;
        const content: string =
          (typeof message?.content === 'string' && message.content) ||
          (typeof message?.reasoning_content === 'string' && message.reasoning_content) ||
          '';
        if (!content) {
          console.error('[enrichment-model] No content in response');
          return { ...this.fallbackResult(mentions), error: 'empty content in response' };
        }

        const parsed = parseModelOutput(content);
        if (!parsed) {
          console.error('[enrichment-model] Failed to parse model output:', content.slice(0, 200));
          return { ...this.fallbackResult(mentions), error: 'unparseable model output' };
        }

        const validSentiments: TweetEnrichmentModelOutputSentiment[] = parsed.sentiments
          .filter((s) => VALID_SENTIMENTS.has(s.sentiment))
          .map((s) => ({
            tokenSymbol: s.tokenSymbol,
            tokenAddress: s.tokenAddress,
            sentiment: s.sentiment as 'positive' | 'negative' | 'neutral',
            confidence: typeof s.confidence === 'number' ? s.confidence : undefined,
          }));

        const translationZh = sanitizeTranslationZh(
          unmaskPreserveTokens(parsed.translation_zh || '', tokens)
        );

        return {
          translationZh,
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
      } finally {
        // Cleared only after the body is read: clearing on fetch() resolve left
        // the body-reading phase with no timeout at all.
        clearTimeout(timeoutId);
      }
    } catch (err) {
      const reason = describeRequestFailure(err, timeoutMs);
      console.error(`[enrichment-model] request failed tweet=${input.tweetId}: ${reason}`);
      // Surface the failure in the result: the caller persists it as last_error,
      // which is what arms the projector's re-queue backoff. Returning a silent
      // fallback here left timed-out tweets re-queued on every projection cycle.
      return { ...this.fallbackResult(mentions), error: reason };
    }
  }

  async confirmAliasReferences(input: {
    text: string;
    candidates: TweetEnrichmentAliasCandidate[];
  }): Promise<TweetEnrichmentAliasConfirmation[]> {
    const { text, candidates } = input;
    if (!text.trim() || candidates.length === 0) return [];
    const prompt = buildAliasConfirmPrompt(text, candidates);
    try {
      const controller = new AbortController();
      const timeoutMs = resolveEnrichmentTimeoutMs('confirmAlias');
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'system',
              content:
                'You are a JSON API. Reply with a single JSON object only. No markdown, no reasoning, no preface.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0,
          max_tokens: 1024,
        }),
        signal: controller.signal,
      });
      try {
        if (!response.ok) {
          const errBody = await response.text().catch(() => '');
          console.warn(
            `[enrichment-model] alias-confirm API error ${response.status}: ${errBody.slice(0, 200)}`,
          );
          return [];
        }
        const data = await response.json();
        const message = data?.choices?.[0]?.message;
        const content: string =
          (typeof message?.content === 'string' && message.content) ||
          (typeof message?.reasoning_content === 'string' && message.reasoning_content) ||
          '';
        if (!content) return [];
        return parseAliasConfirmOutput(content);
      } finally {
        // Cleared only after the body is read: clearing on fetch() resolve left
        // the body-reading phase with no timeout at all.
        clearTimeout(timeoutId);
      }
    } catch (err) {
      console.warn(
        '[enrichment-model] alias-confirm error:',
        describeRequestFailure(err, resolveEnrichmentTimeoutMs('confirmAlias')),
      );
      return [];
    }
  }

  async translateOnly(text: string): Promise<string | null> {
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (!isLikelyEnglish(trimmed)) return null;

    const preserveSymbols = listPreserveTickerSymbols(trimmed, [], {
      bareSymbolAllowlist: getPrimaryPoolSymbolAllowlist(),
      officialTwitterByHandle: getPrimaryPoolOfficialTwitterMap(),
    });
    const { masked, tokens } = maskPreserveTokens(trimmed, preserveSymbols);

    const prompt =
      'Translate the following English tweet/text to Chinese. ' +
      'Keep $TICKER, bare token names, contract addresses, and ⟦TKn⟧ placeholders unchanged — never transliterate tickers into Chinese names. ' +
      'Return ONLY JSON: {"translation_zh":"..."}\n\nText:\n' +
      masked;

    try {
      const controller = new AbortController();
      const timeoutMs = resolveEnrichmentTimeoutMs('translateOnly');
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'system',
              content: 'Output ONLY one JSON object. No markdown, no reasoning. Keep ⟦TKn⟧ placeholders unchanged.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 2048,
        }),
        signal: controller.signal,
      });
      try {
        if (!response.ok) return null;
        const data = await response.json();
        const message = data?.choices?.[0]?.message;
        const content: string =
          (typeof message?.content === 'string' && message.content) ||
          (typeof message?.reasoning_content === 'string' && message.reasoning_content) ||
          '';
        const parsed = parseModelOutput(content);
        const rawZh = sanitizeTranslationZh(parsed?.translation_zh || extractTranslationByRegex(content));
        return rawZh ? unmaskPreserveTokens(rawZh, tokens) : null;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      this.lastFailureReason = describeRequestFailure(err, resolveEnrichmentTimeoutMs('translateOnly'));
      console.warn('[enrichment-model] translateOnly failed:', this.lastFailureReason);
      return null;
    }
  }

  /**
   * Reason the most recent translateOnly call returned null (timeout vs empty
   * payload). translateOnly returns a bare string|null, so the failure detail
   * has to travel via the instance to reach the persisted last_error.
   */
  takeLastFailureReason(): string | null {
    const reason = this.lastFailureReason;
    this.lastFailureReason = null;
    return reason;
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
