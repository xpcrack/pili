import 'server-only';

import { createTrackedUser, listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import type { User } from '@/types';

/**
 * fomoleaderboardfeed 类"交易喊单频道帖"的归属决策。
 *
 * 用户规则（2026-08-29 确认）：
 *  - 帖子里出现的交易者 handle 能匹配到已跟踪用户（关注的人）→ 全收
 *    （喊单 thesis + 交易 trade 都保留），归属该关注的人。
 *  - 匹配不到（不认识）→ 只收喊单 thesis，归属新建的 user:fomo；
 *    交易 trade 帖一律丢弃（不收录）。
 *
 * 判别特征（只对这些帖生效，避免误伤普通社媒频道/birdshot_listings）：
 *  - 标题行含 `$token` 且含 `(@handle)` 或 `@handle`。
 *  - 且内容含 'thesis'（喊单/观点） 或 （buy/sell + 成交字段）。
 */

const FOMO_TRADE_MARKERS = /(proceeds|realized pnl|remaining position|bought|sale|average cost|market cap|swaps)/i;
const FOMO_TRADE_ACTION = /\b(buy|sell)\b/i;

export type FomoChannelPostKind = 'thesis' | 'trade' | 'none';

export interface FomoChannelAttribution {
  /** 是否属于"交易喊单帖"。false = 普通频道帖，走原归属逻辑。 */
  isFomoPumpPost: boolean;
  /** 提取到的交易者 handle（小写、无 @）。 */
  traderHandle: string | null;
  kind: FomoChannelPostKind;
  /** 'keep' = 收录进 feed；'drop' = 丢弃（不认识的人的交易帖）。 */
  decision: 'keep' | 'drop';
}

function normalizeKey(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase().replace(/^@/, '');
}

/** 判别并分类一条频道帖是否为 fomo 交易喊单帖，归属到对应决策。 */
export function classifyFomoChannelPost(text: string): FomoChannelAttribution {
  const titleLine = (text || '').split('\n')[0] || '';

  // 强判据：fomo 喊单帖标题以 "**$token" 开头（如 "**$memestock thesis**" / "**$BISCOTTI** sell**"）。
  // 普通社媒频道帖（jiuyicall/Ed_blockdaily 等）标题不含 "**$" 格式，靠此避免误判。
  if (!/^\*\*\$/i.test(titleLine.trim())) {
    return { isFomoPumpPost: false, traderHandle: null, kind: 'none', decision: 'keep' };
  }

  // 必须含 @handle 交易者
  const handleMatch =
    titleLine.match(/\(@([A-Za-z0-9_]{3,})\)/) || titleLine.match(/(?<![\w.])@([A-Za-z0-9_]{3,})/);
  if (!handleMatch) {
    return { isFomoPumpPost: false, traderHandle: null, kind: 'none', decision: 'keep' };
  }
  const traderHandle = normalizeKey(handleMatch[1]);

  // 判断 kind：thesis（喊单/观点） vs trade（成交）
  // 1) 标题/正文含 "thesis" → 一定是喊单/观点（即使正文有 buy/sell/PnL 字段，
  //    如 "**$BUY**** thesis**" 这种，正文常附持仓数据）≠ 成交记录。
  // 2) 否则若明确 buy/sell + 成交字段 → trade。
  // 3) 其余带 **$** @handle 格式 → 按信息类（thesis）归位。
  let kind: FomoChannelPostKind = 'thesis';
  if (/\bthesis\b/i.test(text || '')) {
    kind = 'thesis';
  } else if (FOMO_TRADE_ACTION.test(text || '') && FOMO_TRADE_MARKERS.test(text || '')) {
    kind = 'trade';
  } else if (/^\$\S+[\s\S]*$/m.test(titleLine) && /\s(buy|sell)\b/i.test(titleLine)) {
    kind = 'trade';
  }

  return {
    isFomoPumpPost: true,
    traderHandle,
    kind,
    // 决策在 resolveFomoAttributionUser 里根据"是否关注的人"进一步裁定
    decision: 'keep',
  };
}

const FOMO_SOURCE_CHANNELS = new Set(['fomoleaderboardfeed']);

/** fomo 信源群？fomoleaderboardfeed 等群出来的信息归类为独立信源 fomo（与 tg/推特并列）。 */
export function isFomoSourceChannel(channelUsername: string | null | undefined): boolean {
  return Boolean(channelUsername && FOMO_SOURCE_CHANNELS.has(channelUsername.trim().toLowerCase()));
}

/** 从标题行提取喊单代币符号（"**$microduck thesis**" → "microduck"；"**$牛来 thesis**" → "牛来"）。 */
function extractFomoToken(text: string): string | null {
  const titleLine = (text || '').split('\n')[0] || '';
  const m = titleLine.match(/^\*\*\$([A-Za-z0-9\u4e00-\u9fff]{1,30})/);
  if (m) return m[1];
  const m2 = titleLine.match(/^\*\*\$([A-Za-z0-9\u4e00-\u9fff._-]{1,30})/);
  return m2 ? m2[1] : null;
}

/** 提取喊单正文：第一条非装饰、非标题、非数据行的英文原文（跳过中文翻译/Position/PnL 等）。 */
function extractFomoThesisBody(text: string): string | null {
  const lines = (text || '').split('\n');
  // 第一条非空，且不是标题行（**$ 开头），也不是数据行（Position/Unrealized/Market cap/中文翻译等）
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\*\*\$/.test(trimmed)) continue; // 标题行
    if (/^(position|unrealized|market cap|average cost|proceeds|remaining|realized pnl|bought|sale|return|swaps|robinhood|solana|base|bsc|ethereum)\b/i.test(trimmed)) continue;
    if (/^[\u4e00-\u9fff]/.test(trimmed)) continue; // 中文翻译行，跳过
    // 这是正文——截到句号/逗号结束，通常整行都是正文
    return trimmed;
  }
  return null;
}

