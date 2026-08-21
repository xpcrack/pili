import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadRuntimeEnv } from '@/server/env';

function run() {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'pili-runtime-env-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const worktreeRoot = path.join(repoRoot, '.worktrees', 'codex-test-env');
  const envKey = 'PILI_RUNTIME_ENV_FALLBACK_TEST';
  const originalValue = process.env[envKey];

  const publicFeedSource = readFileSync(path.join(process.cwd(), 'server/public-feed-server.ts'), 'utf8');
  const envLoadPosition = publicFeedSource.indexOf('loadRuntimeEnv(repoRoot)');
  const portReadPosition = publicFeedSource.indexOf('process.env.PUBLIC_FEED_PORT');
  assert.ok(envLoadPosition >= 0 && portReadPosition >= 0 && envLoadPosition < portReadPosition,
    'public feed must load .env.local before reading PUBLIC_FEED_PORT');

  try {
    mkdirSync(worktreeRoot, { recursive: true });
    writeFileSync(path.join(repoRoot, '.env.local'), `${envKey}=loaded-from-main-repo\n`, 'utf8');
    delete process.env[envKey];

    const result = loadRuntimeEnv(worktreeRoot);

    assert.equal(result.loaded, true);
    assert.equal(result.envPath, path.join(repoRoot, '.env.local'));
    assert.equal(process.env[envKey], 'loaded-from-main-repo');
  } finally {
    if (originalValue === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = originalValue;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log('runtime env fallback tests: ok');
}

run();
