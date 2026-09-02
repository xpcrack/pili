import 'server-only';

/**
 * fomo.family API client.
 *
 * 职责：维护 JWT（从 app_state 读取，admin 端点写入）、独立节流（与 GMGN 桶无关）、
 * 封装已验证的端点。所有上游请求走本文件，禁止在 feature 代码里裸 fetch 到 prod-api.fomo.family。
 *
 * 节流约定（明确定义，独立于 GMGN）：
 *   - 并发 2-3（FOMO 端风控敏感，单用户配额有限）
 *   - 任务间随机间隔
 *   - 单 CA / 用户级数据本地缓存（见 CACHE_TTL_MS）
 *   - 超时 15s
 */

const BASE_URL = 'https://prod-api.fomo.family';
const TIMEOUT_MS = 15_000;
const DEFAULT_CONCURRENCY = 3;

/** FOMO networkId → pili ChainType。 */
export function networkIdToChain(networkId: number | undefined | null): string | undefined {
  switch (networkId) {
    case 1:
      return 'ethereum';
    case 56:
      return 'bsc';
    case 8453:
      return 'base';
    case 1399811149:
      return 'solana';
    default:
      return undefined;
  }
}

// --- 本地缓存（进程内） ---
const CACHE_TTL_MS = 30_000; // 单 CA 数据缓存
const PNL_CACHE_TTL_MS = 5 * 60_000; // 用户 7d PnL 缓存

const memoryCache = new Map<string, { at: number; value: unknown }>();

function cacheGet<T>(key: string, ttlMs: number): T | null {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > ttlMs) {
    memoryCache.delete(key);
    return null;
  }
  return entry.value as T;
}

function cacheSet(key: string, value: unknown) {
  memoryCache.set(key, { at: Date.now(), value });
}

// --- JWT 管理（从 app_state 读取，admin 端点写入） ---
const FOMO_JWT_STATE_KEY = 'fomo_jwt';

let inMemoryJwt: string | null = null;

function setInMemoryJwt(value: string | null) {
  inMemoryJwt = value;
}

// 惰性导入 getDb 以避免循环依赖（getDb 在 sqlite.ts，sqlite 不 import 本文件）。
async function stateJwt(): Promise<string | null> {
  if (inMemoryJwt) return inMemoryJwt;
  const { getDb } = await import('@/lib/server/sqlite');
  const row = getDb()
    .prepare('SELECT value_json FROM app_state WHERE key = ? LIMIT 1')
    .get(FOMO_JWT_STATE_KEY) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value_json) as { jwt?: string };
    setInMemoryJwt(parsed.jwt ?? null);
    return parsed.jwt ?? null;
  } catch {
    return null;
  }
}

