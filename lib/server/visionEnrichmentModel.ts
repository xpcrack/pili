import 'server-only';

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { isStableOrNativeSymbol } from '@/lib/assetSymbols';
import { type ExtractedTweetTokenMention } from '@/lib/twitter/extractTweetTokenMentions';
import { getPrimaryPoolSymbolAllowlist } from '@/lib/server/primaryPoolSymbols';

const execFileAsync = promisify(execFile);
const OCR_SCRIPT = path.resolve(process.cwd(), 'scripts/macos-vision-ocr.swift');

type OcrOutput = { texts?: unknown };

export interface VisionEnrichmentModel {
  extractMentionsFromImageUrl(url: string): Promise<ExtractedTweetTokenMention[]>;
}

function normalizeOcrText(value: string) {
  return value
    .trim()
    .replace(/^[$#]+/, '')
    .replace(/[​-‍﻿]/g, '')
    .toLowerCase();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasAsciiSymbol(text: string, symbol: string) {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(symbol.toLowerCase())}([^a-z0-9]|$)`, 'i').test(text);
}

function editDistanceAtMostOne(a: string, b: string) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function likelyTokenSymbol(symbol: string) {
  if (!symbol || isStableOrNativeSymbol(symbol)) return false;
  if (/^[a-z0-9]+$/i.test(symbol)) return symbol.length >= 4;
  if (/^[一-鿿]+$/.test(symbol)) return symbol.length >= 2;
  return symbol.length >= 2;
}

function isNearPairSlash(text: string, index: number, length: number) {
  const before = text.slice(Math.max(0, index - 2), index);
  const after = text.slice(index + length, index + length + 2);
  return before.includes('/') || after.includes('/');
}

function mentionSymbolFromPoolKey(symbol: string) {
  return /^[a-z0-9]+$/i.test(symbol) ? symbol.toUpperCase() : symbol;
}

export function extractPoolMentionsFromOcrTexts(
  texts: string[],
  poolSymbols: Iterable<string> = getPrimaryPoolSymbolAllowlist()
): ExtractedTweetTokenMention[] {
  const symbols = Array.from(poolSymbols).filter(likelyTokenSymbol);
  if (symbols.length === 0 || texts.length === 0) return [];

  const normalizedTexts = texts.map(normalizeOcrText).filter(Boolean);
  const found = new Set<string>();

  for (const symbol of symbols) {
    const s = normalizeOcrText(symbol);
    if (!s) continue;

    for (const text of normalizedTexts) {
      const exact = /^[a-z0-9]+$/i.test(s) ? hasAsciiSymbol(text, s) : text.includes(s);
      if (exact) {
        found.add(symbol);
        break;
      }

      // Vision often confuses one CJK glyph in tiny chart headers: 币有 → 市有.
      if (/^[一-鿿]{2,8}$/.test(s)) {
        const hanRuns = text.match(/[一-鿿]{2,8}/g) || [];
        if (hanRuns.some((run) => {
          const index = text.indexOf(run);
          return index >= 0 && isNearPairSlash(text, index, run.length) && editDistanceAtMostOne(run, s);
        })) {
          found.add(symbol);
          break;
        }
      }
    }
  }

  return Array.from(found).map((tokenSymbol, index) => ({
    tokenAddress: null,
    tokenSymbol: mentionSymbolFromPoolKey(tokenSymbol),
    matchSource: 'ticker',
    rankInTweet: index + 1,
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
