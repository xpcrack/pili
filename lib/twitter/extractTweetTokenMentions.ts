export interface ExtractedTweetTokenMention {
  tokenAddress: string | null;
  tokenSymbol: string | null;
  matchSource: 'ticker' | 'ca' | 'both';
  rankInTweet: number;
}

const EVM_CA_PATTERN = /\b0x[a-fA-F0-9]{40}\b/g;
const SOL_CA_PATTERN = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const SOL_CA_EXACT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Legacy ASCII $TICKER (2–15 chars). Stops before non-ASCII so `$Sundog带头` → Sundog only. */
const DOLLAR_ASCII_PATTERN = /\$([A-Za-z][A-Za-z0-9]{1,14})(?![A-Za-z0-9])/g;

/** Chinese (CJK) $ticker — pure Han, 2–20 chars. */
const DOLLAR_CJK_PATTERN = /\$([一-鿿]{2,20})/g;

/** ASCII #tag (2–20 chars). */
const HASH_ASCII_PATTERN = /#([A-Za-z][A-Za-z0-9_]{1,19})(?![A-Za-z0-9_])/g;

/** Chinese (CJK) #tag — pure Han, 2–20 chars (e.g. #熊猫头). */
const HASH_CJK_PATTERN = /#([一-鿿]{2,20})/g;

function normalizeText(text: string) {
  return text || '';
}

/** ASCII tickers stay UPPERCASE (legacy); CJK kept as-is. */
function normalizeTickerSymbol(raw: string): string {
  const s = (raw || '').trim();
  if (!s) return '';
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(s)) {
    return s.toUpperCase();
  }
  return s;
}

function isLikelySolAddress(value: string) {
  if (value.length < 32 || value.length > 44) {
    return false;
  }
  return SOL_CA_EXACT_PATTERN.test(value);
}

function findCaCandidates(text: string) {
  const seen = new Set<string>();
  const result: Array<{ tokenAddress: string; index: number }> = [];

  for (const match of text.matchAll(EVM_CA_PATTERN)) {
    const tokenAddress = match[0];
    if (!tokenAddress || seen.has(tokenAddress)) {
      continue;
    }
    seen.add(tokenAddress);
    result.push({ tokenAddress, index: match.index ?? 0 });
  }

  for (const match of text.matchAll(SOL_CA_PATTERN)) {
    const tokenAddress = match[0];
    if (!tokenAddress || seen.has(tokenAddress) || !isLikelySolAddress(tokenAddress)) {
      continue;
    }
    seen.add(tokenAddress);
    result.push({ tokenAddress, index: match.index ?? 0 });
  }

  return result.sort((a, b) => a.index - b.index);
}

function findTickerCandidates(text: string) {
  const result: Array<{ tokenSymbol: string; index: number }> = [];
  const seenAt = new Set<string>();

  const push = (raw: string, index: number) => {
    const tokenSymbol = normalizeTickerSymbol(raw);
    if (!tokenSymbol) return;
    const key = `${tokenSymbol.toLowerCase()}@${index}`;
    if (seenAt.has(key)) return;
    seenAt.add(key);
    result.push({ tokenSymbol, index });
  };

  for (const match of text.matchAll(DOLLAR_ASCII_PATTERN)) {
    push(match[1] || '', match.index ?? 0);
  }
  for (const match of text.matchAll(DOLLAR_CJK_PATTERN)) {
    push(match[1] || '', match.index ?? 0);
  }
  for (const match of text.matchAll(HASH_ASCII_PATTERN)) {
    push(match[1] || '', match.index ?? 0);
  }
  for (const match of text.matchAll(HASH_CJK_PATTERN)) {
    push(match[1] || '', match.index ?? 0);
  }

  return result.sort((a, b) => a.index - b.index);
}

export function extractTweetTokenMentions(text: string): ExtractedTweetTokenMention[] {
  const normalized = normalizeText(text);
  const results: ExtractedTweetTokenMention[] = [];
  const bySymbol = new Map<string, ExtractedTweetTokenMention>();
  const tickerMatches = findTickerCandidates(normalized).map((match) => ({
    type: 'ticker' as const,
    index: match.index,
    tokenSymbol: match.tokenSymbol,
  }));
  const caMatches = findCaCandidates(normalized).map((match) => ({
    type: 'ca' as const,
    index: match.index,
    tokenAddress: match.tokenAddress,
  }));
  const orderedMatches = [...tickerMatches, ...caMatches].sort((a, b) => a.index - b.index);
  let rank = 0;

  for (const match of orderedMatches) {
    if (match.type === 'ticker') {
      const symbolKey = match.tokenSymbol.toLowerCase();
      if (bySymbol.has(symbolKey)) {
        continue;
      }
      rank += 1;
      const mention: ExtractedTweetTokenMention = {
        tokenAddress: null,
        tokenSymbol: match.tokenSymbol,
        matchSource: 'ticker',
        rankInTweet: rank,
      };
      bySymbol.set(symbolKey, mention);
      results.push(mention);
      continue;
    }

    rank += 1;
    const latest = results[results.length - 1];
    if (latest && latest.tokenAddress === null) {
      latest.tokenAddress = match.tokenAddress;
      latest.matchSource = latest.tokenSymbol ? 'both' : 'ca';
      continue;
    }

    results.push({
      tokenAddress: match.tokenAddress,
      tokenSymbol: null,
      matchSource: 'ca',
      rankInTweet: rank,
    });
  }

  return results;
}
