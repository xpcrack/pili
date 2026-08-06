/**
 * Process + file-shared GMGN ban cooldown.
 * After RATE_LIMIT_BANNED, further requests extend the ban — fail closed.
 * File path lets web + backfill scripts share one cooldown.
 *
 * 三方共写协议：本文件是 ban-cooldown.json 的三个写入者之一（另两个是
 * newone packages/adapters/src/gmgn-rate-limit.ts、tools/web3-sheet-backfill/keypool.py）。
 * 三家必须遵守同一协议——冷却时长=max(60s, reset_at+5s)、不 ratchet 陈旧 untilMs、
 * 保留彼此的扩展字段。完整约定见 keypool.py 文件头。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const GMGN_BAN_COOLDOWN_MS = 60 * 1000;

/** Global shared path — pili / wrapper / python tools all use this. */
export const DEFAULT_GMGN_BAN_COOLDOWN_FILE = join(homedir(), '.config', 'gmgn', 'ban-cooldown.json');

const COOLDOWN_FILE =
  process.env.GMGN_BAN_COOLDOWN_FILE?.trim() || DEFAULT_GMGN_BAN_COOLDOWN_FILE;

/** Heavy job lock (holdings vs backfill 错峰). */
export const DEFAULT_GMGN_HEAVY_JOB_LOCK = join(homedir(), '.config', 'gmgn', 'heavy-job.lock');
const HEAVY_JOB_LOCK =
  process.env.GMGN_HEAVY_JOB_LOCK?.trim() || DEFAULT_GMGN_HEAVY_JOB_LOCK;

/** signal 0 probes liveness without touching the process. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export function readGmgnHeavyJobLock(): { job: string; startedAt: string } | null {
  try {
    if (!existsSync(HEAVY_JOB_LOCK)) return null;
    const raw = JSON.parse(readFileSync(HEAVY_JOB_LOCK, 'utf8')) as {
      job?: string;
      startedAt?: string;
      pid?: number;
    };
    if (!raw.job) return null;
    // stale lock > 2h: ignore
    if (raw.startedAt) {
      const t = Date.parse(raw.startedAt);
      if (Number.isFinite(t) && Date.now() - t > 2 * 60 * 60 * 1000) return null;
    }
    // A killed holder leaves the file behind. Without this check the lock blocks
    // every GMGN heavy job (including holdings-refresh) for the full 2h window.
    if (typeof raw.pid === 'number' && raw.pid > 0 && !isProcessAlive(raw.pid)) {
      return null;
    }
    return { job: raw.job, startedAt: raw.startedAt || '' };
  } catch {
    return null;
  }
}

export function acquireGmgnHeavyJob(job: string): boolean {
  const existing = readGmgnHeavyJobLock();
  if (existing && existing.job !== job) return false;
  try {
    mkdirSync(dirname(HEAVY_JOB_LOCK), { recursive: true });
    writeFileSync(
      HEAVY_JOB_LOCK,
      JSON.stringify({ job, startedAt: new Date().toISOString(), pid: process.pid }, null, 2),
      'utf8'
    );
    return true;
  } catch {
    return false;
  }
}

export function releaseGmgnHeavyJob(job: string): void {
  try {
    const existing = readGmgnHeavyJobLock();
    if (existing && existing.job !== job) return;
    try {
      unlinkSync(HEAVY_JOB_LOCK);
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
}

let memoryUntilMs = 0;

export function isGmgnBanMessage(msg: string): boolean {
  // GmgnOutageError / assertGmgnAllowed 抛的消息以 "GMGN_COOLDOWN" 开头——它描述的是
  // 本地已有冷却，不是新的服务端封禁。后缀 "(after RATE_LIMIT_BANNED)" 只是说明性的，
  // 绝不能重新触发冷却（否则一次真封禁被自己的冷却错误消息无限自激、cb 只增不减）。
  // 与 newone 守卫一致（commit 19aa8db）。
  if (/^GMGN_COOLDOWN/i.test(msg)) return false;
  return /RATE_LIMIT_BANNED|IP is temporarily banned|account is temporarily banned|error=RATE_LIMIT_BANNED|ERROR_RATE_LIMIT_BLOCKED/i.test(
    msg
  );
}

export function isGmgnRateLimitMessage(msg: string): boolean {
  return isGmgnBanMessage(msg) || /HTTP 429|code=429|RATE_LIMIT_EXCEEDED|rate.?limit/i.test(msg);
}

function readFileUntilMs(): number {
  try {
    if (!existsSync(COOLDOWN_FILE)) return 0;
    const raw = JSON.parse(readFileSync(COOLDOWN_FILE, 'utf8')) as { untilMs?: unknown };
    const n = Number(raw.untilMs);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * 保留 newone 侧写入的扩展字段（consecutiveBans / lastBanAt / source / state /
 * lastReason）。newone 的恢复期慢启动 getGmgnRecoveryFactor 依赖 lastBanAt；
 * 本文件只写 {untilMs, updatedAt} 会把它们抹掉，绕过慢启动 → 冷却一结束就
 * 全速撞墙再封。读写同一共享文件，必须保留对方字段。
 */
