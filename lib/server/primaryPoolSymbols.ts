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
  const newonePath = resolveNewoneDbPath();
  if (!existsSync(newonePath)) {
    return { ok: false, entered: false, error: 'newone_db_missing' };
  }

  let db: NewoneSqlite | null = null;
  try {
    db = openNewone(newonePath, false);
    if (
      db
        .prepare(`SELECT 1 FROM permanent_token_blocks WHERE address_lower = ? LIMIT 1`)
        .get(addressLower)
    ) {
      return { ok: true, entered: false, error: 'permanent_delete_blocked' };
    }

    // Prefer existing token by CA
    const existing = db
      .prepare(
        `SELECT id, chain FROM tokens
         WHERE address_lower = ?
         ORDER BY CASE chain WHEN 'robinhood' THEN 1 ELSE 0 END, id ASC
         LIMIT 1`,
      )
      .get(addressLower) as { id: number; chain: string } | undefined;

    let tokenId: number;
    if (existing?.id) {
      tokenId = existing.id;
      if (symbol) {
        db.prepare(
          `UPDATE tokens SET symbol = COALESCE(?, symbol) WHERE id = ?`,
        ).run(symbol, tokenId);
      }
      // Correct legacy mislabeled EVM rows: the old `0x → bsc` default wrote many
      // base/ethereum tokens into the table as bsc. If DexScreener says the real
      // dominant chain is something else, repoint this row's chain so downstream
      // market refresh / GMGN kline hit the right chain. (Solana rows are never
      // touched — address is unambiguous there.)
      if (
        isEvm &&
        !callerChain &&
        existing.chain !== chain &&
        chain !== 'bsc'
      ) {
        db.prepare(
          `UPDATE tokens SET chain = ? WHERE id = ?`,
        ).run(chain, tokenId);
        console.log(
          `[primary-pool] corrected chain ${existing.chain}→${chain} for ${addressLower}`,
        );
      }
    } else {
      db.prepare(
        `INSERT INTO tokens (chain, address, address_lower, symbol, name)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(chain, address_lower) DO UPDATE SET
           symbol = COALESCE(excluded.symbol, tokens.symbol)`,
      ).run(chain, address, addressLower, symbol);
      const row = db
        .prepare(`SELECT id FROM tokens WHERE chain = ? AND address_lower = ?`)
        .get(chain, addressLower) as { id: number } | undefined;
      if (!row?.id) return { ok: false, entered: false, error: 'token_insert_failed' };
      tokenId = row.id;
    }

    const membership = db
      .prepare(
        `SELECT id, state FROM token_pool_memberships
         WHERE token_id = ? AND pool_type = 'primary' AND strategy_id = 'default'`,
      )
      .get(tokenId) as { id: number; state: string } | undefined;

    const reasonJson = JSON.stringify({
      source: 'pili-social-ca',
      reason: params.reason || 'social_ca_mention',
      address,
      symbol,
    });

    if (membership) {
      if (membership.state === 'active') {
        // refresh cache
        if (cache) {
          cache.addresses.add(addressLower);
          if (symbol) cache.symbols.add(normalizePoolSymbolKey(symbol));
        }
        return { ok: true, entered: false, tokenId };
      }
      // excluded/exited → reactivate for social CA (user rule: CA not in pool → import)
      db.prepare(
        `UPDATE token_pool_memberships SET
           state = 'active',
           entered_at = datetime('now'),
           exited_at = NULL,
           reason_json = ?,
           last_evaluated_at = datetime('now'),
           updated_at = datetime('now')
         WHERE id = ?`,
      ).run(reasonJson, membership.id);
    } else {
      db.prepare(
        `INSERT INTO token_pool_memberships (
           token_id, pool_type, strategy_id, state,
           source_event_id, reason_json, rule_version, last_evaluated_at
         ) VALUES (?, 'primary', 'default', 'active', NULL, ?, 'pili-social-ca', datetime('now'))`,
      ).run(tokenId, reasonJson);
    }

    if (cache) {
      cache.addresses.add(addressLower);
      if (symbol) cache.symbols.add(normalizePoolSymbolKey(symbol));
    } else {
      cache = null; // force reload next read
    }
    return { ok: true, entered: true, tokenId };
  } catch (err) {
    return {
      ok: false,
      entered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
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
