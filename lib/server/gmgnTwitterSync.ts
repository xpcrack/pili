/**
 * 飞书加新地址 → 该地址若在 gmgn 绑定了推特 → 自动回填进 pili 监控。
 *
 * 能力来源:gmgn OpenAPI `portfolio stats` 每个地址返回 common 画像:
 *   common.twitter_bind: boolean   — 地址是否在 gmgn 绑定了推特
 *   common.twitter_username: string — 绑定的推特 handle(bind=true 时有值)
 *
 * 口径(与用户对齐):
 *   - 只补 tracked_users.twitter 为空的用户。飞书手填过推特的完全不动(飞书是 source of truth)。
 *   - 遍历这类用户的所有监控地址查 gmgn stats,首个 common.twitter_bind===true 即回填;
 *     一旦某用户回填成功,本轮跳过其剩余地址(同一个人的推特只需捞一次)。
 *   - common.twitter_username 经 normalizeTwitterHandle 后写入(只在仍为空时写,避免覆盖)。
 *   - 失败静默打日志,绝不阻断飞书同步本身。
 *
 * 触发点:并入 feishu-enablement-sync 循环(见 server/runtime-tasks.ts),
 * 每 ~15min 跑完飞书同步后顺手补一次。新地址最迟下个周期内补上推特,
 * 之后现成的 twitterIdentityBackfill(completeness worker)补 twitter_user_id +
 * completeness twitter adapter 开始抓推文监控 —— 全自动。
 */
import 'server-only';

import { normalizeTwitterHandle } from '@/lib/canonical';
import { getDb } from '@/lib/server/sqlite';
import { runGmgnCliAsync } from '@/lib/server/gmgnCli';
import { inferChainFromAddress } from '@/lib/addressBook';
import { gmgnCooldownRemainingMs } from '@/lib/server/gmgnRateLimit';

/** 单次反查最多查多少个地址。防配额突刺、防拖卡飞书同步周期。 */
const MAX_ADDRESSES_PER_CYCLE = Number(process.env.PILI_GMGN_TWITTER_SYNC_MAX || 8);
/** gmgn stats 批量的并发数。小批量并发省墙钟,不宜高以免砸配额。 */
const CONCURRENCY = Math.min(3, Math.max(1, Number(process.env.PILI_GMGN_TWITTER_SYNC_CONCURRENCY || 2)));
/** 单次 gmgn-cli stats spawn 超时(ms)。 */
const STATS_TIMEOUT_MS = Number(process.env.GMGN_FETCH_TIMEOUT_MS || 20_000);

export type GmgnTwitterSyncResult = {
  ok: boolean;
  /** 实际发起 gmgn 查询的地址数 */
  queried: number;
  /** 成功回填推特的用户数 */
  filled: number;
  /** 查询了但 gmgn 未绑定推特(twitter_bind !== true) */
  notBound: number;
  /** 绑定了但 username 解析为空 */
  skippedEmptyHandle: number;
  /** 本轮该用户已被填上(早停/并发竞争),无需再查的地址 */
  skippedAlreadyFilled: number;
  failed: number;
  error?: string;
};

type Candidate = {
  userId: string;
  address: string;
};

