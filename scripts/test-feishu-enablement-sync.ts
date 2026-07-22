import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

const require = createRequire(import.meta.url);

/** Valid-format fixtures for create/merge path */
const EVM_NEW = '0x1111111111111111111111111111111111111111';
const EVM_MERGE = '0x2222222222222222222222222222222222222222';
const EVM_CONFLICT = '0x3333333333333333333333333333333333333333';

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-feishu-en-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'pili.sqlite');

  const newonePath = path.join(tempDir, 'newone.sqlite');
  const BetterSqlite3 = require('better-sqlite3') as new (f: string) => {
    exec(sql: string): void;
    close(): void;
  };
  const newone = new BetterSqlite3(newonePath);
  newone.exec(`
    CREATE TABLE sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      external_id TEXT NOT NULL,
      label TEXT,
      meta_json TEXT,
      disabled INTEGER NOT NULL DEFAULT 0,
      UNIQUE (kind, external_id)
    );
    CREATE TABLE wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      chain TEXT NOT NULL,
      label TEXT,
      is_self INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO sources (kind, external_id, label, disabled) VALUES
      ('wallet', '0xAAA', 'A', 0),
      ('wallet', 'SoLWalletOne', 'B', 0),
      ('wallet', '0xBBB', 'C', 1),
      ('wallet', 'SelfWalletSol', 'self', 1);
    INSERT INTO wallets (address, chain, label, is_self) VALUES
      ('SelfWalletSol', 'solana', 'main', 1);
  `);
  newone.close();

  try {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { getDb } = await import(`../lib/server/sqlite.ts?fe=${stamp}`);
    const { syncFeishuEnablementFromNewone } = await import(
      `../lib/server/feishuEnablementSync.ts?fe=${stamp}`
    );
    const { listMonitoredUsers, listTrackedUsers } = await import(
      `../lib/server/trackedUsersRepo.ts?fe=${stamp}`
    );

    const db = getDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO tracked_users (id, name, handle, avatar, tags_json, total_asset_usd, historical_max_asset_usd, created_at, updated_at)
       VALUES (?, ?, ?, '', '[]', 0, 0, ?, ?)`
    ).run('u1', 'Alpha', 'alpha', now, now);
    db.prepare(
      `INSERT INTO tracked_users (id, name, handle, avatar, tags_json, total_asset_usd, historical_max_asset_usd, created_at, updated_at)
       VALUES (?, ?, ?, '', '[]', 0, 0, ?, ?)`
    ).run('u2', 'Beta', 'beta', now, now);
    db.prepare(
      `INSERT INTO tracked_users (id, name, handle, avatar, tags_json, total_asset_usd, historical_max_asset_usd, created_at, updated_at)
       VALUES (?, ?, ?, '', '[]', 0, 0, ?, ?)`
    ).run('u3', 'SelfPerson', 'selfperson', now, now);

    db.prepare(
      `INSERT INTO tracked_addresses (id, user_id, address, address_lower, name, chain, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('a1', 'u1', '0xAAA', '0xaaa', 'a1', 'bsc', now, now);
    db.prepare(
      `INSERT INTO tracked_addresses (id, user_id, address, address_lower, name, chain, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('a2', 'u1', '0xBBB', '0xbbb', 'a2', 'bsc', now, now);
    db.prepare(
      `INSERT INTO tracked_addresses (id, user_id, address, address_lower, name, chain, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('a3', 'u2', 'SoLWalletOne', 'solwalletone', 'a3', 'solana', now, now);
    db.prepare(
      `INSERT INTO tracked_addresses (id, user_id, address, address_lower, name, chain, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('a4', 'u2', 'OnlyInPili', 'onlyinpili', 'a4', 'solana', now, now);
    db.prepare(
      `INSERT INTO tracked_addresses (id, user_id, address, address_lower, name, chain, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('a5', 'u3', 'SelfWalletSol', 'selfwalletsol', '#1', 'solana', now, now);

    const result = syncFeishuEnablementFromNewone({ newonePath });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.enabledAddressCount, 2);
    assert.equal(result.selfAddressCount, 1);
    assert.ok(result.selfForcedEnabled >= 1);

    // EVM expansion may create base/eth/bsc rows for the same address_lower.
    const flagRows = db
      .prepare(
        `SELECT address_lower, MAX(monitoring_enabled) AS en
         FROM tracked_addresses
         GROUP BY address_lower`
      )
      .all() as Array<{ address_lower: string; en: number }>;
    const byLower = Object.fromEntries(flagRows.map((r) => [r.address_lower, r.en]));
    assert.equal(byLower['0xaaa'], 1);
    assert.equal(byLower['0xbbb'], 0);
    assert.equal(byLower.solwalletone, 1);
    assert.equal(byLower.onlyinpili, 0);
    // self wallet disabled in sources but forced on via wallets.is_self
    assert.equal(byLower.selfwalletsol, 1);

    assert.equal(listTrackedUsers().length, 3);
    const monitored = listMonitoredUsers();
    assert.ok(monitored.some((u) => u.id === 'u1'));
    assert.ok(monitored.some((u) => u.id === 'u2'));
    assert.ok(monitored.some((u) => u.id === 'u3'), 'self person must be monitored');
    const u1 = monitored.find((u) => u.id === 'u1')!;
    const u2 = monitored.find((u) => u.id === 'u2')!;
    const u3 = monitored.find((u) => u.id === 'u3')!;
    const u1Lowers = new Set(u1.addresses.map((a) => a.address.toLowerCase()));
    const u2Lowers = new Set(u2.addresses.map((a) => a.address.toLowerCase()));
    const u3Lowers = new Set(u3.addresses.map((a) => a.address.toLowerCase()));
    assert.ok(u1Lowers.has('0xaaa'));
    assert.ok(!u1Lowers.has('0xbbb'));
    assert.ok(u2Lowers.has('solwalletone'));
    assert.ok(!u2Lowers.has('onlyinpili'));
    assert.ok(u3Lowers.has('selfwalletsol'));
    assert.ok(u1.addresses.length >= 1);
    assert.ok(u2.addresses.length >= 1);

    const emptyPath = path.join(tempDir, 'empty.sqlite');
    const empty = new BetterSqlite3(emptyPath);
    empty.exec(`CREATE TABLE sources (kind TEXT, external_id TEXT, disabled INTEGER);`);
    empty.close();
    assert.equal(syncFeishuEnablementFromNewone({ newonePath: emptyPath }).ok, false);

    // label=self fallback when wallets table is missing
    const labelOnlyPath = path.join(tempDir, 'label-self.sqlite');
    const labelOnly = new BetterSqlite3(labelOnlyPath);
    labelOnly.exec(`
      CREATE TABLE sources (
        kind TEXT NOT NULL,
        external_id TEXT NOT NULL,
        label TEXT,
        disabled INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO sources (kind, external_id, label, disabled) VALUES
        ('wallet', '0xAAA', 'A', 0),
        ('wallet', 'LabelSelfOnly', 'self', 1);
    `);
    labelOnly.close();

    db.prepare(
      `INSERT INTO tracked_addresses (id, user_id, address, address_lower, name, chain, created_at, updated_at, monitoring_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run('a6', 'u3', 'LabelSelfOnly', 'labelselfonly', '#2', 'solana', now, now);

    const labelResult = syncFeishuEnablementFromNewone({ newonePath: labelOnlyPath });
    assert.equal(labelResult.ok, true, labelResult.error);
    const labelEn = db
      .prepare(
        `SELECT monitoring_enabled AS en FROM tracked_addresses WHERE address_lower = 'labelselfonly'`
      )
      .get() as { en: number };
    assert.equal(labelEn.en, 1, 'sources label=self must force enable without wallets table');

    // --- auto-create / merge / ownership ---
    const rosterPath = path.join(tempDir, 'roster.sqlite');
    const rosterDb = new BetterSqlite3(rosterPath);
    const metaNew = JSON.stringify({
      person_name: 'Gamma',
      twitter: 'gamma_x',
      note: 'Gamma#main',
    });
    const metaMerge = JSON.stringify({
      person_name: 'Alpha',
      note: 'Alpha#2',
    });
    const metaConflict = JSON.stringify({
      person_name: 'Delta',
      note: 'Delta#1',
    });
    const metaDisable = JSON.stringify({
      person_name: 'Gamma',
      note: 'Gamma#main',
    });
    rosterDb.exec(`
      CREATE TABLE sources (
        kind TEXT NOT NULL,
        external_id TEXT NOT NULL,
        label TEXT,
        meta_json TEXT,
        disabled INTEGER NOT NULL DEFAULT 0,
        UNIQUE (kind, external_id)
      );
      CREATE TABLE wallets (
        address TEXT NOT NULL,
        chain TEXT NOT NULL,
        is_self INTEGER NOT NULL DEFAULT 0
      );
    `);
    rosterDb
      .prepare(
        `INSERT INTO sources (kind, external_id, label, meta_json, disabled) VALUES
         ('wallet', ?, 'Gamma', ?, 0),
         ('wallet', ?, 'Alpha', ?, 0),
         ('wallet', ?, 'Delta', ?, 0),
         ('wallet', '0xAAA', 'A', NULL, 0),
         ('wallet', 'SoLWalletOne', 'B', NULL, 0)`
      )
      .run(EVM_NEW, metaNew, EVM_MERGE, metaMerge, EVM_CONFLICT, metaConflict);
    // Keep at least one enabled so we don't hit mass-disable safety
    rosterDb.close();

    // Conflict seed: EVM_CONFLICT already owned by Beta (not Delta)
    db.prepare(
      `INSERT INTO tracked_addresses (id, user_id, address, address_lower, name, chain, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'a7',
      'u2',
      EVM_CONFLICT,
      EVM_CONFLICT.toLowerCase(),
      'taken',
      'bsc',
      now,
      now
    );

    const beforeUsers = listTrackedUsers().length;
    const rosterResult = syncFeishuEnablementFromNewone({ newonePath: rosterPath });
    assert.equal(rosterResult.ok, true, rosterResult.error);
    assert.ok(rosterResult.usersCreated >= 1, 'should create Gamma');
    assert.ok(rosterResult.addressesAdded >= 2, 'Gamma new + Alpha merge');
    assert.ok(rosterResult.ownershipSkipped >= 1, 'Delta conflict skipped');

    const afterUsers = listTrackedUsers();
    assert.ok(afterUsers.length > beforeUsers, 'new person added');
    const gamma = afterUsers.find((u) => u.name === 'Gamma');
    assert.ok(gamma, 'Gamma user exists');
    assert.ok(
      gamma!.addresses.some((a) => a.address.toLowerCase() === EVM_NEW.toLowerCase()),
      'Gamma has new wallet'
    );
    assert.equal(gamma!.twitter, 'gamma_x');

    const alpha = afterUsers.find((u) => u.id === 'u1');
    assert.ok(alpha);
    assert.ok(
      alpha!.addresses.some((a) => a.address.toLowerCase() === EVM_MERGE.toLowerCase()),
      'Alpha received merged wallet'
    );

    const delta = afterUsers.find((u) => u.name === 'Delta');
    assert.equal(delta, undefined, 'must not create Delta when address owned by other');

    const conflictOwner = db
      .prepare(
        `SELECT user_id FROM tracked_addresses WHERE address_lower = ? LIMIT 1`
      )
      .get(EVM_CONFLICT.toLowerCase()) as { user_id: string };
    assert.equal(conflictOwner.user_id, 'u2', 'conflict address stays on Beta');

    const mon = listMonitoredUsers();
    assert.ok(mon.some((u) => u.name === 'Gamma'));

    // Disable Gamma wallet → flag off, person remains
    const disablePath = path.join(tempDir, 'disable.sqlite');
    const disableDb = new BetterSqlite3(disablePath);
    disableDb.exec(`
      CREATE TABLE sources (
        kind TEXT NOT NULL,
        external_id TEXT NOT NULL,
        label TEXT,
        meta_json TEXT,
        disabled INTEGER NOT NULL DEFAULT 0
      );
    `);
    disableDb
      .prepare(
        `INSERT INTO sources (kind, external_id, label, meta_json, disabled) VALUES
         ('wallet', ?, 'Gamma', ?, 1),
         ('wallet', '0xAAA', 'A', NULL, 0),
         ('wallet', ?, 'Alpha', ?, 0)`
      )
      .run(EVM_NEW, metaDisable, EVM_MERGE, metaMerge);
    disableDb.close();

    const disableResult = syncFeishuEnablementFromNewone({ newonePath: disablePath });
    assert.equal(disableResult.ok, true, disableResult.error);
    assert.ok(listTrackedUsers().some((u) => u.name === 'Gamma'), 'Gamma not deleted');
    const gammaEn = db
      .prepare(
        `SELECT MAX(monitoring_enabled) AS en FROM tracked_addresses WHERE address_lower = ?`
      )
      .get(EVM_NEW.toLowerCase()) as { en: number };
    assert.equal(gammaEn.en, 0, 'Gamma wallet monitoring off after disable');

    // Plunge protection: last success had many enabled, newone suddenly almost empty
    db.prepare(
      `INSERT INTO app_state (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).run(
      'feishu_enablement_sync_v1',
      JSON.stringify({ enabledAddressCount: 300, at: Date.now() }),
      Date.now()
    );
    const monBeforePlunge = db
      .prepare(
        `SELECT count(*) AS c FROM tracked_addresses WHERE COALESCE(monitoring_enabled, 1) = 1`
      )
      .get() as { c: number };
    const plungeResult = syncFeishuEnablementFromNewone({ newonePath: disablePath });
    assert.equal(plungeResult.ok, false, 'must refuse enablement plunge');
    assert.match(String(plungeResult.error || ''), /plunged/i);
    const monAfterPlunge = db
      .prepare(
        `SELECT count(*) AS c FROM tracked_addresses WHERE COALESCE(monitoring_enabled, 1) = 1`
      )
      .get() as { c: number };
    assert.equal(monAfterPlunge.c, monBeforePlunge.c, 'flags unchanged on plunge refuse');

    console.log('OK feishu-enablement-sync');
  } finally {
    if (previousDbPath === undefined) delete process.env.PILIPILI_DB_PATH;
    else process.env.PILIPILI_DB_PATH = previousDbPath;
    if (previousDataDir === undefined) delete process.env.PILIPILI_DATA_DIR;
    else process.env.PILIPILI_DATA_DIR = previousDataDir;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
