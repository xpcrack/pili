import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-tg-match-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'pili.sqlite');

  try {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { getDb } = await import(`../lib/server/sqlite.ts?m=${stamp}`);
    const { findTrackedUserMatch } = await import(
      `../lib/server/telegramMonitorIngest.ts?m=${stamp}`
    );

    const db = getDb();
    const now = Date.now();
    const enabledSol = '96LGovXvNaGGX4ZjE7axTixHba6sX1UeYPGTmRQAbs2r';
    const disabledSol = 'BoK5jgG5PxB7Wo4gg2ND355zhZS4WvSDU239q5ieytBr';

    db.prepare(
      `INSERT INTO tracked_users (id, name, handle, avatar, tags_json, total_asset_usd, historical_max_asset_usd, created_at, updated_at, monitoring_enabled)
       VALUES (?, ?, ?, '', '[]', 0, 0, ?, ?, 1)`
    ).run('u-tendy', 'Tendy', 'tendy', now, now);

    db.prepare(
      `INSERT INTO tracked_addresses (id, user_id, address, address_lower, name, chain, created_at, updated_at, monitoring_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(
      'a-en',
      'u-tendy',
      enabledSol,
      enabledSol.toLowerCase(),
      'Tendy#5',
      'solana',
      now,
      now
    );
    db.prepare(
      `INSERT INTO tracked_addresses (id, user_id, address, address_lower, name, chain, created_at, updated_at, monitoring_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      'a-dis',
      'u-tendy',
      disabledSol,
      disabledSol.toLowerCase(),
      '#5',
      'solana',
      now,
      now
    );

    const hit = findTrackedUserMatch({
      chain: 'solana',
      walletAliasLabel: 'WrongAlias',
      walletLabel: 'WrongAlias',
      trackedWalletAddress: enabledSol,
    });
    assert.ok(hit, 'enabled address matches even with wrong alias');
    assert.equal(hit!.user.name, 'Tendy');
    assert.equal(hit!.address.address.toLowerCase(), enabledSol.toLowerCase());

    const disabledHit = findTrackedUserMatch({
      chain: 'solana',
      walletAliasLabel: 'Tendy',
      walletLabel: 'Tendy',
      trackedWalletAddress: disabledSol,
    });
    assert.equal(disabledHit, null, 'disabled address must not match via person alias');

    const aliasOnly = findTrackedUserMatch({
      chain: 'solana',
      walletAliasLabel: 'Tendy',
      walletLabel: 'Tendy',
      trackedWalletAddress: null,
    });
    assert.equal(aliasOnly, null, 'alias-only push must not match');

    const emptyAddr = findTrackedUserMatch({
      chain: 'solana',
      walletAliasLabel: 'Tendy',
      walletLabel: 'Tendy',
      trackedWalletAddress: '',
    });
    assert.equal(emptyAddr, null, 'empty address must not match');

    console.log('OK telegram-monitor-match');
  } finally {
    if (previousDbPath === undefined) delete process.env.PILIPILI_DB_PATH;
    else process.env.PILIPILI_DB_PATH = previousDbPath;
    if (previousDataDir === undefined) delete process.env.PILIPILI_DATA_DIR;
    else process.env.PILIPILI_DATA_DIR = previousDataDir;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
