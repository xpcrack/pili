/**
 * Mirror Feishu enablement (via newone sources.disabled) into pili
 * tracked_users / tracked_addresses.monitoring_enabled.
 *
 * Policy A: disabled still searchable in history; default Feed + collectors
 * only follow monitoring_enabled=1.
 *
 * Self wallets (newone wallets.is_self=1, fallback sources label=self) are
 * always forced monitoring_enabled=1 even when sources.disabled=1.
 */
import 'server-only';

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { getDb } from '@/lib/server/sqlite';

const require = createRequire(import.meta.url);

export type FeishuEnablementSyncResult = {
  ok: boolean;
  newonePath: string;
  enabledAddressCount: number;
  selfAddressCount: number;
  selfForcedEnabled: number;
  addressesEnabled: number;
  addressesDisabled: number;
  usersEnabled: number;
  usersDisabled: number;
  error?: string;
};

type NewoneSqlite = {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
};

function resolveNewoneDbPath() {
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

function tableExists(db: NewoneSqlite, name: string) {
  const rows = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
    .all(name) as Array<{ ok?: number }>;
  return Boolean(rows[0]?.ok);
}

function collectLowerAddresses(rows: Array<{ address?: string; external_id?: string }>) {
  const set = new Set<string>();
  for (const row of rows) {
    const lower = String(row.address || row.external_id || '')
      .trim()
      .toLowerCase();
    if (lower) set.add(lower);
  }
  return set;
}

function readEnabledWalletLowers(db: NewoneSqlite): Set<string> {
  const rows = db
    .prepare(`SELECT external_id FROM sources WHERE kind = 'wallet' AND disabled = 0`)
    .all() as Array<{ external_id: string }>;
  return collectLowerAddresses(rows);
}

/**
 * Self wallets always stay monitored in pili.
 * Prefer wallets.is_self=1; fall back to sources label='self' when wallets is absent.
 */
function readSelfWalletLowers(db: NewoneSqlite): Set<string> {
  if (tableExists(db, 'wallets')) {
    try {
      const rows = db
        .prepare(`SELECT DISTINCT address FROM wallets WHERE is_self = 1`)
        .all() as Array<{ address: string }>;
      const fromWallets = collectLowerAddresses(rows);
      if (fromWallets.size > 0) return fromWallets;
    } catch {
      // fall through to sources label fallback
    }
  }

  if (!tableExists(db, 'sources')) {
    return new Set();
  }

  const rows = db
    .prepare(
      `SELECT external_id FROM sources
       WHERE kind = 'wallet' AND lower(coalesce(label, '')) = 'self'`
    )
    .all() as Array<{ external_id: string }>;
  return collectLowerAddresses(rows);
}

function emptyResult(
  newonePath: string,
  error: string
): FeishuEnablementSyncResult {
  return {
    ok: false,
    newonePath,
    enabledAddressCount: 0,
    selfAddressCount: 0,
    selfForcedEnabled: 0,
    addressesEnabled: 0,
    addressesDisabled: 0,
    usersEnabled: 0,
    usersDisabled: 0,
    error,
  };
}

/**
 * Apply enablement from newone → pili.
 * - address.monitoring_enabled = 1 iff lower(address) ∈ enabled ∪ self
 * - user.monitoring_enabled = 1 iff any of their addresses is enabled
 *
 * When newone has zero enabled wallets, refuse to mass-disable (safety).
 * Self wallets remain forced on even if their sources row is disabled.
 */
export function syncFeishuEnablementFromNewone(opts?: {
  newonePath?: string;
}): FeishuEnablementSyncResult {
  const newonePath = opts?.newonePath || resolveNewoneDbPath();
  try {
    if (!existsSync(newonePath)) {
      return emptyResult(newonePath, `newone db not found: ${newonePath}`);
    }

    const newone = openNewoneReadonly(newonePath);
    let enabled: Set<string>;
    let selfWallets: Set<string>;
    try {
      enabled = readEnabledWalletLowers(newone);
      selfWallets = readSelfWalletLowers(newone);
    } finally {
      newone.close();
    }

    if (enabled.size === 0) {
      return emptyResult(
        newonePath,
        'newone returned 0 enabled wallets — refusing to mass-disable pili'
      );
    }

    const db = getDb();
    const now = Date.now();

    const addrRows = db
      .prepare(`SELECT id, address_lower, monitoring_enabled FROM tracked_addresses`)
      .all() as Array<{ id: string; address_lower: string; monitoring_enabled: number | null }>;

    const setAddr = db.prepare(
      `UPDATE tracked_addresses SET monitoring_enabled = ?, updated_at = ? WHERE id = ?`
    );

    let addressesEnabled = 0;
    let addressesDisabled = 0;
    let selfForcedEnabled = 0;
    for (const row of addrRows) {
      const lower = String(row.address_lower || '').toLowerCase();
      const isSelf = selfWallets.has(lower);
      const want = enabled.has(lower) || isSelf ? 1 : 0;
      const cur = row.monitoring_enabled == null ? 1 : row.monitoring_enabled ? 1 : 0;
      if (isSelf && want === 1 && !enabled.has(lower)) {
        selfForcedEnabled += 1;
      }
      if (cur !== want) {
        setAddr.run(want, now, row.id);
        if (want) addressesEnabled += 1;
        else addressesDisabled += 1;
      }
    }

    const userRows = db
      .prepare(
        `SELECT u.id AS id,
                u.monitoring_enabled AS monitoring_enabled,
                COALESCE((
                  SELECT MAX(a.monitoring_enabled)
                  FROM tracked_addresses a
                  WHERE a.user_id = u.id
                ), 0) AS any_enabled
         FROM tracked_users u`
      )
      .all() as Array<{ id: string; monitoring_enabled: number | null; any_enabled: number }>;

    const setUser = db.prepare(
      `UPDATE tracked_users SET monitoring_enabled = ?, updated_at = ? WHERE id = ?`
    );
    let usersEnabled = 0;
    let usersDisabled = 0;
    for (const row of userRows) {
      const want = row.any_enabled ? 1 : 0;
      const cur = row.monitoring_enabled == null ? 1 : row.monitoring_enabled ? 1 : 0;
      if (cur !== want) {
        setUser.run(want, now, row.id);
        if (want) usersEnabled += 1;
        else usersDisabled += 1;
      }
    }

    db.prepare(
      `INSERT INTO app_state (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).run(
      'feishu_enablement_sync_v1',
      JSON.stringify({
        at: now,
        newonePath,
        enabledAddressCount: enabled.size,
        selfAddressCount: selfWallets.size,
        selfForcedEnabled,
        addressesEnabled,
        addressesDisabled,
        usersEnabled,
        usersDisabled,
      }),
      now
    );

    return {
      ok: true,
      newonePath,
      enabledAddressCount: enabled.size,
      selfAddressCount: selfWallets.size,
      selfForcedEnabled,
      addressesEnabled,
      addressesDisabled,
      usersEnabled,
      usersDisabled,
    };
  } catch (error) {
    return emptyResult(
      newonePath,
      error instanceof Error ? error.message : String(error)
    );
  }
}
