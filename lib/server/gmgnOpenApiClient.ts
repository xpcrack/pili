/**
 * GMGN OpenAPI multi-key client for pili (exist-auth routes).
 * Mirrors newone packages/adapters gmgn-client key pool + wallet_activity.
 * Prefer this over spawning gmgn-cli for concurrent activity pulls.
 */
import {
  createPrivateKey,
  sign as cryptoSign,
  randomUUID,
  constants as cryptoConstants,
} from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  acquireGmgnGlobalToken,
  assertGmgnAllowed,
  isGmgnBanMessage,
  noteGmgnBan,
  noteGmgnError,
} from '@/lib/server/gmgnRateLimit';
import { loadGmgnApiKeys } from '@/lib/server/gmgnCli';

const DEFAULT_HOST = 'https://openapi.gmgn.ai';
const DEFAULT_PROXY = 'http://127.0.0.1:7897';
const USER_AGENT = 'pili-gmgn-openapi/1.0';

export type GmgnQuery = Record<
  string,
  string | number | boolean | string[] | undefined | null
>;

export class GmgnApiError extends Error {
  status: number;
  apiCode: number | null;
  apiError: string | null;
  resetAtUnix: number | null;

  constructor(opts: {
    message: string;
    status: number;
    apiCode?: number | null;
    apiError?: string | null;
    resetAtUnix?: number | null;
  }) {
    super(opts.message);
    this.name = 'GmgnApiError';
    this.status = opts.status;
    this.apiCode = opts.apiCode ?? null;
    this.apiError = opts.apiError ?? null;
    this.resetAtUnix = opts.resetAtUnix ?? null;
  }
}

export function loadGmgnOpenApiKeys(): string[] {
  const out = loadGmgnApiKeys();
  if (!out.length) {
    throw new Error('No GMGN API keys. Set GMGN_API_KEY or ~/.config/gmgn/api_keys.list');
  }
  return out;
}

