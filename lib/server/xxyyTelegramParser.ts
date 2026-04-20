import 'server-only';

export interface XxyyTelegramLinkInfo {
  url: string;
  chain: string | null;
  tokenAddress: string | null;
  trackedWalletAddress: string | null;
}

export interface ParseXxyyTelegramResult {
  chain: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  tokenAmount: number | null;
  txHash: string | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
  quoteAmount: number | null;
  quoteSymbol: string | null;
  action: 'buy' | 'sell' | 'send' | null;
  actionLabel: '建仓' | '加仓' | '减仓' | '清仓' | '发送' | null;
  actionVariant: 'open' | 'add' | 'reduce' | 'close' | 'send' | null;
  walletLabel: string | null;
  walletGroupLabel: string | null;
  walletAliasLabel: string | null;
  trackedWalletAddress: string | null;
  eventTimeMs: number | null;
}

function parseCompactUsd(value: string) {
  const cleaned = value.replace(/[$,\s]/g, '').trim().toUpperCase();
  if (!cleaned) return null;
  const suffix = cleaned.slice(-1);
  const multiplier = suffix === 'B' ? 1_000_000_000 : suffix === 'M' ? 1_000_000 : suffix === 'K' ? 1_000 : 1;
  const numberPart = multiplier === 1 ? cleaned : cleaned.slice(0, -1);
  const parsed = Number.parseFloat(numberPart);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed * multiplier;
}

function parsePriceLine(text: string) {
  const m = text.match(/Price\s*:\s*\$([^\n\r]+)/i);
  if (!m) return null;
  const raw = m[1].trim();
  const sci = raw.match(/^0\.0\{(\d+)\}(\d+)/);
  if (sci) {
    const zeros = Number.parseInt(sci[1], 10);
    const tail = sci[2];
    if (Number.isFinite(zeros) && zeros >= 0 && tail) {
      const normalized = `0.${'0'.repeat(zeros)}${tail}`;
      const parsed = Number.parseFloat(normalized);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }

  const parsed = Number.parseFloat(raw.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseChainFromText(text: string) {
  if (/\bBSC\b|Pancake|WBNB|Four\.meme/i.test(text)) return 'bsc';
  if (/\bETH\b|\bEthereum\b|Etherscan|Uniswap/i.test(text)) return 'ethereum';
  if (/\bSOL\b|Raydium|Pump|Jupiter|WSOL/i.test(text)) return 'solana';
  return null;
}

function parseHeaderLabels(text: string) {
  const groupAliasMatch = text.match(/^\s*\[([^\]\n\r]+)\]\s*\[([^\]\n\r]+)\]/m);
  if (groupAliasMatch) {
    const walletGroupLabel = groupAliasMatch[1]?.trim() || null;
    const walletAliasLabel = groupAliasMatch[2]?.trim() || null;

    return {
      walletGroupLabel,
      walletAliasLabel,
      walletLabel: walletAliasLabel || walletGroupLabel,
    };
  }

  const singleLabelMatch = text.match(/^\s*\[([^\]\n\r]+)\]/m);
  if (!singleLabelMatch) {
    return {
      walletGroupLabel: null,
      walletAliasLabel: null,
      walletLabel: null,
    };
  }

  const walletLabel = singleLabelMatch[1]?.trim() || null;
  return {
    walletGroupLabel: null,
    walletAliasLabel: walletLabel,
    walletLabel,
  };
}

function normalizeChain(value: string | null | undefined) {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'sol') return 'solana';
  if (normalized === 'eth') return 'ethereum';
  if (normalized === 'solana' || normalized === 'bsc' || normalized === 'ethereum') return normalized;
  return null;
}

function normalizeAddress(value: string | null | undefined) {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  return trimmed;
}

function extractValidTxHash(value: string | null | undefined) {
  const candidate = (value || '').trim();
  if (!candidate) {
    return null;
  }

  if (/^0x[a-fA-F0-9]{64}$/.test(candidate)) {
    return candidate;
  }

  if (/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(candidate)) {
    return candidate;
  }

  return null;
}