/** 构造统一喊单 content 格式：@handle 喊单$token：正文第一段。无法可靠提取 token/正文时回退原文。 */
export function buildFomoThesisContent(text: string, traderHandle: string | null): string {
  const token = extractFomoToken(text);
  const body = extractFomoThesisBody(text);
  // 提不出代币符号（格式异常）时不要产出 "喊单？：gmgn·fomo" 这类垃圾，回退原始文本。
  if (!token) return text.trim();
  const who = traderHandle ? `@${traderHandle}` : '未知';
  const what = `$${token}`;
  const content = body ? `：${body}` : '';
  return `${who} 喊单${what}${content}`;
}

/** 从标题行提取交易方向（"**$SAYLORMOON buy**" → "buy"）。 */
export function extractFomoTradeAction(text: string): 'buy' | 'sell' | null {
  const titleLine = (text || '').split('\n')[0] || '';
  const m = titleLine.match(/\*\*\s*\$\S+\s+(buy|sell)\b/i);
  if (m) return m[1].toLowerCase() === 'buy' ? 'buy' : 'sell';
  const m2 = titleLine.match(/\b(buy|sell)\b/i);
  if (m2) return m2[1].toLowerCase() === 'buy' ? 'buy' : 'sell';
  return null;
}

/** 匹配交易者 handle → 已跟踪用户（关注的人）。 */
export function matchTrackedUserByHandle(handle: string): User | null {
  const key = normalizeKey(handle);
  if (!key) return null;
  const users = listTrackedUsers();
  return (
    users.find(
      (u) =>
        normalizeKey(u.twitter) === key ||
        normalizeKey(u.name) === key ||
        normalizeKey(u.handle) === key
    ) || null
  );
}

/**
 * 根据分类 + handle 匹配，裁定最终归属用户与是否收录。
 * 返回 null 表示"丢弃"（不认识的人的交易帖）。
 */
export function resolveFomoAttributionUser(params: {
  classification: FomoChannelAttribution;
}): { user: User | null; kind: FomoChannelPostKind; traderHandle: string | null } {
  const { classification: c } = params;
  if (!c.isFomoPumpPost) {
    return { user: null, kind: c.kind, traderHandle: c.traderHandle };
  }
  const trader = c.traderHandle ? matchTrackedUserByHandle(c.traderHandle) : null;
  if (trader) {
    // 关注的人：全收（thesis + trade），归本人
    return { user: trader, kind: c.kind, traderHandle: c.traderHandle };
  }
  // 不认识的人：只收 thesis → 归 user:fomo；trade → 丢弃
  if (c.kind === 'thesis') {
    return { user: getOrCreateFomoUser(), kind: c.kind, traderHandle: c.traderHandle };
  }
  return { user: null, kind: c.kind, traderHandle: c.traderHandle }; // drop
}

/** user:fomo 常驻聚合用户：承接所有"不认识的人"的喊单。惰性创建 + 缓存。 */
let cachedFomoUser: User | null = null;

export function getOrCreateFomoUser(): User {
  if (cachedFomoUser) return cachedFomoUser;
  const existing = listTrackedUsers().find(
    (u) => normalizeKey(u.name) === 'fomo' || normalizeKey(u.handle) === 'fomo'
  );
  if (existing) {
    cachedFomoUser = existing;
    return existing;
  }
  const created = createTrackedUser({
    name: 'fomo',
    handle: 'fomo',
    avatar: '',
    twitter: undefined,
    addresses: [],
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    mainstreamAssetUsd: 0,
    assetUpdatedAt: null,
    monitoringEnabled: true,
    tags: ['fomo-pump-aggregate'],
  });
  cachedFomoUser = created;
  return created;
}
