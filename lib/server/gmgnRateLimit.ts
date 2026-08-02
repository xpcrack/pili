/**
 * Process + file-shared GMGN ban cooldown.
 * After RATE_LIMIT_BANNED, further requests extend the ban — fail closed.
 * File path lets web + backfill scripts share one cooldown.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const GMGN_BAN_COOLDOWN_MS = 5.5 * 60 * 1000;

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

function writeFileUntilMs(untilMs: number) {
  try {
    mkdirSync(dirname(COOLDOWN_FILE), { recursive: true });
    writeFileSync(
      COOLDOWN_FILE,
      JSON.stringify({ untilMs, updatedAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } catch {
    // non-fatal: memory cooldown still works in-process
  }
}

export function gmgnCooldownUntilMs(): number {
  return Math.max(memoryUntilMs, readFileUntilMs());
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
  let until = nowMs + GMGN_BAN_COOLDOWN_MS;

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

  memoryUntilMs = Math.max(memoryUntilMs, until, readFileUntilMs());
  writeFileUntilMs(memoryUntilMs);
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
const GLOBAL_RPS = Math.max(0.1, Number(process.env.GMGN_GLOBAL_RPS?.trim()) || 3.0);
const GLOBAL_BURST = Math.max(1, Number(process.env.GMGN_GLOBAL_BURST?.trim()) || 6);

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
 * 发起 GMGN 请求前从共享全局桶扣 cost 个令牌；不够则异步等到够为止。
 * 锁耗尽时 best-effort 放行（罕见，优于卡死流水线）。
 */
export async function acquireGmgnGlobalToken(cost = 1): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    let waitMs = 0;
    let got = false;
    if (await tryAcquireBucketLock()) {
      try {
        const now = Date.now();
        const s = readBucket();
        const elapsed = Math.max(0, now - s.lastMs);
        const tokens = Math.min(GLOBAL_BURST, s.tokens + (elapsed / 1000) * GLOBAL_RPS);
        if (tokens >= cost) {
          writeBucket({ tokens: tokens - cost, lastMs: now });
          got = true;
        } else {
          const deficit = cost - tokens;
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
