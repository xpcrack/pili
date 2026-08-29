import 'server-only';

/**
 * fomo/pump 喊单转发群消息解析。
 *
 * 平台消息有两种形态（2026-08 样本）：
 * 1. 单条动态：
 *    🟢 FlippingProfits 买入 Alawn
 *    ≈$333 · 数量 41.0M · 付 USDC · 首次
 *    21:11:46 · solana
 * 2. 聚合动态：
 *    2 条新动态:
 *    1. 【Rowdy】买入了代币 $DOLORES · ≈$9,999
 *    2. 【Cooker.hl | 版本之子 (Theo Arc)】转发了推文
 *
 * 只提取买入/卖出交易行；关注、发推、转发、回复等社媒动态一律丢弃
 * （社媒内容走飞书→newone→pili 链路，这里只补交易喊单）。
 */

export interface FomoPumpTradeLine {
  /** 平台显示名，可能带装饰（emoji / |后缀 / (别名)）。 */
  personLabel: string;
  action: 'buy' | 'sell';
  tokenSymbol: string;
  /** 消息标注的美元金额（≈$ 后的数值）。 */
  amountUsd: number | null;
  /** 数量标签原文（如 "41.0M"）。 */
  quantityLabel: string | null;
  quoteSymbol: string | null;
  isFirstBuy: boolean;
  chain: string | null;
  eventTimeMs: number | null;
  rawLine: string;
}

export interface ParseFomoPumpTextResult {
  trades: FomoPumpTradeLine[];
  /** 非交易也非社媒的未识别行数——格式改版时的迭代信号。 */
  unrecognizedLines: string[];
}

/** 社媒动态关键词：命中即丢弃。 */
const SOCIAL_ACTION_PATTERN =
  /(关注|取关|发推|推文|回复了|转发了|发布了|加入了|发言)/;

const ACTION_WORDS = ['买入了代币', '卖出了代币', '买入', '卖出', '买了', '卖了'] as const;

function normalizeChainToken(value: string): string | null {
  const lowered = value.trim().toLowerCase();
  if (lowered === 'sol' || lowered.includes('solana')) return 'solana';
  if (lowered === 'bnb' || lowered.includes('bsc')) return 'bsc';
  if (lowered.includes('eth')) return 'ethereum';
  if (lowered.includes('base')) return 'base';
  return null;
}

function parseUsdAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw.replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseClockTime(raw: string | undefined, fallbackMs: number): number {
  if (!raw) return fallbackMs;
  const match = raw.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return fallbackMs;
  // 平台消息标注的 HH:MM:SS 是 UTC（GMGN/robinhood 等上游用 UTC 时间戳）。
  // 旧实现误用本地时区 setHours 解释，把 UTC 当成本地时间，导致存入的
  // UTC epoch 比真实交易时间偏 +12h（表现为 Feed 出现"未来"时间戳）。
  // 正确做法：按 UTC 构造（Date.UTC），日期锚点取 message.date 的 UTC 日。
  // 若标注到晚于消息到达（说明交易发生在前一天 UTC），减一天；仍超前则兜底
  // 钳到消息时间，确保永不产生"未来"事件时间。
  const base = new Date(fallbackMs);
  const atTime = (d: Date): number =>
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      Number(match[1]),
      Number(match[2]),
      Number(match[3] || '0'),
      0
    );
  let utcMs = atTime(base);
  if (utcMs > fallbackMs) {
    const prev = new Date(base.getTime() - 24 * 3600 * 1000);
    const prevMs = atTime(prev);
    if (prevMs <= fallbackMs) {
      utcMs = prevMs;
    }
  }
  if (utcMs > fallbackMs) {
    return fallbackMs;
  }
  return utcMs;
}

/**
 * 清理平台显示名装饰：【】括号、"|"后的后缀、"(...)"别名、emoji。
 * "Cooker.hl | 版本之子 (Theo Arc)" → "Cooker.hl"
 */
export function cleanFomoPumpPersonLabel(rawLabel: string): string {
  let label = rawLabel.trim();
  const pipeIndex = label.indexOf('|');
  if (pipeIndex > 0) {
    label = label.slice(0, pipeIndex);
  }
  // 去掉成对括号内的别名与残留 emoji/符号
  label = label.replace(/[()（）]/g, ' ');
  // eslint-disable-next-line no-irregular-whitespace
  label = label.replace(/[^\p{L}\p{N}._\- ]/gu, '');
  return label.trim();
}

interface LineParseOutcome {
  trade: Omit<FomoPumpTradeLine, 'chain' | 'eventTimeMs'> | null;
}

/** 交易行的后续片段（金额行、时间·链行），静默忽略不算未识别。 */
const CONTINUATION_LINE_PATTERN = /^≈|^\d{1,2}:\d{2}|^数量|^付\s*[A-Za-z]/;

