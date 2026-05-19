'use client';

import { type ReactNode } from 'react';

export interface SocialContentMention {
  tokenSymbol?: string | null | undefined;
  tokenAddress?: string | null | undefined;
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
