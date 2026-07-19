import 'server-only';

import { extractTweetTokenMentions, type ExtractedTweetTokenMention } from '@/lib/twitter/extractTweetTokenMentions';

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const DEFAULT_NVIDIA_VISION_MODEL = 'meta/llama-3.2-90b-vision-instruct';

export function resolveNvidiaVisionModel() {
  return (process.env.NVIDIA_VISION_MODEL || '').trim() || DEFAULT_NVIDIA_VISION_MODEL;
}

function parseVisionOutput(raw: string): { tickers: string[]; addresses: string[] } {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : raw.trim();

  const tryParse = (text: string) => {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const tickers = Array.isArray(parsed.tickers)
        ? parsed.tickers.filter((v: unknown) => typeof v === 'string').map((v: string) => v.trim())
        : [];
      const addresses = Array.isArray(parsed.addresses)
        ? parsed.addresses.filter((v: unknown) => typeof v === 'string').map((v: string) => v.trim())
        : [];
      return { tickers, addresses };
    } catch {
      return null;
    }
  };

  const direct = tryParse(jsonStr);
  if (direct) return direct;

  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    const nested = tryParse(braceMatch[0]);
    if (nested) return nested;
  }

  return { tickers: [], addresses: [] };
}

function mentionsFromVisionResult(result: { tickers: string[]; addresses: string[] }): ExtractedTweetTokenMention[] {
  // Reuse text extractor by synthesizing a pseudo-text blob
  const pieces: string[] = [];
  for (const ticker of result.tickers) {
    const cleaned = ticker.replace(/^\$/, '').trim();
    if (cleaned) pieces.push(`$${cleaned}`);
  }
  for (const address of result.addresses) {
    if (address.trim()) pieces.push(address.trim());
  }
  if (pieces.length === 0) return [];
  return extractTweetTokenMentions(pieces.join(' '));
}

export interface VisionEnrichmentModel {
  extractMentionsFromImageUrl(url: string): Promise<ExtractedTweetTokenMention[]>;
}

class NvidiaVisionEnrichmentModel implements VisionEnrichmentModel {
  private apiKey: string;
  private model: string;

  constructor({ apiKey, model }: { apiKey: string; model?: string }) {
    this.apiKey = apiKey;
    this.model = (model || '').trim() || resolveNvidiaVisionModel();
  }

  async extractMentionsFromImageUrl(url: string): Promise<ExtractedTweetTokenMention[]> {
    const prompt =
      'You extract crypto token tickers and contract addresses from an image. ' +
      'Return ONLY JSON: {"tickers":["FOO"],"addresses":["0x... or Solana base58"]}. ' +
      'Tickers without $. Empty arrays if none. No extra text.';

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15_000);

      const response = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url } },
              ],
            },
          ],
          temperature: 0.1,
          max_tokens: 256,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`[vision] API error ${response.status} for ${url.slice(0, 80)}`);
        return [];
      }

      const data = await response.json();
      const content: string | undefined = data?.choices?.[0]?.message?.content;
      if (!content) return [];

      return mentionsFromVisionResult(parseVisionOutput(content));
    } catch (err) {
      console.warn(
        '[vision] extract failed:',
        err instanceof Error ? err.message : err
      );
      return [];
    }
  }
}

class NoopVisionEnrichmentModel implements VisionEnrichmentModel {
  async extractMentionsFromImageUrl(): Promise<ExtractedTweetTokenMention[]> {
    return [];
  }
}

export function getDefaultVisionEnrichmentModel(): VisionEnrichmentModel {
  const apiKey = (process.env.NVIDIA_API_KEY || '').trim();
  if (!apiKey) {
    return new NoopVisionEnrichmentModel();
  }
  return new NvidiaVisionEnrichmentModel({ apiKey });
}

export async function extractMentionsFromImageUrls(
  urls: string[],
  model?: VisionEnrichmentModel
): Promise<ExtractedTweetTokenMention[]> {
  if (urls.length === 0) return [];
  const vision = model || getDefaultVisionEnrichmentModel();
  const collected: ExtractedTweetTokenMention[] = [];
  // Sequential to keep rate modest; max 4 urls upstream
  for (const url of urls) {
    const mentions = await vision.extractMentionsFromImageUrl(url);
    collected.push(...mentions);
  }
  return collected;
}
