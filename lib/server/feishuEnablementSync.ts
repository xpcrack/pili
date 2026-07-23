/**
 * Mirror Feishu enablement (via newone sources.disabled) into pili
 * tracked_users / tracked_addresses.monitoring_enabled.
 *
 * Also ensures roster: enabled wallets missing from pili are created
 * (or merged by person name) so monitoring can actually follow them.
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

import { expandTrackedAddresses, inferChainFromAddress } from '@/lib/addressBook';
import { getDb } from '@/lib/server/sqlite';
import {
  addTrackedAddresses,
  createTrackedUser,
  TrackedAddressOwnershipConflictError,
} from '@/lib/server/trackedUsersRepo';
import { isValidTrackedAddress } from '@/lib/trackedAddressValidation';
import { enqueueWalletActivityBackfillMany } from '@/lib/server/walletActivityBackfillQueue';
import type { AddressInfo, ChainType } from '@/types';

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
  usersCreated: number;
  addressesAdded: number;
  ownershipSkipped: number;
  skippedNoPerson: number;
  /** newly enabled / rostered addresses queued for 14d GMGN timeline backfill */
  timelineBackfillQueued?: number;
  error?: string;
};

type NewoneSqlite = {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
};

type EnabledWalletRow = {
  address: string;
  addressLower: string;
  personName: string;
  personKey: string;
  twitter: string;
  walletAlias: string;
};

type PersonGroup = {
  displayName: string;
  twitter: string;
  wallets: EnabledWalletRow[];
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

function parseMetaJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}

function walletAliasFromNote(note: string): string {
  const hashIdx = note.indexOf('#');
  if (hashIdx >= 0) {
    const after = note
      .slice(hashIdx + 1)
      .trim()
      .split(/\s+/)[0];
    if (after) return `#${after}`;
  }
  return '#1';
}

function isFormatValidAddress(address: string): boolean {
  const trimmed = address.trim();
  if (!trimmed) return false;
  return isValidTrackedAddress(trimmed, 'bsc') || isValidTrackedAddress(trimmed, 'solana');
}

function buildHandle(base: string, usedHandles: Set<string>) {
  const normalizedBase = base
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^-\p{L}\p{N}_]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const fallbackBase = normalizedBase || 'user';
  let candidate = fallbackBase;
  let index = 2;
  while (usedHandles.has(candidate)) {
    candidate = `${fallbackBase}-${index}`;
    index += 1;
  }
  usedHandles.add(candidate);
  return candidate;
}

function toAddressInfos(wallets: EnabledWalletRow[]): AddressInfo[] {
  return expandTrackedAddresses(
    wallets.map((w) => {
      const chain: ChainType = inferChainFromAddress(w.address);
      return {
        address: w.address,
        name: w.walletAlias,
        chain,
        totalAssetUsd: null,
        assetUpdatedAt: null,
      };
    })
  );
}

function columnExists(db: NewoneSqlite, table: string, column: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return rows.some((r) => String(r.name || '') === column);
}

function readEnabledWallets(db: NewoneSqlite): {
  enabledLowers: Set<string>;
  wallets: EnabledWalletRow[];
  skippedNoPerson: number;
} {
  const hasMeta = columnExists(db, 'sources', 'meta_json');
  const rows = db
    .prepare(
      hasMeta
        ? `SELECT external_id, label, meta_json FROM sources WHERE kind = 'wallet' AND disabled = 0`
        : `SELECT external_id, label FROM sources WHERE kind = 'wallet' AND disabled = 0`
    )
    .all() as Array<{ external_id: string; label: string | null; meta_json?: string | null }>;

  const enabledLowers = new Set<string>();
  const wallets: EnabledWalletRow[] = [];
  let skippedNoPerson = 0;

  for (const row of rows) {
    const address = String(row.external_id || '').trim();
    const addressLower = address.toLowerCase();
    if (!addressLower) continue;
    enabledLowers.add(addressLower);

    const meta = parseMetaJson(row.meta_json);
    const metaPerson =
      typeof meta.person_name === 'string' ? meta.person_name.trim() : '';
    const label = String(row.label || '').trim();
    const personName = metaPerson || label;
    if (!personName) {
      skippedNoPerson += 1;
      continue;
    }

    const twitter =
      typeof meta.twitter === 'string' && meta.twitter.trim()
        ? meta.twitter.trim()
        : '';
    const note = typeof meta.note === 'string' ? meta.note : '';

    wallets.push({
      address,
      addressLower,
      personName,
      personKey: personName.toLowerCase(),
      twitter,
      walletAlias: walletAliasFromNote(note),
    });
  }

  return { enabledLowers, wallets, skippedNoPerson };
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

function emptyResult(newonePath: string, error: string): FeishuEnablementSyncResult {
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
    usersCreated: 0,
    addressesAdded: 0,
    ownershipSkipped: 0,
    skippedNoPerson: 0,
    error,
  };
}

