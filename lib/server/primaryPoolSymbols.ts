/**
 * newone 一级池字典 — 裸 ticker / 官方推特 handle / CA 入池。
 * 只认 tokens.symbol（小写）与 tokens.twitter_url 解析出的 handle。
 */
import 'server-only';

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { pushBark } from '@/lib/server/barkNotify';
import { resolveDexScreenerChainForAddress } from '@/lib/server/dexscreener';

const require = createRequire(import.meta.url);

const CACHE_TTL_MS = 60_000;

type NewoneSqlite = {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
  close(): void;
};

export type PrimaryPoolTokenRef = {
  symbol: string | null;
  address: string;
  chain: string;
};

/** Lookup result for a bare ticker → address resolution. */
export type PrimaryPoolSymbolLookup = {
  address: string;
  chain: string;
};

let cache: {
  loadedAtMs: number;
  symbols: Set<string>;
  addresses: Set<string>;
  officialTwitterByHandle: Map<string, PrimaryPoolTokenRef[]>;
  symbolToAddress: Map<string, PrimaryPoolSymbolLookup>;
} | null = null;

export function resolveNewoneDbPath() {
  const fromEnv = (process.env.NEWONE_DB_PATH || process.env.PILI_NEWONE_DB_PATH || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), '..', 'newone', 'data', 'newone.sqlite');
}

/**
 * newone ingest API base. Same-machine default needs no token (NEWONE_HTTP_ACCESS_TOKEN
 * only guards the外网 Cloudflare Tunnel); NEWONE_API_BASE_URL / NEWONE_API_TOKEN exist
 * for future cross-machine deploys.
 */
export function resolveNewoneApiBase(): string {
  const fromEnv = (process.env.NEWONE_API_BASE_URL || '').trim();
  return (fromEnv || 'http://127.0.0.1:3200').replace(/\/+$/, '');
}

function isBunRuntime() {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

function openNewone(newonePath: string, readonly: boolean): NewoneSqlite {
  if (isBunRuntime()) {
    const { Database } = require('bun:sqlite') as {
      Database: new (filename: string, opts?: { readonly?: boolean }) => NewoneSqlite;
    };
    return new Database(newonePath, { readonly });
  }
  const BetterSqlite3 = require('better-sqlite3') as new (
    filename: string,
    opts?: { readonly?: boolean }
  ) => NewoneSqlite;
  return new BetterSqlite3(newonePath, { readonly });
}

/** Normalize pool symbol for bare-ticker match: trim, strip leading $, lower. */
export function normalizePoolSymbolKey(raw: string | null | undefined): string {
  let s = (raw || '').trim();
  if (!s) return '';
  if (s.startsWith('$')) s = s.slice(1).trim();
  return s.toLowerCase();
}

/** Parse x.com / twitter.com URL or bare @handle → lowercased handle. */
export function parseTwitterHandleFromUrl(raw: string | null | undefined): string | null {
  const s = (raw || '').trim();
  if (!s) return null;
  if (s.startsWith('@')) {
    const h = s.slice(1).trim().toLowerCase();
    return /^[a-z0-9_]{1,15}$/.test(h) ? h : null;
  }
  try {
    const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const u = new URL(withProto);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'x.com' && host !== 'twitter.com' && host !== 'mobile.twitter.com') {
      return null;
    }
    const segs = u.pathname.split('/').filter(Boolean);
    // 一条具体推文 (x.com/<user>/status/<id> 或 x.com/i/status/<id>) 不能作为账号主页
    // 用来识别代币提及——否则会把推文里的 @<user> 误判成提及该代币。
    if (segs.length >= 2 && (segs[1] === 'status' || (segs[0] === 'i' && segs[1] === 'status'))) {
      return null;
    }
    const seg = segs[0] || '';
    const h = seg.trim().toLowerCase();
    if (!h || ['i', 'home', 'share', 'intent', 'search'].includes(h)) return null;
    return /^[a-z0-9_]{1,15}$/.test(h) ? h : null;
  } catch {
    return null;
  }
}