/** 飞书同步跑完后调,补 gmgn 推特。永不抛 —— 失败只回传结果,不拖垮飞书循环。 */
export async function syncTwitterFromGmgnForUnfilledUsers(): Promise<GmgnTwitterSyncResult> {
  const empty: GmgnTwitterSyncResult = {
    ok: true,
    queried: 0,
    filled: 0,
    notBound: 0,
    skippedEmptyHandle: 0,
    skippedAlreadyFilled: 0,
    failed: 0,
  };

  let candidates: Candidate[];
  try {
    candidates = collectUnfilledCandidates();
  } catch (error) {
    return {
      ...empty,
      ok: false,
      error: `collect candidates failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (candidates.length === 0) return empty;

  // 冷却期内整轮跳过：否则每个 candidate 的 runGmgnCliAsync 都会撞 assertGmgnAllowed
  // 抛 GMGN_COOLDOWN，一次刷 ~40 行 error（不发任何 HTTP，纯噪音）。
  if (gmgnCooldownRemainingMs() > 0) return empty;

  const upsertTwitter = getDb().prepare(
    `UPDATE tracked_users
       SET twitter = ?, updated_at = ?
     WHERE id = ? AND (twitter IS NULL OR twitter = '')`
  );

  // 本轮已回填的用户 → 跳过其剩余地址(同一个人的推特只需捞一次)。
  const filledUsers = new Set<string>();
  let queried = 0;
  let filled = 0;
  let notBound = 0;
  let skippedEmptyHandle = 0;
  let skippedAlreadyFilled = 0;
  let failed = 0;

  // 走 gmgn-cli(spawn)而非 GmgnOpenApiClient:Node 的内置 fetch 不认 HTTPS_PROXY,
  // 直连 gmgn 会被墙(pili 自己的 holdingsRefresh 也是 openapi 失败后 fallback cli)。
  // CLI 经 undici ProxyAgent + wrapper 可靠走代理,且正是手动验证过返回 common 的路径。
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (c) => {
        if (filledUsers.has(c.userId)) return { kind: 'alreadyFilled' as const };
        // inferChainFromAddress 只返回 'solana' | 'bsc';gmgn stats 的 chain 字段是 sol/bsc。
        const chain = inferChainFromAddress(c.address);
        const gmgnChain = chain === 'solana' ? 'sol' : 'bsc';
        const stdout = await runGmgnCliAsync({
          args: ['portfolio', 'stats', '--chain', gmgnChain, '--wallet', c.address, '--period', '30d', '--raw'],
          timeoutMs: STATS_TIMEOUT_MS,
          // portfolio = signed 路由，3 倍加权扣令牌防打爆单 IP
          cost: 3,
        });
        const data = JSON.parse(stdout) as {
          common?: { twitter_bind?: boolean; twitter_username?: string };
        };
        const common = data?.common;
        if (!common) return { kind: 'nocommon' as const };
        if (!common.twitter_bind) return { kind: 'notBound' as const };
        const handle = normalizeTwitterHandle(common.twitter_username);
        if (!handle) return { kind: 'emptyHandle' as const };
        return { kind: 'fill' as const, userId: c.userId, handle };
      })
    );

    for (let j = 0; j < results.length; j++) {
      const settled = results[j];
      if (settled.status === 'rejected') {
        failed += 1;
        const msg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        console.warn(`[gmgn-twitter-sync] stats failed for ${batch[j]!.address}: ${msg}`);
        continue;
      }
      const v = settled.value;
        // 无论成功失败，记入已查地址避免下一周期再打
        checkedThisProcess.add(batch[j]!.address.toLowerCase());
      switch (v.kind) {
        case 'alreadyFilled':
          skippedAlreadyFilled += 1;
          break;
        case 'nocommon':
          queried += 1;
          failed += 1;
          break;
        case 'notBound':
          queried += 1;
          notBound += 1;
          break;
        case 'emptyHandle':
          queried += 1;
          skippedEmptyHandle += 1;
          break;
        case 'fill': {
          queried += 1;
          // 只在仍为空时写,避免并发覆盖(飞书同步 / 别处已填则不动)。
          const r = upsertTwitter.run(v.handle, Date.now(), v.userId);
          if (r.changes > 0) {
            filled += 1;
            filledUsers.add(v.userId);
          } else {
            skippedAlreadyFilled += 1; // 已被别处填上
          }
          break;
        }
      }
    }
  }

  return {
    ok: failed === 0 || filled > 0,
    queried,
    filled,
    notBound,
    skippedEmptyHandle,
    skippedAlreadyFilled,
    failed,
  };
}
/** 本进程本轮已查过推特身份的地址(避免 notBound/nocommon 每周期反复打同一批)。 */
const checkedThisProcess = new Set<string>();

/**
 * 收集"推特为空 + 有监控地址"的用户的全部地址。 * 按用户 updated_at 升序(新进 pili 的优先),同一用户的地址相邻排列。
 * 限 MAX_ADDRESSES_PER_CYCLE 条(地址数,非用户数)。
 */
function collectUnfilledCandidates(): Candidate[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT u.id AS user_id, a.address AS address
         FROM tracked_users u
         JOIN tracked_addresses a ON a.user_id = u.id
        WHERE (u.twitter IS NULL OR u.twitter = '')
          AND a.monitoring_enabled = 1
          AND a.address IS NOT NULL AND a.address != ''
        AND a.address NOT IN (SELECT value FROM json_each(?))
        ORDER BY u.updated_at ASC, a.address ASC
        LIMIT ?`
    )
    .all(MAX_ADDRESSES_PER_CYCLE, JSON.stringify([...checkedThisProcess])) as Array<{ user_id: string; address: string }>;

  return rows.map((row) => ({
    userId: String(row.user_id || ''),
    address: String(row.address || ''),
  }));
}