function parseTxHashFromUrl(rawUrl: string) {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const queryKeys = ['tx', 'txhash', 'txHash', 'hash', 'signature', 'sig'];
  for (const key of queryKeys) {
    const txFromQuery = extractValidTxHash(url.searchParams.get(key));
    if (txFromQuery) {
      return txFromQuery;
    }
  }

  const pathSegments = url.pathname.split('/').filter(Boolean);
  for (let index = 0; index < pathSegments.length; index += 1) {
    const segment = pathSegments[index];
    const normalizedSegment = segment.toLowerCase();
    if (normalizedSegment === 'tx' || normalizedSegment === 'transaction') {
      const nextSegment = pathSegments[index + 1];
      const txFromPath = extractValidTxHash(nextSegment);
      if (txFromPath) {
        return txFromPath;
      }
    }
  }

  return null;
}

function parseTxHashFromLinks(linkCandidates: string[]) {
  for (const link of linkCandidates) {
    const txHash = parseTxHashFromUrl(link);
    if (txHash) {
      return txHash;
    }
  }
  return null;
}

export function parseXxyyLink(rawUrl: string): XxyyTelegramLinkInfo | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (!/xxyy\.io$/i.test(url.hostname)) {
    return null;
  }

  const pathParts = url.pathname.split('/').filter(Boolean);
  const pathChain = normalizeChain(pathParts[0] || null);
  const pathTokenAddress = normalizeAddress(pathParts[1] || null);
  const trackedWalletAddress = normalizeAddress(url.searchParams.get('wallet'));

  return {
    url: url.toString(),
    chain: pathChain,
    tokenAddress: pathTokenAddress,
    trackedWalletAddress,
  };
}