function readFileCooldownState(): { untilMs: number; consecutiveBans?: number; lastBanAt?: string; lastReason?: string; source?: string; state?: string } {
  try {
    if (!existsSync(COOLDOWN_FILE)) return { untilMs: 0 };
    const raw = JSON.parse(readFileSync(COOLDOWN_FILE, 'utf8')) as {
      untilMs?: unknown; consecutiveBans?: unknown; lastBanAt?: string;
      lastReason?: string; source?: string; state?: string;
    };
    const n = Number(raw.untilMs);
    return {
      untilMs: Number.isFinite(n) ? n : 0,
      consecutiveBans: Number.isFinite(Number(raw.consecutiveBans)) ? Number(raw.consecutiveBans) : undefined,
      lastBanAt: raw.lastBanAt || undefined,
      lastReason: raw.lastReason || undefined,
      source: raw.source || undefined,
      state: raw.state || undefined,
    };
  } catch {
    return { untilMs: 0 };
  }
}

function writeFileUntilMs(untilMs: number) {
  try {
    mkdirSync(dirname(COOLDOWN_FILE), { recursive: true });
    const prev = readFileCooldownState();
    writeFileSync(
      COOLDOWN_FILE,
      JSON.stringify(
        {
          untilMs,
          updatedAt: new Date().toISOString(),
          // 保留 newone 的连续封禁计数与最后封禁时间（慢启动依赖）
          ...(prev.consecutiveBans != null ? { consecutiveBans: prev.consecutiveBans } : {}),
          ...(prev.lastBanAt != null ? { lastBanAt: prev.lastBanAt } : {}),
          ...(prev.lastReason != null ? { lastReason: prev.lastReason } : {}),
          ...(prev.source != null ? { source: prev.source } : {}),
          ...(prev.state != null ? { state: prev.state } : {}),
        },
        null,
        2
      ),
      'utf8'
    );
  } catch {
    // non-fatal: memory cooldown still works in-process
  }
}

export function gmgnCooldownUntilMs(): number {
  const fileUntil = readFileUntilMs();
  const now = Date.now();
  // 共享文件是跨进程事实源。memoryUntilMs 只增不减（noteGmgnBan 的 max 累加），
  // 若 newone 等写入者把文件值覆盖得更小且已过期，内存残留会把本进程锁死
  // （文件已过期但 max() 仍取内存大值 → 冷却永不解）。信任文件：
  // 文件已过期 → 冷却解除；文件未过期 → 取两者较大（本进程刚记的 ban 优先）。
  if (fileUntil <= now) return 0;
  return Math.max(memoryUntilMs, fileUntil);
}

export function gmgnCooldownRemainingMs(nowMs = Date.now()): number {
  return Math.max(0, gmgnCooldownUntilMs() - nowMs);
}

/** tests only */
export function resetGmgnCooldown(): void {
  memoryUntilMs = 0;
  try {
    if (existsSync(COOLDOWN_FILE)) writeFileSync(COOLDOWN_FILE, JSON.stringify({ untilMs: 0 }), 'utf8');
  } catch {
    /* ignore */
  }
}

