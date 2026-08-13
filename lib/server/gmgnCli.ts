/**
 * Shared gmgn-cli spawn helpers: multi-key rotation + ban cooldown + proxy PATH.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  assertGmgnAllowed,
  isGmgnBanMessage,
  noteGmgnBan,
  noteGmgnEgressBan,
  noteGmgnError,
} from '@/lib/server/gmgnRateLimit';

const DEFAULT_PROXY = 'http://127.0.0.1:7897';
const KEY_LIST_PATH = join(homedir(), '.config', 'gmgn', 'api_keys.list');
const KEY_ENV_PATH = join(homedir(), '.config', 'gmgn', '.env');

let keyPool: string[] | null = null;
let keyCursor = 0;

function parseKeysFromText(text: string): string[] {
  const keys: string[] = [];
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/PRIVATE|BEGIN|END /.test(line)) continue;
    if (line.startsWith('GMGN_API_KEY=')) {
      line = line.slice('GMGN_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
    }
    if (line.startsWith('gmgn_') && line.length >= 20 && !/\s/.test(line)) {
      keys.push(line);
    }
  }
  return keys;
}

export function loadGmgnApiKeys(): string[] {
  if (keyPool) return keyPool;

  const keys: string[] = [];
  const multi = process.env.GMGN_API_KEYS?.trim();
  if (multi) {
    for (const k of multi.split(',')) {
      const t = k.trim();
      if (t) keys.push(t);
    }
  }
  const one = process.env.GMGN_API_KEY?.trim();
  if (one) keys.push(one);

  for (const p of [KEY_LIST_PATH, KEY_ENV_PATH]) {
    if (!existsSync(p)) continue;
    try {
      keys.push(...parseKeysFromText(readFileSync(p, 'utf8')));
    } catch {
      /* ignore */
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  keyPool = out;
  return out;
}

/** Round-robin next key (or null if pool empty). */
export function nextGmgnApiKey(): string | null {
  const keys = loadGmgnApiKeys();
  if (keys.length === 0) return null;
  const key = keys[keyCursor % keys.length]!;
  keyCursor = (keyCursor + 1) % keys.length;
  return key;
}

/** Prefer proxy wrapper on PATH; fall back to env override. */
export function resolveGmgnCliBin(explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  if (process.env.GMGN_CLI_PATH?.trim()) return process.env.GMGN_CLI_PATH.trim();
  // wrapper forces HTTP(S)_PROXY into clash 7897
  const local = join(homedir(), '.local', 'bin', 'gmgn-cli');
  if (existsSync(local)) return local;
  return 'gmgn-cli';
}

export function buildGmgnCliEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  const proxy = env.HTTPS_PROXY || env.HTTP_PROXY || env.https_proxy || env.http_proxy || DEFAULT_PROXY;
  env.HTTP_PROXY = proxy;
  env.HTTPS_PROXY = proxy;
  env.http_proxy = proxy;
  env.https_proxy = proxy;
  env.NODE_USE_ENV_PROXY = env.NODE_USE_ENV_PROXY || '1';
  // Key rotation is owned by ~/.local/bin/gmgn-cli (file-shared RR).
  // Do not pin GMGN_API_KEY here — that would freeze all spawns on one key.
  return env;
}

function noteFailureFromOutput(stderr: string, stdout: string) {
  const msg = `${stderr}\n${stdout}`.trim();
  if (!msg) return;
  if (isGmgnBanMessage(msg)) {
    const scoped = msg.match(/GMGN_EGRESS_BANNED proxy=(https?:\/\/\S+)/i)?.[1];
    if (scoped) noteGmgnEgressBan(msg, scoped);
    else noteGmgnBan(msg);
  } else {
    noteGmgnError(msg);
  }
}

export async function runGmgnCliAsync(opts: {
  args: string[];
  bin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** @deprecated The guarded wrapper derives the documented route weight. */
  cost?: number;
}): Promise<string> {
  if (process.env.PILI_GMGN_RECOVERY_PAUSED === '1') {
    throw new Error('GMGN_COOLDOWN paused for newone self-holdings recovery');
  }
  assertGmgnAllowed();
  const bin = resolveGmgnCliBin(opts.bin);
  const env = buildGmgnCliEnv(opts.env);

  return await new Promise((resolve, reject) => {
    const child = spawn(bin, opts.args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error: Error | null, output?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(output || '');
    };

    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            child.kill('SIGTERM');
            finish(new Error(`gmgn-cli timed out after ${opts.timeoutMs}ms`));
          }, opts.timeoutMs)
        : null;

    const abort = () => {
      if (!settled) child.kill('SIGTERM');
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        child.kill('SIGTERM');
        finish(new Error('gmgn-cli aborted'));
        return;
      }
      opts.signal.addEventListener('abort', abort, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      opts.signal?.removeEventListener('abort', abort);
      finish(error);
    });
    child.on('exit', (code, exitSignal) => {
      opts.signal?.removeEventListener('abort', abort);
      if (opts.signal?.aborted) {
        finish(new Error('gmgn-cli aborted'));
        return;
      }
      if (code !== 0) {
        noteFailureFromOutput(stderr, stdout);
        finish(
          new Error(
            `gmgn-cli exited with code ${code ?? 'null'}${exitSignal ? ` signal ${exitSignal}` : ''}: ${stderr.trim().slice(0, 500)}`
          )
        );
        return;
      }
      finish(null, stdout);
    });
  });
}

export function runGmgnCliSync(opts: {
  args: string[];
  bin?: string;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  /** 全局桶令牌成本：signed 路由传 3，其余默认 1（同 runGmgnCliAsync）。 */
  cost?: number;
}): SpawnSyncReturns<string> {
  if (process.env.PILI_GMGN_RECOVERY_PAUSED === '1') {
    throw new Error('GMGN_COOLDOWN paused for newone self-holdings recovery');
  }
  assertGmgnAllowed();
  const bin = resolveGmgnCliBin(opts.bin);
  const env = buildGmgnCliEnv(opts.env);
  const r = spawnSync(bin, opts.args, {
    encoding: 'utf8',
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    env,
  });
  if (r.status !== 0) {
    noteFailureFromOutput(r.stderr || '', r.stdout || '');
  }
  return r;
}
