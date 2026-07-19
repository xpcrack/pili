import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  assertProdDbHeavyJobAllowed,
} from './lib/prodDbGuard';

function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-prod-db-guard-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  const previousForce = process.env.PILIPILI_ALLOW_PROD_DB_HEAVY;

  try {
    // Non-prod path always allowed
    process.env.PILIPILI_DATA_DIR = tempDir;
    delete process.env.PILIPILI_DB_PATH;
    delete process.env.PILIPILI_ALLOW_PROD_DB_HEAVY;
    const nonProd = assertProdDbHeavyJobAllowed({
      cwd: process.cwd(),
      argv: [],
      jobName: 'unit-test',
      markers: ['this-marker-should-never-match-zzzz'],
    });
    assert.equal(nonProd.ok, true);
    assert.equal(nonProd.ok && nonProd.skipped, true);

    // Force flag allows even when markers would match self-ish strings
    process.env.PILIPILI_DB_PATH = path.resolve(process.cwd(), '.data', 'web3-feed.sqlite');
    process.env.PILIPILI_ALLOW_PROD_DB_HEAVY = '1';
    const forced = assertProdDbHeavyJobAllowed({
      cwd: process.cwd(),
      argv: [],
      jobName: 'unit-test-force',
      markers: ['node'], // almost always matches something
    });
    assert.equal(forced.ok, true);
    assert.equal(forced.ok && forced.skipped, false);

    // --force-prod-db on argv
    delete process.env.PILIPILI_ALLOW_PROD_DB_HEAVY;
    const forcedArgv = assertProdDbHeavyJobAllowed({
      cwd: process.cwd(),
      argv: ['--force-prod-db'],
      jobName: 'unit-test-argv',
      markers: ['node'],
    });
    assert.equal(forcedArgv.ok, true);

    // When targeting prod path without force and with a synthetic marker that won't match
    // (guard should allow if no live pili markers found)
    const allowedQuiet = assertProdDbHeavyJobAllowed({
      cwd: process.cwd(),
      argv: [],
      jobName: 'unit-test-quiet',
      markers: ['___no_such_pili_process_marker___'],
    });
    assert.equal(allowedQuiet.ok, true);

    console.log('OK prod-db-guard');
  } finally {
    if (previousDbPath === undefined) delete process.env.PILIPILI_DB_PATH;
    else process.env.PILIPILI_DB_PATH = previousDbPath;
    if (previousDataDir === undefined) delete process.env.PILIPILI_DATA_DIR;
    else process.env.PILIPILI_DATA_DIR = previousDataDir;
    if (previousForce === undefined) delete process.env.PILIPILI_ALLOW_PROD_DB_HEAVY;
    else process.env.PILIPILI_ALLOW_PROD_DB_HEAVY = previousForce;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

run();