export function noteGmgnBan(msg: string, nowMs = Date.now(), resetAtUnix?: number | null): number {
  // 兜底防线：任何 ^GMGN_COOLDOWN 消息（assertGmgnAllowed 抛的本地冷却错误）都不是
  // 新封禁，绝不能记——否则 cb 只增不减、自激死循环。即便调用方漏过 isGmgnBanMessage
  // 守卫，这里也拦住。与 newone 一致。
  if (/^GMGN_COOLDOWN/i.test(msg)) return readFileUntilMs();
  const prev = readFileCooldownState();
  const prevConsecutive = Math.max(0, Number(prev.consecutiveBans || 0));
  const recentBan = Number(prev.untilMs || 0) > nowMs - 5 * 60_000;
  const consecutiveBans = recentBan ? prevConsecutive + 1 : 1;
  // 信任 GMGN 服务器 reset_at；无 reset_at 时用 60s 缓冲。
  // 不再使用阶梯升级（5.5m→15m→30m→60m）——那 stale 一个钟。
  // 连封对齐滚动窗口：GMGN 滚动惩罚每次撞墙延 5s（上限 5min），本地冷却若
  // 短于 5min 会提前放行 → 第一个请求撞还在生效的惩罚 → 再封 → cb 只涨不降
  // （实测 cb=25 就是这么来的）。连封（recentBan）时强制 until ≥ now + 5min，
  // 给 GMGN 完整清窗；reset_at 若更长则覆盖。单次封（cb=1）仍 60s 试错。
  const RAMP_MS = Math.min(240_000, Math.max(0, consecutiveBans - 1) * 30_000);
  let until = nowMs + GMGN_BAN_COOLDOWN_MS + RAMP_MS;
  if (recentBan) until = Math.max(until, nowMs + 5 * 60_000);

  if (resetAtUnix != null && Number.isFinite(resetAtUnix)) {
    if (resetAtUnix > 1e12) until = Math.max(until, resetAtUnix + 5_000);
    else if (resetAtUnix > 1e9) until = Math.max(until, resetAtUnix * 1000 + 5_000);
  }

  const rem = msg.match(/~\s*(\d+)\s*s\s*remaining/i);
  if (rem) {
    const sec = Number(rem[1]);
    if (Number.isFinite(sec) && sec > 0) {
      until = Math.max(until, nowMs + (sec + 30) * 1000);
    }
  }

  const ra = msg.match(/reset_at[=:\s]+(\d{10,13})/i);
  if (ra) {
    let ts = Number(ra[1]);
    if (ts < 1e12) ts *= 1000;
    if (Number.isFinite(ts)) until = Math.max(until, ts + 5_000);
  }

  // "Rate limit resets at 2026-07-22 21:18:38 GMT+08:00"
  const at = msg.match(/resets at\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*(GMT([+-]\d{2}):?(\d{2})|Z)?/i);
  if (at) {
    try {
      const base = at[1].replace(' ', 'T');
      let iso = base;
      if (at[2] && at[2].toUpperCase() === 'Z') iso = `${base}Z`;
      else if (at[3] && at[4]) iso = `${base}${at[3]}${at[4]}`;
      else iso = `${base}+08:00`;
      const ms = Date.parse(iso);
      if (Number.isFinite(ms)) until = Math.max(until, ms + 5_000);
    } catch {
      /* ignore */
    }
  }

  // 不 ratchet 跨进程陈旧文件值：服务器 reset 信号已捕获本次 ban 的真实解除
  // 时间，再 max(readFileUntilMs()) 只会把 newone/旧代码残留的 60min 长值无条件
  // 保留（35s 真封禁被本地大值覆盖 → 锁一个钟）。短 ban 用短值覆盖陈旧长值。
  memoryUntilMs = Math.max(memoryUntilMs, until);
  writeFileUntilMs(memoryUntilMs);
  // 与 newone 对齐：把 consecutiveBans/lastBanAt/lastReason/state 写进共享文件，
  // 否则这些字段一旦被抹空（旧极简格式）就永远无法自愈，恢复期慢启动被绕过。
  try {
    const full = readFileCooldownState();
    writeFileSync(
      COOLDOWN_FILE,
      JSON.stringify(
        {
          untilMs: memoryUntilMs,
          updatedAt: new Date(nowMs).toISOString(),
          source: 'pili',
          state: 'open',
          consecutiveBans,
          lastBanAt: new Date(nowMs).toISOString(),
          lastReason: msg.slice(0, 500),
          ...(full.source != null && full.source !== 'pili' ? { source: full.source } : {}),
        },
        null,
        2
      ),
      'utf8'
    );
  } catch {
    // non-fatal
  }
  return memoryUntilMs;
}