export async function setFomoJwt(value: string) {
  setInMemoryJwt(value);
  const { getDb, withSqliteBusyRetry } = await import('@/lib/server/sqlite');
  const now = Date.now();
  withSqliteBusyRetry(() => {
    getDb()
      .prepare(
        `INSERT INTO app_state (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(FOMO_JWT_STATE_KEY, JSON.stringify({ jwt: value, at: now }), now);
  }, { label: 'setFomoJwt' });
}

// --- 节流（独立于 GMGN 桶；FOMO 端敏感，宽松限速即可） ---
// CF bot 检测：datacenter 出口密集请求会触发临时封锁（HTML 403，几十秒~几分钟自动解除）。
// 08-28 实测：数秒内连发 7 个请求即触发；45s 轮询单用户安全。
const CF_BLOCK_COOLDOWN_MS = 5 * 60_000;
let cfBlockedUntil = 0;

interface Gate {
  active: number;
  queue: Array<() => void>;
  maxConcurrent: number;
  lastRequestAt: number;
  minGapMs: number;
}

function createGate(maxConcurrent: number, minGapMs: number): Gate {
  return { active: 0, queue: [], maxConcurrent, lastRequestAt: 0, minGapMs };
}

const gate = createGate(DEFAULT_CONCURRENCY, 0);

function scheduleNext(): void {
  if (gate.active >= gate.maxConcurrent) return;
  const next = gate.queue.shift();
  if (!next) return;
  gate.active += 1;
  next();
}

function acquire(): Promise<void> {
  return new Promise((resolve) => {
    gate.queue.push(() => {
      // 随机小间隔，避免 FOMO 端识别为脚本化请求。
      const gap = gate.lastRequestAt
        ? Math.max(0, gate.minGapMs - (Date.now() - gate.lastRequestAt))
        : 0;
      gate.lastRequestAt = Date.now();
      setTimeout(() => {
        resolve();
        scheduleNext();
      }, gap + Math.floor(Math.random() * 500));
    });
    scheduleNext();
  });
}

async function apiCall<T>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<T> {
  const jwt = await stateJwt();
  if (!jwt) {
    throw new FomoApiError('FOMO JWT 未配置', 'no_jwt');
  }

  // CF 冷却期内直接短路，不发出请求（避免延长封锁）。
  if (Date.now() < cfBlockedUntil) {
    throw new FomoApiError('FOMO CF 冷却中，跳过请求', 'cf_cooldown');
  }

  await acquire();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      ...init.headers,
    };

    const response = await fetch(BASE_URL + path, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // Cloudflare 拦截页是 HTML：临时封锁（几十秒~几分钟自动解除），立即冷却停止轰炸。
      if (response.status === 403 && /cloudflare|attention required/i.test(text)) {
        cfBlockedUntil = Date.now() + CF_BLOCK_COOLDOWN_MS;
        throw new FomoApiError('FOMO 被 Cloudflare 临时拦截，冷却 5 分钟', 'cf_blocked', 403);
      }
      throw new FomoApiError(`FOMO 返回非 JSON (${response.status})`, 'bad_response', undefined, text.slice(0, 200));
    }

    // 过期 JWT 穿透 CF 后返回应用层 401 JSON。
    if (response.status === 401) {
      throw new FomoApiError('FOMO JWT 已过期', 'jwt_expired');
    }
    if (!response.ok) {
      throw new FomoApiError(
        `FOMO 请求失败 (${response.status})`,
        'http_error',
        response.status,
        String(payload)
      );
    }

    const envelope = payload as { success?: boolean; message?: string; responseObject?: T; statusCode?: number };
    if (envelope?.success === false) {
      throw new FomoApiError(envelope.message ?? 'FOMO 返回失败', 'api_error', envelope.statusCode);
    }

    return (envelope?.responseObject ?? payload) as T;
  } finally {
    clearTimeout(timeout);
    gate.active -= 1;
    scheduleNext();
  }
}

export class FomoApiError extends Error {
  readonly code: string;
  readonly statusCode?: number;
  readonly body?: string;
  constructor(message: string, code: string, statusCode?: number, body?: string) {
    super(message);
    this.name = 'FomoApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.body = body;
  }
}

// --- 端点封装（全部经 apiCall，已实测） ---

export interface FomoHolder {
  user: {
    id: string;
    address: string;
    evmAddress?: string;
    displayName?: string;
    userHandle?: string;
    swapCount?: number;
    numTrades?: number;
    totalVolume?: number;
    followers?: number;
    profilePictureLink?: string;
  };
  humanAmount?: string;
  value?: number;
  pnl?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  costBasis?: number;
  averageEntryPrice?: number;
  averageHoldTimeSeconds?: number;
  isDev?: boolean;
}

export async function fetchHodlersTop(
  tokens: Array<{ address: string; networkId: number }>
): Promise<{ totalHolders?: number; topHolders?: FomoHolder[] }> {
  const cacheKey = `hodlers:${tokens.map((t) => `${t.networkId}:${t.address}`).join(',')}`;
  const cached = cacheGet<{ totalHolders?: number; topHolders?: FomoHolder[] }>(cacheKey, CACHE_TTL_MS);
  if (cached) return cached;
  const result = await apiCall<{ totalHolders?: number; topHolders?: FomoHolder[] }>(
    '/hodlers/top',
    {
      method: 'POST',
      body: { tokens },
    }
  );
  cacheSet(cacheKey, result);
  return result;
}

export interface FomoClosedTrade {
  trade: {
    id: string;
    tokenAddress: string;
    createdAt: number;
    closedAt: number;
    humanTokenAmount?: number;
    avgEntryPrice?: number;
    avgExitPrice?: number;
    realizedPnlUsd?: number;
    sumSwapOpen?: number;
    sumSwapClosed?: number;
    networkId?: number;
    tokenMetadata?: {
      symbol?: string;
      currentPrice?: number;
      imageLargeUrl?: string;
    };
  };
  comment?: string;
  swaps?: Array<Record<string, unknown>>;
  transfers?: Array<Record<string, unknown>>;
  type?: string;
  verified?: boolean;
}

export async function fetchUserTrades(params: {
  userId: string;
  orderBy?: 'closedAt';
  lastTradeId?: string;
  tokenAddress?: string;
}): Promise<{
  activeTrades?: unknown[];
  closedTrades?: FomoClosedTrade[];
  hasNextPage?: boolean;
  closedCount?: number;
}> {
  const query = new URLSearchParams({
    userId: params.userId,
    orderBy: params.orderBy ?? 'closedAt',
  });
  if (params.lastTradeId) query.set('lastTradeId', params.lastTradeId);
  if (params.tokenAddress) query.set('tokenAddress', params.tokenAddress);
  return apiCall(`/trades?${query.toString()}`);
}

export async function fetchUserByHandle(handle: string): Promise<{ user?: { id: string } }> {
  const encoded = encodeURIComponent(handle);
  const cacheKey = `userHandle:${encoded}`;
  const cached = cacheGet<{ user?: { id: string } }>(cacheKey, CACHE_TTL_MS);
  if (cached) return cached;
  const result = await apiCall<{ user?: { id: string } }>(`/v2/users/userHandle/${encoded}`);
  cacheSet(cacheKey, result);
  return result;
}

export async function fetchUserBalances(userId: string): Promise<unknown> {
  return apiCall(`/v2/users/${userId}/balances`);
}

export async function fetchAggregatedSnapshotById(userId: string): Promise<unknown> {
  return apiCall(`/v2/userTokens/aggregatedSnapshotById?userId=${encodeURIComponent(userId)}`);
}

export async function fetchFeedsTradingActivity(params: {
  limit?: number;
  lastId?: string;
  minEquity?: number;
  minMarketCap?: number;
  maxMarketCap?: number;
}): Promise<{ items?: unknown[]; hasNextPage?: boolean }> {
  const query = new URLSearchParams({ limit: String(params.limit ?? 50) });
  if (params.lastId) query.set('lastId', params.lastId);
  if (params.minEquity != null) query.set('minEquity', String(params.minEquity));
  if (params.minMarketCap != null) query.set('minMarketCap', String(params.minMarketCap));
  if (params.maxMarketCap != null) query.set('maxMarketCap', String(params.maxMarketCap));
  return apiCall(`/feed/tradingActivity?${query.toString()}`);
}

export async function fetchFuzzySearch(handle: string): Promise<unknown> {
  return apiCall(`/v2/users/fuzzy-search?q=${encodeURIComponent(handle)}`);
}
