/**
 * GMGN request metrics — append-only JSONL, shared file with newone.
 *
 * pili 之前不记录 GMGN 请求 → request-events.jsonl 里看不到 pili 流量，
 * 但 pili 的请求照样打 GMGN、触发封禁、写 ban-cooldown —— 造成
 * 「幽灵封禁」：cb 涨但 request-events 无 banned 记录，所有按
 * request-events 归因的优化都对 pili 流量失效。
 * 2026-08-07 补齐：与 newone 写同一文件，让 pili 流量可见、可归因。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const DEFAULT_GMGN_METRICS_FILE = join(
  homedir(),
  '.config',
  'gmgn',
  'request-events.jsonl'
);

function gmgnMetricsFile(): string {
  return process.env.GMGN_METRICS_FILE?.trim() || DEFAULT_GMGN_METRICS_FILE;
}

/** 与 newone getRuntimeSourceIdentity 同格式：cwd|entrypoint，env 可覆盖。 */
function getRuntimeSourceIdentity(): string {
  const configured = process.env.PILI_SOURCE_IDENTITY?.trim();
  if (configured) return configured;
  const entrypoint = process.argv[1] ? resolve(process.argv[1]) : 'unknown';
  return `${resolve(process.cwd())}|${entrypoint}`;
}

export type GmgnRequestEvent = {
  ts: number;
  ok: boolean;
  status?: number;
  path?: string;
  error?: string;
  blocked?: boolean;
  source_identity?: string;
};

/** 与 newone 同构：写 request-events.jsonl；文件 >1MB 时按 5min 窗口压缩。 */
export function recordGmgnRequest(
  event: Omit<GmgnRequestEvent, 'ts'>,
  nowMs = Date.now()
): void {
  if (process.env.GMGN_METRICS_DISABLED === '1') return;
  try {
    const file = gmgnMetricsFile();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(
      file,
      JSON.stringify({
        ts: nowMs,
        source_identity: getRuntimeSourceIdentity(),
        ...event,
      }) + '\n',
      'utf8'
    );
    if (existsSync(file) && statSync(file).size >= 1_000_000) {
      const cutoff = nowMs - 5 * 60_000;
      const lines: string[] = [];
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const e = JSON.parse(line) as GmgnRequestEvent;
          if (Number.isFinite(e.ts) && e.ts >= cutoff) lines.push(line);
        } catch {
          /* skip corrupt */
        }
      }
      // 多进程共用同一文件：rename 目标必须原子。tmp 名带 pid，
      // 并发压缩互不覆盖对方的中间文件，最坏只丢一个窗口（metrics 尽力而为）。
      const tmp = `${file}.${process.pid}.tmp`;
      appendFileSync(tmp, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
      try {
        renameSync(tmp, file);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* metrics only */
  }
}