export function parseXxyyTelegramText(
  rawText: string,
  fallbackTimestampMs?: number,
  linkCandidates: string[] = []
): ParseXxyyTelegramResult {
  const text = rawText || '';
  const txHashFromLinks = parseTxHashFromLinks(linkCandidates);
  const parsedLinks = linkCandidates
    .map((item) => parseXxyyLink(item))
    .filter((item): item is XxyyTelegramLinkInfo => Boolean(item));
  const primaryLink = parsedLinks[0] || null;

  const caMatch = text.match(/\bCA\s*:\s*(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})/i);
  const txMatch = text.match(/\b(?:TX|Tx|tx|Hash|哈希)\s*:\s*(0x[a-fA-F0-9]{64}|[1-9A-HJ-NP-Za-km-z]{64,88})/);
  const mcapMatch = text.match(/\bM(?:CAP|arket\s*Cap)\s*:\s*\$?([0-9.,]+(?:[KMB])?)/i);
  const tokenMatch = text.match(/\bToken\s*:\s*([0-9][0-9.,]*)\s*\[([^\]\n\r]+)\]/i);
  const buyNewMatch = text.match(/\bNew\s+buy\s+([0-9][0-9.,]*)\s*([A-Za-z]+)/i);
  const buyMoreMatch = text.match(/\bBuy\s+(?:more|part)\s+([0-9][0-9.,]*)\s*([A-Za-z]+)/i);
  const buyAllMatch = text.match(/\bBuy\s+All\s+([0-9][0-9.,]*)\s*([A-Za-z]+)/i);
  const sellNewMatch = text.match(/\bNew\s+sell\s+([0-9][0-9.,]*)\s*([A-Za-z]+)/i);
  const sellMoreMatch = text.match(/\bSell\s+(?:more|part)\s+([0-9][0-9.,]*)\s*([A-Za-z]+)/i);
  const sellAllMatch = text.match(/\bSell\s+All\s+([0-9][0-9.,]*)\s*([A-Za-z]+)/i);
  const sendToMatch = text.match(/\b(?:Send\s+to|Transfer\s+to)\b(?:\s+([0-9][0-9.,]*)\s*([A-Za-z]+))?/i);

  const marketCapUsd = mcapMatch ? parseCompactUsd(mcapMatch[1]) : null;
  const priceUsd = parsePriceLine(text);
  const headerLabels = parseHeaderLabels(text);
  const tokenAmount = tokenMatch ? Number.parseFloat(tokenMatch[1].replace(/,/g, '')) : null;
  const tokenAmountNormalized = Number.isFinite(tokenAmount as number) ? tokenAmount : null;

  let quoteAmount: number | null = null;
  let quoteSymbol: string | null = null;
  let action: 'buy' | 'sell' | 'send' | null = null;
  let actionLabel: '建仓' | '加仓' | '减仓' | '清仓' | '发送' | null = null;
  let actionVariant: 'open' | 'add' | 'reduce' | 'close' | 'send' | null = null;
  if (buyNewMatch) {
    quoteAmount = Number.parseFloat(buyNewMatch[1].replace(/,/g, ''));
    quoteSymbol = buyNewMatch[2]?.toUpperCase() || null;
    action = 'buy';
    actionLabel = '建仓';
    actionVariant = 'open';
  } else if (buyMoreMatch) {
    quoteAmount = Number.parseFloat(buyMoreMatch[1].replace(/,/g, ''));
    quoteSymbol = buyMoreMatch[2]?.toUpperCase() || null;
    action = 'buy';
    actionLabel = '加仓';
    actionVariant = 'add';
  } else if (buyAllMatch) {
    quoteAmount = Number.parseFloat(buyAllMatch[1].replace(/,/g, ''));
    quoteSymbol = buyAllMatch[2]?.toUpperCase() || null;
    action = 'buy';
    actionLabel = '建仓';
    actionVariant = 'open';
  } else if (sellAllMatch) {
    quoteAmount = Number.parseFloat(sellAllMatch[1].replace(/,/g, ''));
    quoteSymbol = sellAllMatch[2]?.toUpperCase() || null;
    action = 'sell';
    actionLabel = '清仓';
    actionVariant = 'close';
  } else if (sellMoreMatch) {
    quoteAmount = Number.parseFloat(sellMoreMatch[1].replace(/,/g, ''));
    quoteSymbol = sellMoreMatch[2]?.toUpperCase() || null;
    action = 'sell';
    actionLabel = '减仓';
    actionVariant = 'reduce';
  } else if (sellNewMatch) {
    quoteAmount = Number.parseFloat(sellNewMatch[1].replace(/,/g, ''));
    quoteSymbol = sellNewMatch[2]?.toUpperCase() || null;
    action = 'sell';
    actionLabel = '减仓';
    actionVariant = 'reduce';
  } else if (sendToMatch) {
    action = 'send';
    actionLabel = '发送';
    actionVariant = 'send';
  }

  const sendAmount = sendToMatch?.[1] ? Number.parseFloat(sendToMatch[1].replace(/,/g, '')) : null;
  const sendSymbol = sendToMatch?.[2]?.toUpperCase() || null;
  const fallbackTokenAmount = Number.isFinite(sendAmount as number) ? sendAmount : null;

  return {
    chain: primaryLink?.chain || parseChainFromText(text),
    tokenAddress: (caMatch ? caMatch[1] : null) || primaryLink?.tokenAddress || null,
    tokenSymbol: tokenMatch ? tokenMatch[2]?.trim() || null : sendSymbol,
    tokenAmount: tokenAmountNormalized ?? fallbackTokenAmount,
    txHash: (txMatch ? txMatch[1] : null) || txHashFromLinks,
    marketCapUsd,
    priceUsd,
    quoteAmount: Number.isFinite(quoteAmount as number) ? quoteAmount : null,
    quoteSymbol,
    action,
    actionLabel,
    actionVariant,
    walletLabel: headerLabels.walletLabel,
    walletGroupLabel: headerLabels.walletGroupLabel,
    walletAliasLabel: headerLabels.walletAliasLabel,
    trackedWalletAddress: primaryLink?.trackedWalletAddress || null,
    eventTimeMs:
      typeof fallbackTimestampMs === 'number' && Number.isFinite(fallbackTimestampMs) ? fallbackTimestampMs : null,
  };
}