export function noteGmgnError(msg: string, nowMs = Date.now()): void {
  if (isGmgnBanMessage(msg)) {
    noteGmgnBan(msg, nowMs);
  }
  // bare 429 without ban → do not lock whole process
}

export function assertGmgnAllowed(nowMs = Date.now()): void {
  const left = gmgnCooldownRemainingMs(nowMs);
  if (left > 0) {
    throw new Error(
      `GMGN_COOLDOWN ${Math.ceil(left / 1000)}s remaining (after RATE_LIMIT_BANNED)`
    );
  }
}

// ============================================================================
// Cross-process global rate limit (file token bucket) — preventive.
// pilipili / newone / wrapper 共享一个桶，把聚合 GMGN qps 钉在 rps+burst 之下，
// 而不是被封后才靠冷却文件反应。两个 repo 的协议一字不差，靠同一桶文件协调。
//   bucket: ~/.config/gmgn/global-bucket.json = { tokens, lastMs }
//   mutex:  ~/.config/gmgn/global-bucket.json.lock (lockdir; macOS 无 flock)
// ============================================================================

const GLOBAL_BUCKET_FILE =
  process.env.GMGN_GLOBAL_BUCKET_FILE?.trim() || join(homedir(), '.config', 'gmgn', 'global-bucket.json');
const GLOBAL_BUCKET_LOCK = GLOBAL_BUCKET_FILE + '.lock';
// GMGN IP 级限速窗口实测 ~25-30 请求/分钟（35 请求/63s 即被封，0.56rps 都超）。
// 全局桶是跨进程聚合入口，容量必须压到 IP 窗口之下（与 newone 对齐）。
// 0.4rps × 60 = 24/min，留余量；burst 3 防安静期攒满瞬间放行。
const GLOBAL_RPS = Math.max(0.1, Number(process.env.GMGN_GLOBAL_RPS?.trim()) || 0.4);
const GLOBAL_BURST = Math.max(1, Number(process.env.GMGN_GLOBAL_BURST?.trim()) || 3);

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type BucketState = { tokens: number; lastMs: number };

function readBucket(): BucketState {
  const fallback: BucketState = { tokens: GLOBAL_BURST, lastMs: Date.now() };
  try {
    if (!existsSync(GLOBAL_BUCKET_FILE)) return fallback;
    const raw = JSON.parse(readFileSync(GLOBAL_BUCKET_FILE, 'utf8')) as Partial<BucketState>;
    const tokens = Number(raw.tokens);
    const lastMs = Number(raw.lastMs);
    return {
      tokens: Number.isFinite(tokens) ? tokens : fallback.tokens,
      lastMs: Number.isFinite(lastMs) ? lastMs : fallback.lastMs,
    };
  } catch {
    return fallback;
  }
}

function writeBucket(s: BucketState): void {
  try {
    mkdirSync(dirname(GLOBAL_BUCKET_FILE), { recursive: true });
    writeFileSync(GLOBAL_BUCKET_FILE, JSON.stringify(s), 'utf8');
  } catch {
    /* non-fatal: in-process pacing still works */
  }
}

/** lockdir 互斥（mkdir 原子；macOS 无 flock）。stale guard 30s 清理被 kill 的持有者。 */
async function tryAcquireBucketLock(): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    try {
      mkdirSync(GLOBAL_BUCKET_LOCK);
      try {
        writeFileSync(join(GLOBAL_BUCKET_LOCK, 'ts'), String(Date.now()));
      } catch {
        /* ignore */
      }
      return true;
    } catch {
      try {
        const ts = Number(readFileSync(join(GLOBAL_BUCKET_LOCK, 'ts'), 'utf8'));
        if (Number.isFinite(ts) && Date.now() - ts > 30_000) {
          rmSync(GLOBAL_BUCKET_LOCK, { recursive: true, force: true });
        }
      } catch {
        /* ignore */
      }
      await sleepMs(20);
    }
  }
  return false;
}