export function loadGmgnPrivateKey(): string | null {
  const env = process.env.GMGN_PRIVATE_KEY?.replace(/\\n/g, '\n')?.trim();
  if (env?.includes('PRIVATE KEY')) return env;
  const home = homedir();
  const pemPath = join(home, '.config/gmgn/keypair.pem');
  if (existsSync(pemPath)) {
    try {
      const text = readFileSync(pemPath, 'utf8');
      if (text.includes('PRIVATE KEY')) return text;
    } catch {
      /* ignore */
    }
  }
  const envPath = join(home, '.config/gmgn/.env');
  if (!existsSync(envPath)) return null;
  try {
    const text = readFileSync(envPath, 'utf8');
    for (const raw of text.split('\n')) {
      if (!raw.startsWith('GMGN_PRIVATE_KEY=')) continue;
      let v = raw.slice('GMGN_PRIVATE_KEY='.length).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      v = v.replace(/\\n/g, '\n').trim();
      if (v.includes('PRIVATE KEY')) return v;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Primary key for signed routes (pairs with private key). */
export function loadPrimaryApiKey(): string | null {
  const one = process.env.GMGN_API_KEY?.trim();
  if (one) return one;
  const envPath = join(homedir(), '.config/gmgn/.env');
  if (existsSync(envPath)) {
    try {
      const text = readFileSync(envPath, 'utf8');
      const m = text.match(/^GMGN_API_KEY=(.+)$/m);
      if (m?.[1]) return m[1].trim().replace(/^["']|["']$/g, '');
    } catch {
      /* ignore */
    }
  }
  try {
    const keys = loadGmgnOpenApiKeys();
    if (keys[0]) return keys[0]!;
  } catch {
    /* ignore */
  }
  return null;
}

/** 加载 key → 私钥 pem 映射（signed 路由多 key 轮询）。与 newone gmgn-client.ts 相同。 */
export function loadPrivateKeysByKey(): Record<string, string> {
  const out: Record<string, string> = {};
  const p = process.env.GMGN_KEYS_TO_PRIVS_FILE?.trim() || join(homedir(), '.config/gmgn/keys-to-privs.json');
  try {
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(raw)) {
        if (!k || !v) continue;
        const path = v.startsWith('~/') ? join(homedir(), v.slice(2)) : v;
        try {
          const pem = readFileSync(path, 'utf8').trim();
          if (pem.includes('PRIVATE KEY')) out[k] = pem;
        } catch { /* skip orphan */ }
      }
    }
  } catch { /* ignore */ }
  return out;
}

export function buildSignedMessage(
  subPath: string,
  queryParams: Record<string, string | string[] | number | boolean>,
  body: string,
  timestamp: number
): string {
  const sortedQs = Object.keys(queryParams)
    .sort()
    .flatMap((k) => {
      const ek = encodeURIComponent(k);
      const v = queryParams[k];
      if (Array.isArray(v)) {
        return [...v]
          .map(String)
          .sort()
          .map((item) => `${ek}=${encodeURIComponent(item)}`);
      }
      return [`${ek}=${encodeURIComponent(String(v))}`];
    })
    .join('&');
  return `${subPath}:${sortedQs}:${body}:${timestamp}`;
}

export function signMessage(message: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  const type = key.asymmetricKeyType;
  const msgBuf = Buffer.from(message, 'utf-8');
  if (type === 'ed25519') {
    return cryptoSign(null, msgBuf, key).toString('base64');
  }
  if (type === 'rsa') {
    return cryptoSign('sha256', msgBuf, {
      key,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }).toString('base64');
  }
  throw new Error(`Unsupported key type: ${type}`);
}

type KeyState = {
  cooldownUntil: number;
  nextAllowed: number;
  failStreak: number;
  inFlight: number;
  rate: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class GmgnKeyPool {
  keys: string[];
  private state = new Map<string, KeyState>();
  private cycle = 0;
  private successSinceUp = 0;
  private readonly rpsMin: number;
  private readonly rpsMax: number;
  private readonly cooldownBase: number;
  private readonly cooldownMax: number;
  private readonly maxInflight: number;
  /** Prefer this key for signed auth (pairs with private key). */
  primaryKey: string | null;
  /** Signed 路由可轮询的 key 集合（有配对私钥的 key）。 */
  private signedKeys: string[];
  stats = {
    acquire: 0,
    rate_limited: 0,
    success: 0,
    network_err: 0,
    wait_sec: 0,
  };

  constructor(opts?: {
    keys?: string[];
    rpsPerKey?: number;
    rpsMin?: number;
    rpsMax?: number;
    cooldownBase?: number;
    cooldownMax?: number;
    maxInflight?: number;
    primaryKey?: string | null;
    /** Signed 路由轮询池：有配对私钥的 key 子集 */
    signedKeys?: string[] | null;
  }) {
    this.keys = opts?.keys ?? loadGmgnOpenApiKeys();
    this.rpsMin = opts?.rpsMin ?? 0.2;
    this.rpsMax = opts?.rpsMax ?? 1.5;
    this.cooldownBase = opts?.cooldownBase ?? 30;
    this.cooldownMax = opts?.cooldownMax ?? 180;
    this.maxInflight = opts?.maxInflight ?? 1;
    this.primaryKey = opts?.primaryKey ?? loadPrimaryApiKey();
    // signed 池：显式传入 > 默认 = 全 keys（兼容旧行为）+ primaryKey 必在
    const sk = opts?.signedKeys ?? this.keys;
    this.signedKeys = sk.filter((k) => this.keys.includes(k));
    if (this.primaryKey && !this.signedKeys.includes(this.primaryKey)) {
      this.signedKeys.unshift(this.primaryKey);
    }
    const rps = opts?.rpsPerKey ?? Number(process.env.PILI_GMGN_RPS_PER_KEY || 0.8);
    const base = Date.now() / 1000;
    const gap = 1 / Math.max(rps, 0.05) / Math.max(this.keys.length, 1);
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[i]!;
      this.state.set(k, {
        cooldownUntil: 0,
        nextAllowed: base + i * gap,
        failStreak: 0,
        inFlight: 0,
        rate: rps,
      });
    }
  }

  private now(): number {
    return Date.now() / 1000;
  }

  private interval(key: string): number {
    const r = this.state.get(key)?.rate ?? this.rpsMin;
    const rate = Math.max(this.rpsMin, Math.min(this.rpsMax, r));
    return 1 / rate;
  }

  async acquire(opts?: {
    timeoutMs?: number;
    preferPrimary?: boolean;
    primaryOnly?: boolean;
    /** Signed 路由：在 signedKeys（有配对私钥的 key）池中轮询 */
    signed?: boolean;
  }): Promise<string> {
    const preferPrimary = opts?.preferPrimary === true;
    const primaryOnly = opts?.primaryOnly === true;
    const signed = opts?.signed === true;
    const pool = signed ? this.signedKeys : this.keys;
    if (primaryOnly && (!this.primaryKey || !this.keys.includes(this.primaryKey))) {
      // signed routes need the primary key; if missing from pool, try inject
      if (primaryOnly && this.primaryKey) {
        this.keys = [this.primaryKey, ...this.keys];
        if (!this.state.has(this.primaryKey)) {
          this.state.set(this.primaryKey, {
            cooldownUntil: 0,
            nextAllowed: this.now(),
            failStreak: 0,
            inFlight: 0,
            rate: Number(process.env.PILI_GMGN_RPS_PER_KEY || 0.8),
          });
        }
      } else {
        throw new Error('GMGN primary API key required for signed routes');
      }
    }
    if (signed && pool.length === 0) {
      throw new Error('GMGN private key required for signed routes');
    }
    const deadline =
      opts?.timeoutMs != null ? Date.now() + opts.timeoutMs : Date.now() + 60_000;
    let waited = 0;
    while (true) {
      assertGmgnAllowed();
      const now = this.now();
      if ((preferPrimary || primaryOnly) && this.primaryKey && this.keys.includes(this.primaryKey)) {
        const st = this.state.get(this.primaryKey)!;
        if (
          st.inFlight < this.maxInflight &&
          st.cooldownUntil <= now &&
          st.nextAllowed <= now
        ) {
          st.inFlight++;
          st.nextAllowed = now + this.interval(this.primaryKey);
          this.stats.acquire++;
          this.stats.wait_sec += waited;
          return this.primaryKey;
        }
        if (primaryOnly) {
          // wait for primary only
          const wait = Math.max(
            0.05,
            Math.min(2, Math.max(st.cooldownUntil, st.nextAllowed) - now)
          );
          if (Date.now() + wait * 1000 > deadline) {
            throw new Error('GmgnKeyPool.acquire timeout (primaryOnly)');
          }
          await sleep(wait * 1000);
          waited += wait;
          continue;
        }
      }
      const n = pool.length;
      for (let i = 0; i < n; i++) {
        const idx = this.cycle % n;
        this.cycle++;
        const k = pool[idx]!;
        const st = this.state.get(k);
        if (!st) continue;
        if (st.inFlight >= this.maxInflight) continue;
        if (st.cooldownUntil > now) continue;
        if (st.nextAllowed > now) continue;
        st.inFlight++;
        st.nextAllowed = now + this.interval(k);
        this.stats.acquire++;
        this.stats.wait_sec += waited;
        return k;
      }
      let earliest = now + 0.5;
      const states = signed
        ? pool.map((k) => this.state.get(k)).filter((s): s is KeyState => !!s)
        : primaryOnly && this.primaryKey
          ? [this.state.get(this.primaryKey)!]
          : [...this.state.values()];
      for (const st of states) {
        if (st.inFlight >= this.maxInflight) {
          earliest = Math.min(earliest, now + 0.05);
        } else {
          earliest = Math.min(earliest, Math.max(st.cooldownUntil, st.nextAllowed));
        }
      }
      const wait = Math.max(0.05, Math.min(2, earliest - now));
      if (Date.now() + wait * 1000 > deadline) {
        throw new Error('GmgnKeyPool.acquire timeout');
      }
      await sleep(wait * 1000);
      waited += wait;
    }
  }

  release(key: string): void {
    const st = this.state.get(key);
    if (st) st.inFlight = Math.max(0, st.inFlight - 1);
  }

  markSuccess(key: string): void {
    const st = this.state.get(key);
    if (!st) return;
    st.inFlight = Math.max(0, st.inFlight - 1);
    st.failStreak = 0;
    this.stats.success++;
    this.successSinceUp++;
    if (this.successSinceUp >= 20) {
      this.successSinceUp = 0;
      for (const s of this.state.values()) {
        s.rate = Math.min(this.rpsMax, s.rate + 0.05);
      }
    }
  }

  markRateLimit(key: string, waitSec?: number): number {
    const st = this.state.get(key);
    if (!st) return waitSec ?? this.cooldownBase;
    st.inFlight = Math.max(0, st.inFlight - 1);
    this.stats.rate_limited++;
    this.successSinceUp = 0;
    st.failStreak++;
    const wait =
      waitSec ??
      Math.min(this.cooldownMax, this.cooldownBase * 2 ** Math.min(st.failStreak - 1, 3));
    const now = this.now();
    const idx = Math.max(0, this.keys.indexOf(key));
    st.cooldownUntil = now + wait + idx * 0.35;
    st.nextAllowed = st.cooldownUntil;
    st.rate = Math.max(this.rpsMin, st.rate * 0.5);
    for (const [k, s] of this.state) {
      if (k !== key) s.rate = Math.max(this.rpsMin, s.rate * 0.9);
    }
    return wait;
  }

  markError(key: string): void {
    const st = this.state.get(key);
    if (!st) return;
    st.inFlight = Math.max(0, st.inFlight - 1);
    this.stats.network_err++;
    const now = this.now();
    st.nextAllowed = Math.max(st.nextAllowed, now + Math.min(2, this.interval(key)));
  }

  metrics() {
    const now = this.now();
    let cooling = 0;
    let inFlight = 0;
    let rateSum = 0;
    for (const st of this.state.values()) {
      if (st.cooldownUntil > now) cooling++;
      inFlight += st.inFlight;
      rateSum += st.rate;
    }
    return {
      ...this.stats,
      keys: this.keys.length,
      cooling,
      inFlight,
      avg_rps: this.keys.length ? rateSum / this.keys.length : 0,
    };
  }
}

function buildUrl(
  host: string,
  subPath: string,
  query: Record<string, string | string[] | number | boolean>
): string {
  const base = host.replace(/\/$/, '');
  const url = new URL(`${base}${subPath.startsWith('/') ? subPath : `/${subPath}`}`);
  for (const [k, v] of Object.entries(query)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const item of v) url.searchParams.append(k, String(item));
    } else {
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export class GmgnOpenApiClient {
  host: string;
  pool: GmgnKeyPool;
  privateKeyPem: string | null;
  /** key → 配对私钥 pem（signed 路由按 key 签名）。 */
  private privateKeysByKey: Record<string, string>;
  private timeoutMs: number;

  constructor(opts?: {
    host?: string;
    keys?: string[];
    rpsPerKey?: number;
    maxInflight?: number;
    timeoutMs?: number;
    privateKeyPem?: string | null;
    /** key → 私钥 pem 映射（signed 多 key 轮询） */
    privateKeysByKey?: Record<string, string> | null;
    primaryKey?: string | null;
  }) {
    this.host = (opts?.host ?? process.env.GMGN_OPENAPI_HOST ?? DEFAULT_HOST).replace(
      /\/$/,
      ''
    );
    // key → 私钥映射：显式传入 > 环境文件 > 兼容旧的单私钥
    const mapInput =
      opts?.privateKeysByKey !== undefined
        ? opts.privateKeysByKey
        : loadPrivateKeysByKey();
    this.privateKeysByKey = mapInput ?? {};
    this.privateKeyPem =
      opts?.privateKeyPem !== undefined ? opts.privateKeyPem : loadGmgnPrivateKey();
    // signed 池 = 有配对私钥的 key。无映射时退化为 primaryKey 单 key（旧行为）。
    let signedKeys: string[] | null = null;
    const mapKeys = Object.keys(this.privateKeysByKey);
    if (mapKeys.length > 0) {
      signedKeys = mapKeys;
    } else if (this.privateKeyPem) {
      const primary = opts?.primaryKey !== undefined ? opts.primaryKey : loadPrimaryApiKey();
      signedKeys = primary ? [primary] : null;
    }
    this.pool = new GmgnKeyPool({
      keys: opts?.keys,
      rpsPerKey: opts?.rpsPerKey,
      maxInflight: opts?.maxInflight ?? 1,
      primaryKey: opts?.primaryKey,
      signedKeys,
    });
    const timeoutMs =
      opts?.timeoutMs ?? Number(process.env.GMGN_FETCH_TIMEOUT_MS ?? 20_000);
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20_000;
  }

  async requestExist<T = unknown>(
    method: string,
    subPath: string,
    query: GmgnQuery = {}
  ): Promise<T> {
    return this.request<T>(method, subPath, query, { signed: false });
  }

  async requestSigned<T = unknown>(
    method: string,
    subPath: string,
    query: GmgnQuery = {}
  ): Promise<T> {
    const hasAnyKey =
      Object.keys(this.privateKeysByKey).length > 0 || !!this.privateKeyPem;
    if (!hasAnyKey) {
      throw new Error('GMGN_PRIVATE_KEY required for signed routes (holdings/…)');
    }
    return this.request<T>(method, subPath, query, { signed: true });
  }

  private async request<T = unknown>(
    method: string,
    subPath: string,
    query: GmgnQuery = {},
    opts: { signed: boolean }
  ): Promise<T> {
    assertGmgnAllowed();
    // signed 路由（wallet_holdings 等）多 key 轮询，按 3 倍加权扣令牌，
    // 与 newone 对齐（否则 pili 发 signed 请求比 newone 快 3 倍 → 打爆单 IP →
    // ban 死循环：冷却 60s 一到期队列积压立刻重打 → 再 ban）。
    await acquireGmgnGlobalToken(opts.signed ? 3 : 1);
    const key = await this.pool.acquire(opts.signed ? { signed: true } : {});
    let released = false;
    const markSuccess = () => {
      released = true;
      this.pool.markSuccess(key);
    };
    const markRateLimit = (waitSec?: number) => {
      released = true;
      return this.pool.markRateLimit(key, waitSec);
    };
    const markError = () => {
      released = true;
      this.pool.markError(key);
    };

    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const client_id = randomUUID();
      const q: Record<string, string | string[] | number | boolean> = {
        timestamp,
        client_id,
      };
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        q[k] = v as string | string[] | number | boolean;
      }
      const headers: Record<string, string> = {
        'X-APIKEY': key,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        // 禁止 keep-alive：每个请求新建 TCP 连接 → Clash GMGN轮询 给不同节点
        // → 不同出口 IP → 避免 IP 级限速（实测 load-balance 每连接轮询有效）
        'Connection': 'close',
      };
      if (opts.signed) {
        // 每把 key 用自己配对的私钥签名（GMGN key↔公钥 1:1 绑定）。
        // 优先 per-key 映射；无映射（兼容旧配置）回退统一 privateKeyPem。
        const keyPem =
          this.privateKeysByKey[key] ?? this.privateKeyPem ?? null;
        if (!keyPem) {
          throw new Error(
            `GMGN private key missing for signed key ${key.slice(0, 8)}…`
          );
        }
        const message = buildSignedMessage(subPath, q, '', timestamp);
        headers['X-Signature'] = signMessage(message, keyPem);
      }
      const url = buildUrl(this.host, subPath, q);
      // Node undici only honors HTTP(S)_PROXY when NODE_USE_ENV_PROXY=1
      process.env.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY || '1';
      if (!process.env.HTTPS_PROXY && !process.env.https_proxy) {
        process.env.HTTPS_PROXY = DEFAULT_PROXY;
        process.env.HTTP_PROXY = DEFAULT_PROXY;
        process.env.https_proxy = DEFAULT_PROXY;
        process.env.http_proxy = DEFAULT_PROXY;
      }
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        markError();
        throw e;
      }

      const resetHdr = res.headers.get('x-ratelimit-reset');
      const resetAtUnix = resetHdr ? Number.parseInt(resetHdr, 10) : null;
      const text = await res.text();
      let json: {
        code?: number;
        error?: string;
        message?: string;
        data?: unknown;
        reset_at?: number;
      };
      try {
        json = JSON.parse(text);
      } catch {
        markError();
        throw new GmgnApiError({
          message: `${method} ${subPath} HTTP ${res.status} non-JSON`,
          status: res.status,
        });
      }

      const apiError = json.error ?? null;
      const apiCode = json.code ?? null;
      const reset =
        (Number.isFinite(resetAtUnix) ? resetAtUnix : null) ??
        (typeof json.reset_at === 'number' ? json.reset_at : null);

      if (res.status === 429 || apiError === 'RATE_LIMIT_BANNED') {
        const msg = json.message || apiError || `HTTP ${res.status}`;
        if (
          apiError === 'RATE_LIMIT_BANNED' ||
          isGmgnBanMessage(msg) ||
          /IP is temporarily banned/i.test(msg)
        ) {
          noteGmgnBan(reset ? `${msg} reset_at=${reset}` : msg);
          markRateLimit(
            reset ? Math.max(5, reset - Math.floor(Date.now() / 1000)) : undefined
          );
          throw new GmgnApiError({
            message: `RATE_LIMIT_BANNED ${msg}`,
            status: 429,
            apiCode,
            apiError,
            resetAtUnix: reset,
          });
        }
        const wait =
          reset != null ? Math.max(5, reset - Math.floor(Date.now() / 1000)) : undefined;
        markRateLimit(wait);
        noteGmgnError(msg);
        throw new GmgnApiError({
          message: `RATE_LIMIT_EXCEEDED ${msg}`,
          status: 429,
          apiCode,
          apiError: apiError ?? 'RATE_LIMIT_EXCEEDED',
          resetAtUnix: reset,
        });
      }

      if (apiCode != null && apiCode !== 0) {
        markError();
        noteGmgnError(String(json.message || apiError || apiCode));
        throw new GmgnApiError({
          message: `${method} ${subPath} code=${apiCode} ${json.message || apiError || ''}`,
          status: res.status,
          apiCode,
          apiError,
          resetAtUnix: reset,
        });
      }

      markSuccess();
      return (json.data !== undefined ? json.data : json) as T;
    } finally {
      if (!released) this.pool.release(key);
    }
  }

  walletActivity(params: {
    chain: string;
    wallet: string;
    limit?: number;
    cursor?: string;
    token?: string;
    type?: string | string[];
  }) {
    const q: GmgnQuery = {
      chain: params.chain,
      wallet_address: params.wallet,
    };
    if (params.limit != null) q.limit = params.limit;
    if (params.cursor) q.cursor = params.cursor;
    if (params.token) q.token_address = params.token;
    if (params.type) q.type = params.type;
    return this.requestExist('GET', '/v1/user/wallet_activity', q);
  }

  walletHoldings(params: {
    chain: string;
    wallet: string;
    limit?: number;
    cursor?: string;
    order_by?: string;
    direction?: string;
    hide_closed?: boolean | string;
    hide_airdrop?: boolean | string;
  }) {
    const q: GmgnQuery = {
      chain: params.chain,
      wallet_address: params.wallet,
      limit: params.limit ?? 50,
      order_by: params.order_by ?? 'usd_value',
      direction: params.direction ?? 'desc',
      hide_closed:
        params.hide_closed === false || params.hide_closed === 'false'
          ? 'false'
          : 'true',
      hide_airdrop:
        params.hide_airdrop === true || params.hide_airdrop === 'true'
          ? 'true'
          : 'false',
    };
    if (params.cursor) q.cursor = params.cursor;
    return this.requestSigned('GET', '/v1/user/wallet_holdings', q);
  }
}

let sharedClient: GmgnOpenApiClient | null = null;

export function getGmgnOpenApiClient(): GmgnOpenApiClient {
  if (!sharedClient) {
    sharedClient = new GmgnOpenApiClient();
  }
  return sharedClient;
}

/** test helper */
export function resetGmgnOpenApiClientForTests() {
  sharedClient = null;
}