function groupEnabledWallets(wallets: EnabledWalletRow[]): Map<string, PersonGroup> {
  const groups = new Map<string, PersonGroup>();
  for (const wallet of wallets) {
    let group = groups.get(wallet.personKey);
    if (!group) {
      group = {
        displayName: wallet.personName,
        twitter: wallet.twitter,
        wallets: [],
      };
      groups.set(wallet.personKey, group);
    }
    group.wallets.push(wallet);
    if (!group.twitter && wallet.twitter) {
      group.twitter = wallet.twitter;
    }
  }
  return groups;
}

/**
 * Create missing people / attach free addresses by person name.
 * Never reassigns addresses already owned by someone else.
 */
function ensureRosterFromEnabledWallets(wallets: EnabledWalletRow[]): {
  usersCreated: number;
  addressesAdded: number;
  ownershipSkipped: number;
  /** address_lower of wallets newly attached this run */
  addressesAddedLowers: string[];
} {
  let usersCreated = 0;
  let addressesAdded = 0;
  let ownershipSkipped = 0;
  const addressesAddedLowers: string[] = [];

  const db = getDb();
  const userRows = db
    .prepare(
      `SELECT id, name, handle, created_at
       FROM tracked_users
       ORDER BY created_at ASC, id ASC`
    )
    .all() as Array<{ id: string; name: string; handle: string; created_at: number }>;

  const userIdByNameKey = new Map<string, string>();
  const usedHandles = new Set<string>();
  for (const row of userRows) {
    const key = String(row.name || '')
      .trim()
      .toLowerCase();
    if (key && !userIdByNameKey.has(key)) {
      userIdByNameKey.set(key, row.id);
    }
    const handle = String(row.handle || '')
      .trim()
      .toLowerCase();
    if (handle) usedHandles.add(handle);
  }

  const ownerByLower = new Map<string, string>();
  const addrRows = db
    .prepare(`SELECT user_id, address_lower FROM tracked_addresses`)
    .all() as Array<{ user_id: string; address_lower: string }>;
  for (const row of addrRows) {
    const lower = String(row.address_lower || '')
      .trim()
      .toLowerCase();
    if (lower && !ownerByLower.has(lower)) {
      ownerByLower.set(lower, row.user_id);
    }
  }

  const groups = groupEnabledWallets(wallets);

  for (const [personKey, group] of groups) {
    const valid = group.wallets.filter((w) => isFormatValidAddress(w.address));
    if (valid.length === 0) continue;

    const nameOwner = userIdByNameKey.get(personKey);
    const free: EnabledWalletRow[] = [];
    for (const wallet of valid) {
      const owner = ownerByLower.get(wallet.addressLower);
      if (!owner) {
        free.push(wallet);
        continue;
      }
      if (nameOwner && owner === nameOwner) {
        continue; // already on the matched person
      }
      ownershipSkipped += 1; // owned by someone else — do not steal
    }

    if (free.length === 0) continue;

    const addressInfos = toAddressInfos(free);

    if (nameOwner) {
      try {
        const updated = addTrackedAddresses(nameOwner, addressInfos);
        if (updated) {
          for (const wallet of free) {
            ownerByLower.set(wallet.addressLower, nameOwner);
            addressesAdded += 1;
            if (wallet.addressLower) addressesAddedLowers.push(wallet.addressLower);
          }
        }
      } catch (error) {
        if (error instanceof TrackedAddressOwnershipConflictError) {
          ownershipSkipped += free.length;
          continue;
        }
        throw error;
      }
      continue;
    }

    try {
      const handle = buildHandle(group.displayName, usedHandles);
      const created = createTrackedUser({
        name: group.displayName,
        handle,
        avatar: '',
        twitter: group.twitter || undefined,
        addresses: addressInfos,
        totalAssetUsd: 0,
        historicalMaxAssetUsd: 0,
        assetUpdatedAt: null,
        tags: [],
      });
      usersCreated += 1;
      userIdByNameKey.set(personKey, created.id);
      for (const wallet of free) {
        ownerByLower.set(wallet.addressLower, created.id);
        addressesAdded += 1;
        if (wallet.addressLower) addressesAddedLowers.push(wallet.addressLower);
      }
    } catch (error) {
      if (error instanceof TrackedAddressOwnershipConflictError) {
        ownershipSkipped += free.length;
        continue;
      }
      // Invalid address format etc. — skip this person group, do not abort whole sync
      ownershipSkipped += free.length;
    }
  }

  return { usersCreated, addressesAdded, ownershipSkipped, addressesAddedLowers };
}

const FEISHU_ENABLEMENT_STATE_KEY = 'feishu_enablement_sync_v1';
/** Refuse if enabled set drops by more than half AND by more than this absolute count. */
const ENABLEMENT_PLUNGE_MIN_DROP = 100;
const ENABLEMENT_PLUNGE_RATIO = 0.5;