function parseTradeLine(line: string): LineParseOutcome {
  const cleaned = line.replace(/^\s*\d+[.)]\s*/, '').trim(); // 去掉聚合序号 "1. "
  if (!cleaned || SOCIAL_ACTION_PATTERN.test(cleaned)) {
    return { trade: null };
  }

  // 人物：【xxx】 或 行首裸名字（单条形态）
  let personLabel: string | null = null;
  let rest = cleaned;
  const bracketMatch = cleaned.match(/^【([^】]+)】\s*/);
  if (bracketMatch) {
    personLabel = bracketMatch[1];
    rest = cleaned.slice(bracketMatch[0].length);
  } else {
    const actionIndex = cleaned.search(/买入了?代币|卖出了?代币|买入了?|卖出了?/);
    if (actionIndex <= 0) {
      return { trade: null };
    }
    personLabel = cleaned
      .slice(0, actionIndex)
      .replace(/^[\p{Extended_Pictographic}\u{2600}-\u{27BF}]+\s*/u, '')
      .trim();
    rest = cleaned.slice(actionIndex);
  }
  if (!personLabel) {
    return { trade: null };
  }

  const isBuy = /^(买入|买了)/.test(rest);
  const afterAction = rest.replace(/^(买入了?代币|卖出了?代币|买入了?|卖出了?)/, '').trim();
  if (!afterAction) {
    return { trade: null };
  }

  // 代币：$SYM 或裸词；后面可跟 · ≈$金额 等
  const tokenMatch = afterAction.match(/^\$?([A-Za-z0-9][A-Za-z0-9._]*)(?:\s*[·•]\s*≈\$([\d,.]+))?/);
  if (!tokenMatch) {
    return { trade: null };
  }
  const tokenSymbol = tokenMatch[1].replace(/\$/g, '').trim();
  if (!tokenSymbol) {
    return { trade: null };
  }
  const amountUsd = parseUsdAmount(tokenMatch[2]);

  // 行内附加片段：付 USDC · 首次 / 数量 xx
  const tail = afterAction.slice(tokenMatch[0].length);
  const quantityMatch = tail.match(/数量\s*([\d,.]+[KkMmBb]?)/);
  const quoteMatch = tail.match(/付\s*([A-Za-z]{2,10})/);

  return {
    trade: {
      personLabel,
      action: isBuy ? 'buy' : 'sell',
      tokenSymbol,
      amountUsd,
      quantityLabel: quantityMatch ? quantityMatch[1] : null,
      quoteSymbol: quoteMatch ? quoteMatch[1] : null,
      isFirstBuy: /首次/.test(tail),
      rawLine: line.trim(),
    },
  };
}

export function parseFomoPumpTelegramText(rawText: string, fallbackTimeMs: number): ParseFomoPumpTextResult {
  const lines = rawText.split('\n');
  const trades: FomoPumpTradeLine[] = [];
  const unrecognizedLines: string[] = [];

  for (const line of lines) {
    const outcome = parseTradeLine(line);
    if (outcome.trade) {
      trades.push({
        ...outcome.trade,
        chain: null,
        eventTimeMs: null,
      });
    } else if (CONTINUATION_LINE_PATTERN.test(line.trim()) && trades.length > 0) {
      // 单条形态的金额/数量行：合并进最近一笔交易（仅填空位）
      const last = trades[trades.length - 1]!;
      const amountMatch = line.match(/≈\$\s*([\d,.]+)/);
      if (amountMatch && last.amountUsd == null) last.amountUsd = parseUsdAmount(amountMatch[1]);
      const quantityMatch = line.match(/数量\s*([\d,.]+[KkMmBb]?)/);
      if (quantityMatch && !last.quantityLabel) last.quantityLabel = quantityMatch[1];
      const quoteMatch = line.match(/付\s*([A-Za-z]{2,10})/);
      if (quoteMatch && !last.quoteSymbol) last.quoteSymbol = quoteMatch[1];
      if (/首次/.test(line)) last.isFirstBuy = true;
    } else if (
      line.trim() &&
      !SOCIAL_ACTION_PATTERN.test(line) &&
      !/^\d+\s*条新动态[:：]?\s*$/.test(line.trim()) // 聚合头，静默忽略
    ) {
      unrecognizedLines.push(line.trim());
    }
  }

  if (trades.length === 0) {
    return { trades, unrecognizedLines };
  }

  // 全文级补充：链与时间通常在单条形态的尾行（"21:11:46 · solana"）
  let chain: string | null = null;
  for (const line of lines) {
    const chainMatch = line.match(/(?:^|\s|·)(solana|sol\b|bnb|bsc|ethereum|eth\b|base)/i);
    if (chainMatch) {
      const normalized = normalizeChainToken(chainMatch[1]);
      if (normalized) {
        chain = normalized;
      }
    }
  }
  const timeMatch = rawText.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
  const eventTimeMs = parseClockTime(timeMatch?.[1], fallbackTimeMs);

  return {
    trades: trades.map((trade) => ({
      ...trade,
      chain: trade.chain ?? chain,
      eventTimeMs: trade.eventTimeMs ?? eventTimeMs,
    })),
    unrecognizedLines,
  };
}
