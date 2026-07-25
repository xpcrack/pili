/**
 * newone 一级池 symbol 字典 — 裸 ticker 社媒识别白名单。
 * 只认 tokens.symbol（小写）；不扩 name / 别名。
 */
import 'server-only';

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

const CACHE_TTL_MS = 60_000;

type NewoneSqlite = {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
};

let cache: { loadedAtMs: number; symbols: Set<string> } | null = null;

export function resolveNewoneDbPath() {
  const fromEnv = (process.env.NEWONE_DB_PATH || process.env.PILI_NEWONE_DB_PATH || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), '..', 'newone', 'data', 'newone.sqlite');
}

function isBunRuntime() {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

function openNewoneReadonly(newonePath: string): NewoneSqlite {
  if (isBunRuntime()) {
    const { Database } = require('bun:sqlite') as {
      Database: new (filename: string, opts?: { readonly?: boolean }) => NewoneSqlite;
    };
    return new Database(newonePath, { readonly: true });
  }
  const BetterSqlite3 = require('better-sqlite3') as new (
    filename: string,
    opts?: { readonly?: boolean }
  ) => NewoneSqlite;
  return new BetterSqlite3(newonePath, { readonly: true });
}

/** Normalize pool symbol for bare-ticker match: trim, strip leading $, lower. */
export function normalizePoolSymbolKey(raw: string | null | undefined): string {
  let s = (raw || '').trim();
  if (!s) return '';
  if (s.startsWith('$')) s = s.slice(1).trim();
  return s.toLowerCase();
}

function loadPrimaryPoolSymbolsFromDb(newonePath: string): Set<string> {
  const symbols = new Set<string>();
  if (!existsSync(newonePath)) {
    console.warn(`[primaryPoolSymbols] newone db missing: ${newonePath}`);
    return symbols;
  }

  let db: NewoneSqlite | null = null;
  try {
    db = openNewoneReadonly(newonePath);
    const rows = db
      .prepare(
        `SELECT t.symbol AS symbol
         FROM token_pool_memberships m
         JOIN tokens t ON t.id = m.token_id
         WHERE m.pool_type = 'primary'
           AND m.state = 'active'
           AND t.symbol IS NOT NULL
           AND trim(t.symbol) != ''`,
      )
      .all() as Array<{ symbol?: string }>;

    for (const row of rows) {
      const key = normalizePoolSymbolKey(row.symbol);
      if (key) symbols.add(key);
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
  return symbols;
}

/**
 * Lowercased primary-pool symbols for bare ticker allowlist.
 * Cached ~60s. Empty set if db missing (bare tickers then all drop — fail closed).
 */
export function getPrimaryPoolSymbolAllowlist(opts?: {
  forceRefresh?: boolean;
  newonePath?: string;
}): Set<string> {
  const now = Date.now();
  if (
    !opts?.forceRefresh &&
    !opts?.newonePath &&
    cache &&
    now - cache.loadedAtMs < CACHE_TTL_MS
  ) {
    return cache.symbols;
  }

  const newonePath = opts?.newonePath || resolveNewoneDbPath();
  const symbols = loadPrimaryPoolSymbolsFromDb(newonePath);
  if (!opts?.newonePath) {
    cache = { loadedAtMs: now, symbols };
  }
  return symbols;
}

/** Test helper — clear in-memory cache. */
export function clearPrimaryPoolSymbolCache() {
  cache = null;
}