function releaseBucketLock(): void {
  try {
    rmSync(GLOBAL_BUCKET_LOCK, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * 恢复期慢启动因子：连封后冷却刚过期时不要满速恢复到全量并发。
 * 与 newone getGmgnRecoveryFactor 语义一致：consecutiveBans >= 2 且
 * 最后一次封禁在 5 分钟内时，因子从 0.3 线性回归到 1.0。
 * 基于 lastBanAt（而非 untilMs）——即使手动清冷却，只要封禁刚发生慢启动仍生效。
 */
export function getGmgnRecoveryFactor(nowMs = Date.now()): number {
  const prev = readFileCooldownState();
  let bans = Math.max(0, Number(prev.consecutiveBans || 0));
  // 防御：consecutiveBans 被第二写入者抹掉，但剩余冷却仍明显长于单次 60s 地板时
  // 推断连封，避免慢启动被绕过、冷却一结束就全速撞墙再封。
  if (bans < 2 && prev.untilMs != null && prev.untilMs > 0) {
    const remaining = Math.max(0, prev.untilMs - nowMs);
    if (remaining > GMGN_BAN_COOLDOWN_MS + 60_000) bans = 2;
  }
  if (bans < 2) return 1.0;
  const lastBanAt = prev.lastBanAt ? Date.parse(prev.lastBanAt) : 0;
  const sinceMs =
    Number.isFinite(lastBanAt) && lastBanAt > 0
      ? nowMs - lastBanAt
      : Math.max(0, nowMs - (Number(prev.untilMs) || nowMs));
  const RECOVERY_WINDOW_MS = 5 * 60_000;
  if (sinceMs >= RECOVERY_WINDOW_MS) return 1.0;
  return 0.3 + 0.7 * Math.max(0, sinceMs / RECOVERY_WINDOW_MS);
}

/**
 * 发起 GMGN 请求前从共享全局桶扣 cost 个令牌；不够则异步等到够为止。
 * 锁耗尽时 best-effort 放行（罕见，优于卡死流水线）。
 * 恢复期慢启动：连封后冷却刚过 5 分钟内，令牌成本按 1/factor 放大
 * （factor=0.3 → cost≈3.3x → 聚合 qps 压低到 30%），防止 pili 全速突进
 * 撞墙再封。这是跨进程共享桶，压制同时作用于所有走此桶的进程。
 */
export async function acquireGmgnGlobalToken(cost = 1): Promise<void> {
  const factor = getGmgnRecoveryFactor();
  const effectiveCost = factor < 1.0 ? cost / factor : cost;
  for (let attempt = 0; attempt < 300; attempt++) {
    let waitMs = 0;
    let got = false;
    if (await tryAcquireBucketLock()) {
      try {
        const now = Date.now();
        const s = readBucket();
        const elapsed = Math.max(0, now - s.lastMs);
        // 恢复期（连封后慢启动窗口内）burst 压缩：burst 上限 6→2，避免冷却
        // 一解除桶里瞬间攒满 6 token → 6 连发同毫秒放行撞 IP 限速再封。
        // 三层闸门都控平均速率，burst 上限才是瞬时峰值；IP 级限速罚瞬时峰值。
        const burstCap = factor >= 1.0 ? GLOBAL_BURST : Math.min(GLOBAL_BURST, 2);
        const tokens = Math.min(burstCap, s.tokens + (elapsed / 1000) * GLOBAL_RPS);
        if (tokens >= effectiveCost) {
          writeBucket({ tokens: tokens - effectiveCost, lastMs: now });
          got = true;
        } else {
          const deficit = effectiveCost - tokens;
          waitMs = Math.ceil((deficit / GLOBAL_RPS) * 1000) + 10;
        }
      } finally {
        releaseBucketLock();
      }
    }
    if (got) return;
    await sleepMs(waitMs > 0 ? waitMs : 20);
  }
  /* exhausted — serve best-effort */
}
