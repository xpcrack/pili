import 'server-only';

/**
 * GMGN 交易推送帖（fomoleaderboardfeed 等）的结构化解析。
 *
 * 推文原文全文是 Telegram markdown 加粗（**...**），形如：
 *
 *   **$HOOKED**** buy** **0xLeaf🍃** (@3ethtomoon)
 *
 *   Bought: **$5,000.00**
 *   Position: **$78,199.68**
 *   Average cost: **$0.0092868**
 *   Return: **0.00%**
 *   Swaps: 10
 *   Market cap: **$9.03M**
 *   Solana: `C1mBfBoDkwWfd6uTFZp62ARHLjeVp3bDpCDMfMZtPngE`
 *   gmgn · fomo
 *
 * sell 变体把 Bought: 换成 Proceeds:。
 * 历史教训（2026-10-08）：这些字段此前从未解析，feed 上 ticker 全 UNKNOWN、
 * MC 列直接显示 "**$9.03M**" 原文。本模块把文本转成结构化 metadata。
 */

export interface FomoTradePostFields {
  tokenSymbol: string | null;
  tokenAddress: string | null;
  chain: 'solana' | 'ethereum' | 'bsc' | 'robinhood' | null;
  tradeAction: 'buy' | 'sell' | null;
  tradeAmountUsd: number | null;
  marketCapUsd: number | null;
}

/** 剥 Telegram markdown 加粗与反引号：**$9.03M** → $9.03M。 */
export function stripTelegramMarkdown(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}

function parseCompactUsd(value: string): number | null {
  const cleaned = value.replace(/[$,\s]/g, '').trim().toUpperCase();
  if (!cleaned) return null;
  const suffix = cleaned.slice(-1);
  const multiplier = suffix === 'B' ? 1_000_000_000 : suffix === 'M' ? 1_000_000 : suffix === 'K' ? 1_000 : 1;
  const numberPart = multiplier === 1 ? cleaned : cleaned.slice(0, -1);
  const parsed = Number.parseFloat(numberPart);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed * multiplier;
}

/** 链标签行：`Solana: \`CA\`` / `Ethereum: \`0x..\`` / `BSC: \`0x..\``。 */
function parseChainAndAddress(text: string): { chain: FomoTradePostFields['chain']; tokenAddress: string | null } {
  const patterns: Array<{ re: RegExp; chain: FomoTradePostFields['chain'] }> = [
    { re: /\bSolana\s*:\s*`?([1-9A-HJ-NP-Za-km-z]{32,44})`?/i, chain: 'solana' },
    { re: /\bEthereum\s*:\s*`?(0x[a-fA-F0-9]{40})`?/i, chain: 'ethereum' },
    { re: /\bBSC\s*:\s*`?(0x[a-fA-F0-9]{40})`?/i, chain: 'bsc' },
    // GMGN 用 "Robinhood" 标注 Robinhood Chain（L2，EVM 地址）
    { re: /\bRobinhood\s*:\s*`?(0x[a-fA-F0-9]{40})`?/i, chain: 'robinhood' },
  ];
  for (const { re, chain } of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      return { chain, tokenAddress: m[1] };
    }
  }
  return { chain: null, tokenAddress: null };
}

/** 标题行 token：`**$HOOKED**** buy**` / `**$龙虾 buy**` → HOOKED / 龙虾。 */
function parseTitleToken(titleLine: string): string | null {
  const stripped = stripTelegramMarkdown(titleLine);
  const m = stripped.match(/^\$([A-Za-z0-9\u4e00-\u9fff\uac00-\ud7af\u3040-\u30ff._-]{1,30})/);
  if (m?.[1]) return m[1];
  // 纯 emoji/罕见符号 ticker（如 **$🙈 buy** / **$+ buy**）：$ 后到首个空格，≤8 码点
  const m2 = stripped.match(/^\$(\S{1,8})\s/);
  if (m2?.[1] && !/[()@]/.test(m2[1])) return m2[1];
  return null;
}

function parseTradeAmountUsd(text: string): number | null {
  const m = text.match(/\b(?:Bought|Proceeds)\s*:\s*\*{0,2}\$([0-9][0-9,.]*[KMB]?)\*{0,2}/i);
  return m?.[1] ? parseCompactUsd(m[1]) : null;
}

function parseMarketCapUsd(text: string): number | null {
  const m = text.match(/\bMarket\s*cap\s*:\s*\*{0,2}\$([0-9][0-9,.]*[KMB]?)\*{0,2}/i);
  return m?.[1] ? parseCompactUsd(m[1]) : null;
}

export function parseFomoTradePostFields(text: string | null | undefined): FomoTradePostFields | null {
  const raw = (text || '').trim();
  if (!raw) return null;

  const titleLine = raw.split('\n')[0] || '';
  // 快速判别：只处理 GMGN 交易推送格式（标题 **$token ... buy/sell**）
  if (!/\*\*\s*\$/i.test(titleLine)) return null;
  const tradeAction = /\*\*\s*\$[^\n]*?\b(buy|sell)\b\s*\*\*/i.test(titleLine)
    ? (titleLine.match(/\*\*\s*\$[^\n]*?\b(buy|sell)\b/i)?.[1]?.toLowerCase() as 'buy' | 'sell' | undefined) ?? null
    : null;
  if (!tradeAction) return null;

  const hasTradeBody = /\b(Bought|Proceeds)\s*:/i.test(raw);
  if (!hasTradeBody) return null;

  const { chain, tokenAddress } = parseChainAndAddress(raw);
  const tokenSymbol = parseTitleToken(titleLine);

  return {
    tokenSymbol,
    tokenAddress,
    chain,
    tradeAction,
    tradeAmountUsd: parseTradeAmountUsd(raw),
    marketCapUsd: parseMarketCapUsd(raw),
  };
}
