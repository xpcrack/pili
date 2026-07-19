/**
 * Mirror Feishu enablement (via newone sources.disabled) into pili
 * tracked_users / tracked_addresses.monitoring_enabled.
 *
 * Policy A: disabled still searchable in history; default Feed + collectors
 * only follow monitoring_enabled=1.
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
  addressesEnabled: number;
  addressesDisabled: number;
  usersEnabled: number;
  usersDisabled: number;
  error?: string;
};

function resolveNewoneDbPath() {
  const fromEnv = (process.env.NEWONE_DB_PATH || process.env.PILI_NEWONE_DB_PATH || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), '..', 'newone', 'data', 'newone.sqlite');
}

function isBunRuntime() {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

function readEnabledWalletLowers(newonePath: string): Set<string> {
  if (!existsSync(newonePath)) {
    throw new Error(`newone db not found: ${newonePath}`);
  }

  type Row = { external_id: string };
  let rows: Row[] = [];

  if (isBunRuntime()) {
    const { Database } = require('bun:sqlite') as {
      Database: new (filename: string, opts?: { readonly?: boolean }) => {
        prepare(sql: string): { all(...params: unknown[]): unknown[] };
        close(): void;
      };
    };
    const db = new Database(newonePath, { readonly: true });
    try {
      rows = db
        .prepare(`SELECT external_id FROM sources WHERE kind = 'wallet' AND disabled = 0`)
        .all() as Row[];
    } finally {
      db.close();
    }
  } else {
    const BetterSqlite3 = require('better-sqlite3') as new (
      filename: string,
      opts?: { readonly?: boolean }
    ) => {
      prepare(sql: string): { all(...params: unknown[]): unknown[] };
      close(): void;
    };
    const db = new BetterSqlite3(newonePath, { readonly: true });
    try {
      rows = db
        .prepare(`SELECT external_id FROM sources WHERE kind = 'wallet' AND disabled = 0`)
        .all() as Row[];
    } finally {
      db.close();
    }
  }

  const set = new Set<string>();
  for (const row of rows) {
    const lower = String(row.external_id || '')
      .trim()
      .toLowerCase();
    if (lower) set.add(lower);
  }
  return set;
}

/**
 * Apply enablement from newone → pili.
 * - address.monitoring_enabled = 1 iff lower(address) ∈ newone enabled wallets
 * - user.monitoring_enabled = 1 iff any of their addresses is enabled
 *
 * When newone has zero enabled wallets, refuse to mass-disable (safety).
 */
export function syncFeishuEnablementFromNewone(opts?: {
  newonePath?: string;
}): FeishuEnablementSyncResult {
  const newonePath = opts?.newonePath || resolveNewoneDbPath();
  try {
    const enabled = readEnabledWalletLowers(newonePath);
    if (enabled.size === 0) {
      return {
        ok: false,
        newonePath,
        enabledAddressCount: 0,
        addressesEnabled: 0,
        addressesDisabled: 0,
        usersEnabled: 0,
        usersDisabled: 0,
        error: 'newone returned 0 enabled wallets — refusing to mass-disable pili',
      };
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
    for (const row of addrRows) {
      const want = enabled.has(String(row.address_lower || '').toLowerCase()) ? 1 : 0;
      const cur = row.monitoring_enabled == null ? 1 : row.monitoring_enabled ? 1 : 0;
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
      addressesEnabled,
      addressesDisabled,
      usersEnabled,
      usersDisabled,
    };
  } catch (error) {
    return {
      ok: false,
      newonePath,
      enabledAddressCount: 0,
      addressesEnabled: 0,
      addressesDisabled: 0,
      usersEnabled: 0,
      usersDisabled: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