function readLastEnabledAddressCount(): number | null {
  try {
    const db = getDb();
    const row = db
      .prepare(`SELECT value_json FROM app_state WHERE key = ? LIMIT 1`)
      .get(FEISHU_ENABLEMENT_STATE_KEY) as { value_json?: string } | undefined;
    if (!row?.value_json) return null;
    const parsed = JSON.parse(row.value_json) as { enabledAddressCount?: unknown };
    const n = Number(parsed.enabledAddressCount);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Apply enablement from newone → pili.
 * - ensure roster for enabled wallets (create / merge by person name)
 * - address.monitoring_enabled = 1 iff lower(address) ∈ enabled ∪ self
 * - user.monitoring_enabled = 1 iff any of their addresses is enabled
 *
 * When newone has zero enabled wallets, refuse to mass-disable (safety).
 * Also refuse sudden plunges vs last successful run (e.g. 363 → 1).
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
    let enabledWallets: EnabledWalletRow[];
    let skippedNoPerson = 0;
    let selfWallets: Set<string>;
    try {
      const read = readEnabledWallets(newone);
      enabled = read.enabledLowers;
      enabledWallets = read.wallets;
      skippedNoPerson = read.skippedNoPerson;
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

    const previousEnabled = readLastEnabledAddressCount();
    if (previousEnabled != null && previousEnabled > 0) {
      const drop = previousEnabled - enabled.size;
      if (
        drop > ENABLEMENT_PLUNGE_MIN_DROP &&
        enabled.size < previousEnabled * ENABLEMENT_PLUNGE_RATIO
      ) {
        return emptyResult(
          newonePath,
          `newone enabled wallets plunged ${previousEnabled} → ${enabled.size} — refusing to mass-disable pili`
        );
      }
    }

    const roster = ensureRosterFromEnabledWallets(enabledWallets);

    const db = getDb();
    const now = Date.now();

    const addrRows = db
      .prepare(`SELECT id, address, address_lower, monitoring_enabled FROM tracked_addresses`)
      .all() as Array<{
      id: string;
      address: string;
      address_lower: string;
      monitoring_enabled: number | null;
    }>;

    const setAddr = db.prepare(
      `UPDATE tracked_addresses SET monitoring_enabled = ?, updated_at = ? WHERE id = ?`
    );

    let addressesEnabled = 0;
    let addressesDisabled = 0;
    let selfForcedEnabled = 0;
    /** original address form for 14d GMGN timeline backfill */
    const timelineBackfillAddrs = new Map<string, string>(); // lower -> display address
    for (const row of addrRows) {
      const lower = String(row.address_lower || '').toLowerCase();
      const display = String(row.address || row.address_lower || '').trim();
      const isSelf = selfWallets.has(lower);
      const want = enabled.has(lower) || isSelf ? 1 : 0;
      const cur = row.monitoring_enabled == null ? 1 : row.monitoring_enabled ? 1 : 0;
      if (isSelf && want === 1 && !enabled.has(lower)) {
        selfForcedEnabled += 1;
      }
      if (cur !== want) {
        setAddr.run(want, now, row.id);
        if (want) {
          addressesEnabled += 1;
          if (lower && display) timelineBackfillAddrs.set(lower, display);
        } else addressesDisabled += 1;
      }
    }

    for (const lower of roster.addressesAddedLowers) {
      if (!lower) continue;
      if (!timelineBackfillAddrs.has(lower)) {
        // prefer original casing from enabled wallets
        const fromEnabled = enabledWallets.find((w) => w.addressLower === lower);
        timelineBackfillAddrs.set(lower, fromEnabled?.address || lower);
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

    let timelineBackfillQueued = 0;
    if (timelineBackfillAddrs.size > 0) {
      const queued = enqueueWalletActivityBackfillMany(
        [...timelineBackfillAddrs.values()].map((address) => ({
          address,
          days: 14,
          reason: 'feishu-enablement',
        }))
      );
      timelineBackfillQueued = queued.enqueued;
    }

    db.prepare(
      `INSERT INTO app_state (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).run(
      FEISHU_ENABLEMENT_STATE_KEY,
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
        usersCreated: roster.usersCreated,
        addressesAdded: roster.addressesAdded,
        ownershipSkipped: roster.ownershipSkipped,
        skippedNoPerson,
        timelineBackfillQueued,
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
      usersCreated: roster.usersCreated,
      addressesAdded: roster.addressesAdded,
      ownershipSkipped: roster.ownershipSkipped,
      skippedNoPerson,
      timelineBackfillQueued,
    };
  } catch (error) {
    return emptyResult(
      newonePath,
      error instanceof Error ? error.message : String(error)
    );
  }
}