function loadPrimaryPoolFromDb(newonePath: string): {
  symbols: Set<string>;
  addresses: Set<string>;
  officialTwitterByHandle: Map<string, PrimaryPoolTokenRef[]>;
  symbolToAddress: Map<string, PrimaryPoolSymbolLookup>;
} {
  const symbols = new Set<string>();
  const addresses = new Set<string>();
  const officialTwitterByHandle = new Map<string, PrimaryPoolTokenRef[]>();
  const symbolToAddress = new Map<string, PrimaryPoolSymbolLookup>();
  if (!existsSync(newonePath)) {
    console.warn(`[primaryPoolSymbols] newone db missing: ${newonePath}`);
    return { symbols, addresses, officialTwitterByHandle, symbolToAddress };
  }

  let db: NewoneSqlite | null = null;
  try {
    db = openNewone(newonePath, true);
    const rows = db
      .prepare(
        `SELECT t.symbol AS symbol,
                t.address AS address,
                t.chain AS chain,
                t.twitter_url AS twitter_url
         FROM token_pool_memberships m
         JOIN tokens t ON t.id = m.token_id
         WHERE m.pool_type = 'primary'
           AND m.state = 'active'
         ORDER BY CASE t.chain
           WHEN 'solana' THEN 0
           WHEN 'bsc' THEN 1
           WHEN 'base' THEN 2
           WHEN 'ethereum' THEN 3
           ELSE 4
         END, t.id ASC`,
      )
      .all() as Array<{
      symbol?: string;
      address?: string;
      chain?: string;
      twitter_url?: string | null;
    }>;

    for (const row of rows) {
      const key = normalizePoolSymbolKey(row.symbol);
      if (key) symbols.add(key);
      const addr = (row.address || '').trim();
      const addrLower = addr.toLowerCase();
      if (addrLower) addresses.add(addrLower);
      // Prefer first entry per symbol; prefer solana over others
      if (key && addr && !symbolToAddress.has(key)) {
        symbolToAddress.set(key, {
          address: addr,
          chain: (row.chain || '').trim() || 'solana',
        });
      }
      const handle = parseTwitterHandleFromUrl(row.twitter_url);
      if (handle && addr) {
        const list = officialTwitterByHandle.get(handle) || [];
        if (!list.some((x) => x.address.toLowerCase() === addrLower)) {
          list.push({
            symbol: row.symbol ? String(row.symbol).trim() : null,
            address: addr,
            chain: (row.chain || '').trim() || 'unknown',
          });
          officialTwitterByHandle.set(handle, list);
        }
      }
    }
  } catch (err) {
    console.warn(
      '[primaryPoolSymbols] load failed:',
      err instanceof Error ? err.message : err,
    );
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
  return { symbols, addresses, officialTwitterByHandle, symbolToAddress };
}

function getCached(opts?: { forceRefresh?: boolean; newonePath?: string }) {
  const now = Date.now();
  if (
    !opts?.forceRefresh &&
    !opts?.newonePath &&
    cache &&
    now - cache.loadedAtMs < CACHE_TTL_MS
  ) {
    return cache;
  }
  const newonePath = opts?.newonePath || resolveNewoneDbPath();
  const loaded = loadPrimaryPoolFromDb(newonePath);
  const next = { loadedAtMs: now, ...loaded };
  if (!opts?.newonePath) {
    cache = next;
  }
  return next;
}

/**
 * Lowercased primary-pool symbols for bare ticker allowlist.
 * Cached ~60s. Empty set if db missing (bare tickers then all drop — fail closed).
 */
export function getPrimaryPoolSymbolAllowlist(opts?: {
  forceRefresh?: boolean;
  newonePath?: string;
}): Set<string> {
  return getCached(opts).symbols;
}

/** Look up a normalized symbol → {address, chain} from primary pool. Returns null if not found. */
export function lookupPrimaryPoolAddressBySymbol(symbol: string, opts?: {
  forceRefresh?: boolean;
  newonePath?: string;
}): PrimaryPoolSymbolLookup | null {
  const key = normalizePoolSymbolKey(symbol);
  if (!key) return null;
  return getCached(opts).symbolToAddress.get(key) ?? null;
}

/** Lowercased primary-pool contract addresses. */
export function getPrimaryPoolAddressSet(opts?: {
  forceRefresh?: boolean;
  newonePath?: string;
}): Set<string> {
  return getCached(opts).addresses;
}

/**
 * Official twitter handle (lower) → primary-pool tokens.
 * Empty until tokens.twitter_url is populated.
 */
export function getPrimaryPoolOfficialTwitterMap(opts?: {
  forceRefresh?: boolean;
  newonePath?: string;
}): Map<string, PrimaryPoolTokenRef[]> {
  return getCached(opts).officialTwitterByHandle;
}

/**
 * Ensure CA is an active primary-pool member in newone.
 * Returns true if newly entered or reactivated; false if already active / failed.
 *
 * Implementation goes through newone's ingest API (POST /api/events, event_type
 * `social.mention`) instead of writing newone's sqlite directly. The API side owns
 * the single guarded write path — permanent-delete blacklist, token dedupe,
 * membership create/reactivate — so this writer can never drift from the official
 * `ingestEvent()` rules again (the 2026-09-17 reintroduction of a permanently
 * deleted CA happened exactly because this file used to hand-INSERT memberships).
 * Read-only dictionary queries (loadPrimaryPoolFromDb below) still hit sqlite.
 *
 * No sqlite fallback on API failure: falling back would resurrect the drifting
 * writer. Failures are logged loudly; next mention retries.
 */
export async function ensurePrimaryPoolForAddress(params: {
  address: string;
  symbol?: string | null;
  chain?: string | null;
  reason?: string;
}): Promise<{ ok: boolean; entered: boolean; tokenId?: number; error?: string }> {
  const address = (params.address || '').trim();
  if (!address) return { ok: false, entered: false, error: 'empty_address' };
  const addressLower = address.toLowerCase();
  const symbol = (params.symbol || '').trim() || null;
  // Solana addresses are unambiguous. An EVM 0x address is shared across
  // bsc/ethereum/base/etc. as independent contracts — `0x → bsc` was a wrong
  // guess that mislabeled every base/ethereum token as bsc (e.g. QUID on base).
  // When the caller did not pin a chain, resolve the real one from DexScreener's
  // highest-liquidity pair; only fall back to the old default if that lookup fails
  // (unresolved EVM stays a soft `bsc` for legacy compat — logged below).
  const callerChain = (params.chain || '').trim();
  const isEvm = addressLower.startsWith('0x');
  let chain = callerChain;
  if (!chain) {
    if (isEvm) {
      const resolved = await resolveDexScreenerChainForAddress(address);
      chain = resolved || 'bsc';
      if (!resolved) {
        console.warn(
          `[primary-pool] EVM chain unresolved for ${addressLower}; defaulting to bsc (may mislabel base/eth)`,
        );
      }
    } else {
      chain = 'solana';
    }
  }

  // The API needs an explicit chain — pili resolves it, newone trusts the provider
  // (its ensureToken is chain-scoped and never repoints an existing row's chain).
  //
  // dedupe_key is hour-bucketed, not fixed: a fixed key would collapse every future
  // mention of the same CA+reason into that one historical event, so a later
  // re-entry never registers as its own event. Hour granularity still dedupes a
  // single spam burst while letting a genuinely new mention land as a new event.
  const reason = params.reason || 'social_ca_mention';
  const hourBucket = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const dedupeKey = `social.mention:${chain}:${addressLower}:${reason}:${hourBucket}`;
  const body = {
    event_type: 'social.mention',
    occurred_at: new Date().toISOString(),
    dedupe_key: dedupeKey,
    chain,
    token_address: address,
    symbol,
    provider: 'pili',
    payload: {
      source: 'pili-social-ca',
      reason,
      address,
      symbol,
    },
  };

  try {
    const base = resolveNewoneApiBase();
    const token = (process.env.NEWONE_API_TOKEN || '').trim();
    const res = await fetch(`${base}/api/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) {
      const snippet = text.slice(0, 300);
      console.warn(
        `[primary-pool] ingest API ${res.status} for ${addressLower} reason=${params.reason || 'social_ca_mention'}: ${snippet}`,
      );
      return { ok: false, entered: false, error: `newone_api_${res.status}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn(
        `[primary-pool] ingest API non-JSON response for ${addressLower}: ${text.slice(0, 300)}`,
      );
      return { ok: false, entered: false, error: 'newone_api_bad_json' };
    }
    const first = (parsed as { results?: unknown[] }).results?.[0];
    if (!first || typeof first !== 'object') {
      console.warn(
        `[primary-pool] ingest API empty result for ${addressLower}: ${text.slice(0, 300)}`,
      );
      return { ok: false, entered: false, error: 'newone_api_no_result' };
    }
    const entry = first as {
      error?: string;
      token_id?: number;
      pool_entered?: boolean;
      pool_membership_id?: number | null;
    };
    if (typeof entry.error === 'string' && entry.error) {
      console.warn(
        `[primary-pool] ingest API rejected ${addressLower} reason=${params.reason || 'social_ca_mention'}: ${entry.error}`,
      );
      return { ok: false, entered: false, error: entry.error };
    }
    const tokenId = typeof entry.token_id === 'number' ? entry.token_id : undefined;
    const membershipId = entry.pool_membership_id ?? 0;
    if (entry.pool_entered === true) {
      cache = null; // force reload next read so addresses/symbols sets see the newcomer
      return { ok: true, entered: true, tokenId };
    }
    if (membershipId === 0) {
      // Guarded by newone: permanent-delete blacklist (or xstocks). Kept for log
      // compatibility with the old direct-sqlite writer.
      return { ok: true, entered: false, error: 'permanent_delete_blocked' };
    }
    // Already active in pool (created/reactivated earlier).
    if (cache) {
      cache.addresses.add(addressLower);
      if (symbol) cache.symbols.add(normalizePoolSymbolKey(symbol));
    }
    return { ok: true, entered: false, tokenId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[primary-pool] ingest API call failed for ${addressLower} reason=${params.reason || 'social_ca_mention'}: ${message}`,
    );
    return { ok: false, entered: false, error: message };
  }
}
/** Best-effort Bark (dual device if BARK_URLS / default). */
export async function barkPrimaryPoolAlert(title: string, body: string) {
  await pushBark({ title, body, group: 'pili-pool' });
}

/**
 * 官方推特撞车：同一批 CA 只 Bark 一次。
 * key = 排序后的 address 集合；同一集合后续命中静默（进程内记忆）。
 * 换进程/重启后会再报一次。
 */
const officialTwitterCollisionAlertedKeys = new Set<string>();

export function officialTwitterCollisionKey(
  tokens: Array<{ address?: string | null }>,
): string {
  const set = new Set<string>();
  for (const t of tokens) {
    const a = (t.address || '').trim().toLowerCase();
    if (a) set.add(a);
  }
  return Array.from(set).sort().join('|');
}

/**
 * 同一批 CA 首次撞车才推送；已报过的集合直接 skip。
 * 返回 true = 本次发了 Bark。
 */
export async function barkOfficialTwitterCollisionOnce(params: {
  handle: string;
  tokens: Array<{ symbol?: string | null; address?: string | null }>;
}): Promise<boolean> {
  const handle = (params.handle || '').trim().toLowerCase().replace(/^@/, '');
  const key = officialTwitterCollisionKey(params.tokens);
  if (!key) return false;
  if (officialTwitterCollisionAlertedKeys.has(key)) return false;
  officialTwitterCollisionAlertedKeys.add(key);

  const body = `@${handle || '?'} → ${params.tokens
    .map((t) => `${t.symbol || '?'} ${t.address || ''}`)
    .join(' | ')}`;
  await barkPrimaryPoolAlert('一级池官方推特撞车', body);
  return true;
}

/** Test helper — clear in-memory collision dedupe. */
export function clearOfficialTwitterCollisionAlertCache() {
  officialTwitterCollisionAlertedKeys.clear();
}

/** Test helper — clear in-memory cache. */
export function clearPrimaryPoolSymbolCache() {
  cache = null;
}
