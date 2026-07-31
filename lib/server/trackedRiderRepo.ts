import 'server-only';

import { getDb } from '@/lib/server/sqlite';

/**
 * 「同车」存在性判定 — 社媒 ticker 识别时过滤小币用。
 *
 * 口径：pili 监控的地址里，是否有任意一个当前仍持有该代币。
 * current_holdings 在每次钱包持仓刷新时整段 DELETE→重插（见 holdingsRefreshRuntime 的
 * replaceWalletHoldings），所以行存在即等于"当前真实持仓"，无陈旧零余额行；
 * 且低于 $5 (MIN_HOLDING_USD) 的尘埃在写入前已过滤，不会误算成同车。
 *
 * 跨链：一个代币可能跨链存在，只要任意链上有人持有即视为"有同车"，所以查询不限定 chain。
 *
 * 与 newone 的 listTokenCoRiders 不是同一口径（那里有阈值/7天冷窗/人物合并），
 * 这里只回答 pili 监控面板上"当前有没有人还拿着"——这是本过滤所需的最小信号。
 */

/**
 * 给定一批代币地址（任意大小写），返回其中"有 pili 监控地址当前持仓"的集合（小写）。
 * 其余即视为无同车。单次 SQL IN 查询，按推文批量调用即可，无需每条 mention 一次。
 */
export function findAddressesWithTrackedRiders(
  addresses: Array<string | null | undefined>,
): Set<string> {
  const lowered = new Set<string>();
  for (const raw of addresses) {
    const a = (raw || '').trim().toLowerCase();
    if (a) lowered.add(a);
  }
  if (lowered.size === 0) return lowered;

  const db = getDb();
  const placeholders = Array.from(lowered, () => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT token_address_lower
       FROM current_holdings
       WHERE token_address_lower IN (${placeholders})`
    )
    .all(...lowered) as Array<{ token_address_lower: string }>;
  return new Set(rows.map((r) => r.token_address_lower.toLowerCase()));
}
