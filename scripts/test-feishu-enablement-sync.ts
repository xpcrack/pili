import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

const require = createRequire(import.meta.url);

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
    INSERT INTO sources (kind, external_id, label, disabled) VALUES
      ('wallet', '0xAAA', 'A', 0),
      ('wallet', 'SoLWalletOne', 'B', 0),
      ('wallet', '0xBBB', 'C', 1);
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

    const result = syncFeishuEnablementFromNewone({ newonePath });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.enabledAddressCount, 2);

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

    assert.equal(listTrackedUsers().length, 2);
    const monitored = listMonitoredUsers();
    assert.ok(monitored.some((u) => u.id === 'u1'));
    assert.ok(monitored.some((u) => u.id === 'u2'));
    const u1 = monitored.find((u) => u.id === 'u1')!;
    const u2 = monitored.find((u) => u.id === 'u2')!;
    const u1Lowers = new Set(u1.addresses.map((a) => a.address.toLowerCase()));
    const u2Lowers = new Set(u2.addresses.map((a) => a.address.toLowerCase()));
    assert.ok(u1Lowers.has('0xaaa'));
    assert.ok(!u1Lowers.has('0xbbb'));
    assert.ok(u2Lowers.has('solwalletone'));
    assert.ok(!u2Lowers.has('onlyinpili'));
    assert.ok(u1.addresses.length >= 1);
    assert.ok(u2.addresses.length >= 1);

    const emptyPath = path.join(tempDir, 'empty.sqlite');
    const empty = new BetterSqlite3(emptyPath);
    empty.exec(`CREATE TABLE sources (kind TEXT, external_id TEXT, disabled INTEGER);`);
    empty.close();
    assert.equal(syncFeishuEnablementFromNewone({ newonePath: emptyPath }).ok, false);

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
