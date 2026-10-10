import 'server-only';

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { extractCaCandidatesFromText, type ExtractedTweetTokenMention } from '@/lib/twitter/extractTweetTokenMentions';
import { getPrimaryPoolSymbolAllowlist } from '@/lib/server/primaryPoolSymbols';

const execFileAsync = promisify(execFile);
const OCR_SCRIPT = path.resolve(process.cwd(), 'scripts/macos-vision-ocr.swift');

type OcrOutput = { texts?: unknown };

export interface VisionEnrichmentModel {
  extractMentionsFromImageUrl(url: string): Promise<ExtractedTweetTokenMention[]>;
}








export function extractPoolMentionsFromOcrTexts(
  texts: string[],
  _poolSymbols: Iterable<string> = getPrimaryPoolSymbolAllowlist()
): ExtractedTweetTokenMention[] {
  // 统一口径（2026-10-10）：OCR 只收明确 CA（EVM/Solana 地址）。
  // 旧的「OCR 文本撞一级池 ticker 字典」通道废除——图里出现 ROBINHOOD/SOL 等
  // 通用词会错绑到池内同名 meme。symbol 由下游 inferChainAndTickerForAddress 回填。
  if (texts.length === 0) return [];

  const found = new Map<string, number>();
  let rank = 0;
  for (const text of texts) {
    if (!text) continue;
    for (const ca of extractCaCandidatesFromText(text)) {
      const key = ca.tokenAddress.toLowerCase();
      if (found.has(key)) continue;
      rank += 1;
      found.set(key, rank);
    }
  }

  return Array.from(found.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([tokenAddress, rank]) => ({
      tokenAddress,
      tokenSymbol: null,
      matchSource: 'ca' as const,
      rankInTweet: rank,
    }));
}

async function downloadImage(url: string, filePath: string) {
  const response = await fetch(url, {
    headers: { Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return false;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('image') && !contentType.includes('octet-stream')) return false;
  await writeFile(filePath, Buffer.from(await response.arrayBuffer()));
  return true;
}

class MacosVisionEnrichmentModel implements VisionEnrichmentModel {
  async extractMentionsFromImageUrl(url: string): Promise<ExtractedTweetTokenMention[]> {
    if (process.platform !== 'darwin') return [];

    const dir = await mkdtemp(path.join(os.tmpdir(), 'pili-vision-'));
    try {
      const imagePath = path.join(dir, 'image');
      if (!await downloadImage(url, imagePath)) return [];

      const { stdout } = await execFileAsync('swift', [OCR_SCRIPT, imagePath], {
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      });
      const parsed = JSON.parse(stdout) as OcrOutput;
      const texts = Array.isArray(parsed.texts)
        ? parsed.texts.filter((v): v is string => typeof v === 'string')
        : [];
      return extractPoolMentionsFromOcrTexts(texts);
    } catch (err) {
      console.warn('[vision] macOS Vision failed:', err instanceof Error ? err.message : err);
      return [];
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

class NoopVisionEnrichmentModel implements VisionEnrichmentModel {
  async extractMentionsFromImageUrl(): Promise<ExtractedTweetTokenMention[]> {
    return [];
  }
}

export function getDefaultVisionEnrichmentModel(): VisionEnrichmentModel {
  if (process.platform !== 'darwin') return new NoopVisionEnrichmentModel();
  return new MacosVisionEnrichmentModel();
}

export async function extractMentionsFromImageUrls(
  urls: string[],
  model?: VisionEnrichmentModel
): Promise<ExtractedTweetTokenMention[]> {
  if (urls.length === 0) return [];
  const vision = model || getDefaultVisionEnrichmentModel();
  const collected: ExtractedTweetTokenMention[] = [];
  // Sequential to keep Twitter/media fetches modest; max 4 urls upstream.
  for (const url of urls) {
    const mentions = await vision.extractMentionsFromImageUrl(url);
    collected.push(...mentions);
  }
  return collected;
}
