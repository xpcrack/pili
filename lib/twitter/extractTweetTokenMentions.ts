export interface ExtractedTweetTokenMention {
  tokenAddress: string | null;
  tokenSymbol: string | null;
  matchSource: 'ticker' | 'ca' | 'both';
  rankInTweet: number;
}

const EVM_CA_PATTERN = /\b0x[a-fA-F0-9]{40}\b/g;
const SOL_CA_PATTERN = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const SOL_CA_EXACT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TICKER_PATTERN = /\$([A-Za-z][A-Za-z0-9]{1,14})\b/g;

function normalizeText(text: string) {
  return text || '';
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

export function extractTweetTokenMentions(text: string): ExtractedTweetTokenMention[] {
  const normalized = normalizeText(text);
  const results: ExtractedTweetTokenMention[] = [];
  const bySymbol = new Map<string, ExtractedTweetTokenMention>();
  const tickerMatches = Array.from(normalized.matchAll(TICKER_PATTERN))
    .map((match) => ({
      type: 'ticker' as const,
      index: match.index ?? 0,
      tokenSymbol: (match[1] || '').toUpperCase(),
    }))
    .filter((match) => Boolean(match.tokenSymbol));
  const caMatches = findCaCandidates(normalized).map((match) => ({
    type: 'ca' as const,
    index: match.index,
    tokenAddress: match.tokenAddress,
  }));
  const orderedMatches = [...tickerMatches, ...caMatches].sort((a, b) => a.index - b.index);
  let rank = 0;

  for (const match of orderedMatches) {
    if (match.type === 'ticker') {
      if (bySymbol.has(match.tokenSymbol)) {
        continue;
      }
      rank += 1;
      const mention: ExtractedTweetTokenMention = {
        tokenAddress: null,
        tokenSymbol: match.tokenSymbol,
        matchSource: 'ticker',
        rankInTweet: rank,
      };
      bySymbol.set(match.tokenSymbol, mention);
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
