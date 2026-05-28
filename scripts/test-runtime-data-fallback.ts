import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function run() {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'pili-runtime-data-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const worktreeRoot = path.join(repoRoot, '.worktrees', 'codex-data-fallback');
  const mainDataDir = path.join(repoRoot, '.data');
  const originalCwd = process.cwd();
  const originalCustomDataDir = process.env.PILIPILI_DATA_DIR;

  try {
    mkdirSync(worktreeRoot, { recursive: true });
    mkdirSync(mainDataDir, { recursive: true });
    delete process.env.PILIPILI_DATA_DIR;
    process.chdir(worktreeRoot);

    const { resolveDataDir } = await import('@/lib/server/sqlite');

    assert.equal(resolveDataDir(), realpathSync.native(mainDataDir), 'should resolve to the main repo .data directory');
  } finally {
    if (originalCustomDataDir === undefined) {
      delete process.env.PILIPILI_DATA_DIR;
    } else {
      process.env.PILIPILI_DATA_DIR = originalCustomDataDir;
    }
    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log('runtime data fallback tests: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
